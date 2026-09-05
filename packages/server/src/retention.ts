import { prisma } from "@memoturn/db";
import { deleteBlobPrefixOlderThan } from "@memoturn/db/blob";
import { telemetry } from "@memoturn/telemetry";
import { envInt } from "./env.js";
import { pruneProjectState } from "./mutablestate.js";

/**
 * Data retention — delete telemetry older than a per-project cutoff via the telemetry
 * store. days=0 means keep forever.
 *
 * `TELEMETRY_MAX_RETENTION_DAYS` is an instance-wide ceiling: every project — including
 * those with no policy — is swept at min(policy, ceiling). Operators use it to bound
 * storage growth and to make the partitioned Doris tables' native TTL and this sweep agree.
 */
export function maxRetentionDays(): number {
  return envInt("TELEMETRY_MAX_RETENTION_DAYS", 0);
}

/** The effective window for a project: its policy capped by the instance ceiling (0 = none). */
export function effectiveRetentionDays(policyDays: number): number {
  const cap = maxRetentionDays();
  if (cap <= 0) return policyDays;
  return policyDays > 0 ? Math.min(policyDays, cap) : cap;
}
export async function getRetention(projectId: string) {
  const p = await prisma.retentionPolicy.findUnique({ where: { projectId } });
  return { days: p?.days ?? 0 };
}

export async function setRetention(projectId: string, days: number) {
  const p = await prisma.retentionPolicy.upsert({
    where: { projectId },
    update: { days },
    create: { projectId, days },
  });
  return { days: p.days };
}

export interface RetentionResult {
  projectId: string;
  days: number;
  deletedTraces: number;
  deletedBlobObjects: number;
  deletedStateRows: number;
}

/** The blob key prefixes a project's telemetry occupies, all swept at the retention cutoff. */
const blobPrefixes = (projectId: string) => [
  `events/${projectId}/`, // raw ingest event log (source of truth, written pre-masking)
  `payloads/${projectId}/`, // offloaded large input/output payloads
  `media/${projectId}/`, // offloaded multimodal media
];

/** Apply retention for one project: delete telemetry rows AND the project's aged blob objects. */
export async function applyRetention(projectId: string, days: number): Promise<RetentionResult> {
  if (days <= 0) return { projectId, days, deletedTraces: 0, deletedBlobObjects: 0, deletedStateRows: 0 };
  const store = telemetry();
  const before = await store.countTracesOlderThan(projectId, days);
  await store.deleteOlderThan(projectId, days);

  // Reach the blob store with the SAME cutoff — otherwise retention only trims the query store
  // while the raw log (unmasked) and offloaded payloads live on forever.
  const cutoff = new Date(Date.now() - days * 86_400_000);
  let deletedBlobObjects = 0;
  for (const prefix of blobPrefixes(projectId)) {
    deletedBlobObjects += await deleteBlobPrefixOlderThan(prefix, cutoff);
  }
  // …and the Postgres state mirror, which holds full input/output copies (ADR-0001) and was
  // previously governed only by the global STATE_RETENTION_HOURS working-set prune.
  const state = await pruneProjectState(projectId, cutoff);
  const deletedStateRows = state.traces + state.observations + state.scores;
  return { projectId, days, deletedTraces: before, deletedBlobObjects, deletedStateRows };
}

/** Apply retention across every project with a policy, plus every project under the instance ceiling. */
export async function applyAllRetention(): Promise<RetentionResult[]> {
  const policies = await prisma.retentionPolicy.findMany({ where: { days: { gt: 0 } } });
  const windows = new Map<string, number>(policies.map((p) => [p.projectId, effectiveRetentionDays(p.days)]));
  if (maxRetentionDays() > 0) {
    const all = await prisma.project.findMany({ select: { id: true } });
    for (const { id } of all) if (!windows.has(id)) windows.set(id, effectiveRetentionDays(0));
  }
  const results: RetentionResult[] = [];
  for (const [projectId, days] of windows) {
    try {
      results.push(await applyRetention(projectId, days));
    } catch (err) {
      // Log (don't silently swallow) so a project stuck failing retention is visible.
      console.error(`[retention] project ${projectId} failed:`, err instanceof Error ? err.message : err);
    }
  }
  return results;
}
