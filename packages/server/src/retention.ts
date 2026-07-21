import { prisma } from "@memoturn/db";
import { deleteBlobPrefixOlderThan } from "@memoturn/db/blob";
import { telemetry } from "@memoturn/telemetry";

/**
 * Data retention — delete telemetry older than a per-project cutoff via the telemetry
 * store. days=0 means keep forever.
 */
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
}

/** The blob key prefixes a project's telemetry occupies, all swept at the retention cutoff. */
const blobPrefixes = (projectId: string) => [
  `events/${projectId}/`, // raw ingest event log (source of truth, written pre-masking)
  `payloads/${projectId}/`, // offloaded large input/output payloads
  `media/${projectId}/`, // offloaded multimodal media
];

/** Apply retention for one project: delete telemetry rows AND the project's aged blob objects. */
export async function applyRetention(projectId: string, days: number): Promise<RetentionResult> {
  if (days <= 0) return { projectId, days, deletedTraces: 0, deletedBlobObjects: 0 };
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
  return { projectId, days, deletedTraces: before, deletedBlobObjects };
}

/** Apply retention across every project that has a policy (worker cron). */
export async function applyAllRetention(): Promise<RetentionResult[]> {
  const policies = await prisma.retentionPolicy.findMany({ where: { days: { gt: 0 } } });
  const results: RetentionResult[] = [];
  for (const p of policies) {
    try {
      results.push(await applyRetention(p.projectId, p.days));
    } catch (err) {
      // Log (don't silently swallow) so a project stuck failing retention is visible.
      console.error(`[retention] project ${p.projectId} failed:`, err instanceof Error ? err.message : err);
    }
  }
  return results;
}
