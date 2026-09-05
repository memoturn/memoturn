import { prisma } from "@memoturn/db";
import { deleteBlobObject, deleteBlobPrefixOlderThan } from "@memoturn/db/blob";
import { telemetry } from "@memoturn/telemetry";
import { deleteStatesForTraces } from "./mutablestate.js";
import { PAYLOAD_REF_PREFIX } from "./payloads.js";

/**
 * Data-lifecycle primitives shared by project deletion, organization deletion, the demo
 * sandbox pruner, batch trace deletion, and the right-to-erasure endpoints. Every "delete"
 * in the product routes through here so that all three places a project's data lives —
 * the telemetry store, the Postgres mutable-state mirror (ADR-0001), and blob storage
 * (raw event log, offloaded payloads, media) — are cleaned together. Deleting rows in
 * one store and leaving the raw unmasked event log behind is not a deletion.
 */

const BLOB_PREFIXES = ["events", "payloads", "media"] as const;

export interface PurgeResult {
  telemetry: boolean;
  blobObjects: number;
  blobErrors: string[];
}

/**
 * Remove EVERYTHING a project holds outside its Postgres rows: telemetry rows in the
 * store and every blob object under its prefixes. Best-effort per stage — a failure is
 * reported, never thrown, so the caller's Postgres deletion still proceeds and the
 * orphaned remainder is visible in the result/log rather than silently left behind.
 */
export async function purgeProjectData(projectId: string): Promise<PurgeResult> {
  const result: PurgeResult = { telemetry: false, blobObjects: 0, blobErrors: [] };
  try {
    await telemetry().deleteProjectData(projectId);
    result.telemetry = true;
  } catch (e) {
    console.error(JSON.stringify({ msg: "project purge: telemetry delete failed", projectId, error: String(e) }));
  }
  // A cutoff in the future means "every object under this prefix".
  const everything = new Date(Date.now() + 86_400_000);
  for (const prefix of BLOB_PREFIXES) {
    try {
      result.blobObjects += await deleteBlobPrefixOlderThan(`${prefix}/${projectId}/`, everything);
    } catch (e) {
      result.blobErrors.push(`${prefix}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (result.blobErrors.length) {
    console.error(JSON.stringify({ msg: "project purge: blob delete failed", projectId, errors: result.blobErrors }));
  }
  return result;
}

/** Offload markers reference `memoturn-blob://payloads/<project>/…`; pull the keys out of a serialized field. */
export function offloadedPayloadKeys(projectId: string, serialized: string | null | undefined): string[] {
  if (!serialized?.includes(PAYLOAD_REF_PREFIX)) return [];
  const keys: string[] = [];
  const re = new RegExp(
    `${PAYLOAD_REF_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(payloads/${projectId}/[A-Za-z0-9/_.-]+)`,
    "g",
  );
  for (const m of serialized.matchAll(re)) keys.push(m[1] as string);
  return keys;
}

/**
 * Delete specific traces completely: telemetry rows (all tables), the Postgres
 * `*State` mirror rows (which hold full input/output), and the offloaded payload
 * objects their fields reference. The raw event batch is NOT touched — batches are
 * multi-trace and are governed by retention; that is why a replayed batch can resurrect
 * a deleted trace, and why erasure requests should be followed by a retention cutoff.
 */
export async function deleteTraceData(
  projectId: string,
  traceIds: string[],
): Promise<{ traces: number; payloadObjects: number }> {
  const ids = [...new Set(traceIds.filter(Boolean))];
  if (ids.length === 0) return { traces: 0, payloadObjects: 0 };
  const store = telemetry();

  // Collect offload references BEFORE the rows go away.
  const keys = new Set<string>();
  for (const t of await store.getTraceIO(projectId, ids)) {
    for (const k of offloadedPayloadKeys(projectId, t.input)) keys.add(k);
    for (const k of offloadedPayloadKeys(projectId, t.output)) keys.add(k);
  }
  for (const id of ids) {
    for (const o of await store.listObservationsByTrace(projectId, id)) {
      const io = o as { input?: string | null; output?: string | null };
      for (const k of offloadedPayloadKeys(projectId, io.input)) keys.add(k);
      for (const k of offloadedPayloadKeys(projectId, io.output)) keys.add(k);
    }
  }

  await store.deleteTraces(projectId, ids);
  await deleteStatesForTraces(projectId, ids);
  let payloadObjects = 0;
  for (const key of keys) {
    try {
      await deleteBlobObject(key);
      payloadObjects++;
    } catch {
      // best-effort; retention sweeps the prefix eventually
    }
  }
  return { traces: ids.length, payloadObjects };
}

/**
 * Right to erasure for an end user of the traced application: every trace the project
 * recorded under that `userId`, with the same completeness as deleteTraceData.
 */
export async function deleteUserData(projectId: string, userId: string): Promise<{ traces: number }> {
  if (!userId) return { traces: 0 };
  const store = telemetry();
  let traces = 0;
  // Page through the user's traces so the per-call work stays bounded.
  for (;;) {
    const page = await store.listTraces(projectId, { userId, limit: 200 });
    const ids = page.map((t) => t.id);
    if (ids.length === 0) break;
    const r = await deleteTraceData(projectId, ids);
    traces += r.traces;
    if (ids.length < 200) break;
  }
  // Anything the list filter didn't surface (e.g. traces whose user_id only lives in the
  // store) — the store-level sweep is authoritative and idempotent.
  traces += await store.deleteByUserId(projectId, userId);
  await prisma.traceState.deleteMany({ where: { projectId, userId } });
  return { traces };
}
