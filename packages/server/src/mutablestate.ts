import type { TraceBody } from "@memoturn/core";
import { prisma } from "@memoturn/db";

/**
 * Mutable entity state — ADR-0001, Phase 1 (traces slice).
 *
 * Ingest events merge into Postgres `TraceState` field-by-field: only fields an event
 * actually carries overwrite; everything else keeps its stored value. The merge is an
 * atomic `INSERT … ON CONFLICT DO UPDATE SET col = COALESCE(EXCLUDED.col, stored.col)`,
 * so concurrent batches patching the same trace can't lose each other's fields (Postgres
 * serializes the conflicting upsert) and retries are idempotent — the correctness Doris's
 * single row-level sequence column can't provide. Doris becomes the analytical mirror in
 * Phase 2; this phase runs additively behind MUTABLE_STATE_STORE to validate the merge.
 *
 * "Provided by the event" is decided from the RAW wire body (the keys the client actually
 * sent), NOT the zod-parsed body — zod fills defaults (e.g. `environment: "default"`), which
 * would otherwise make every update clobber that field. Values come from the parsed/masked
 * body so stored state matches what the pipeline persists.
 */

const jsonStr = (v: unknown): string => (typeof v === "string" ? v : JSON.stringify(v));

export interface TracePatch {
  id: string;
  name?: string;
  timestamp?: Date;
  userId?: string;
  sessionId?: string;
  release?: string;
  version?: string;
  environment?: string;
  public?: boolean;
  tags?: string[];
  metadata?: string;
  input?: string;
  output?: string;
}

/**
 * Build a sparse trace patch: one entry per field the client actually sent (present as a key
 * in `rawBody`), taking the value from `maskedBody` (post-masking/offload). `id` is always set.
 */
export function extractTracePatch(rawBody: Record<string, unknown>, maskedBody: TraceBody): TracePatch {
  const has = (k: string) => Object.hasOwn(rawBody, k);
  const p: TracePatch = { id: maskedBody.id };
  if (has("name")) p.name = maskedBody.name ?? "";
  if (has("timestamp") && maskedBody.timestamp) p.timestamp = new Date(maskedBody.timestamp);
  if (has("userId")) p.userId = maskedBody.userId ?? "";
  if (has("sessionId")) p.sessionId = maskedBody.sessionId ?? "";
  if (has("release")) p.release = maskedBody.release ?? "";
  if (has("version")) p.version = maskedBody.version ?? "";
  if (has("environment")) p.environment = maskedBody.environment;
  if (has("public")) p.public = maskedBody.public ?? false;
  if (has("tags")) p.tags = maskedBody.tags ?? [];
  if (has("metadata")) p.metadata = jsonStr(maskedBody.metadata);
  if (has("input")) p.input = jsonStr(maskedBody.input);
  if (has("output")) p.output = jsonStr(maskedBody.output);
  return p;
}

// Column + Postgres type for each mergeable field. `tags` is handled separately (a non-null
// array can't ride the COALESCE-of-NULL trick). Explicit casts are required so a NULL bind
// param (an unprovided field) has a known type — otherwise Postgres can't infer it in COALESCE.
const MERGE_COLS: readonly (readonly [string, string])[] = [
  ["name", "text"],
  ["timestamp", "timestamp"],
  ["userId", "text"],
  ["sessionId", "text"],
  ["release", "text"],
  ["version", "text"],
  ["environment", "text"],
  ["public", "boolean"],
  ["metadata", "text"],
  ["input", "text"],
  ["output", "text"],
];

/** Monotonic per-row version from the event timestamp (retry-stable; GREATEST keeps it rising). */
function versionOf(p: TracePatch): bigint {
  return BigInt(p.timestamp ? p.timestamp.getTime() : 0);
}

/**
 * Merge a batch of trace patches into `TraceState` for one project. Each patch is one atomic
 * field-level upsert. Returns the number of patches applied.
 */
export async function mergeTraceStates(projectId: string, patches: TracePatch[]): Promise<number> {
  for (const p of patches) {
    const rec = p as unknown as Record<string, unknown>;
    const values: unknown[] = MERGE_COLS.map(([c]) => rec[c] ?? null);
    const tagsProvided = p.tags !== undefined;
    const tags = p.tags ?? [];
    const version = versionOf(p);

    // Positional params: $1 projectId, $2 id, $3.. merge cols, then tagsProvided, tags, version.
    const base = 2;
    const cast = (i: number) => `$${base + i + 1}::${MERGE_COLS[i]![1]}`;
    const colAssign = MERGE_COLS.map(([c], i) => `"${c}" = COALESCE(${cast(i)}, "TraceState"."${c}")`).join(", ");
    const tagsIdx = base + MERGE_COLS.length + 1; // tagsProvided
    const versionIdx = tagsIdx + 2;
    const insertCols = MERGE_COLS.map(([c]) => `"${c}"`).join(", ");
    const insertVals = MERGE_COLS.map((_, i) => cast(i)).join(", ");

    const sql = `
      INSERT INTO "TraceState" ("projectId", "id", ${insertCols}, "tags", "stateVersion", "updatedAt")
      VALUES ($1, $2, ${insertVals}, $${tagsIdx + 1}::text[], $${versionIdx}::bigint, now())
      ON CONFLICT ("projectId", "id") DO UPDATE SET
        ${colAssign},
        "tags" = CASE WHEN $${tagsIdx}::boolean THEN EXCLUDED."tags" ELSE "TraceState"."tags" END,
        "stateVersion" = GREATEST("TraceState"."stateVersion", EXCLUDED."stateVersion"),
        "updatedAt" = now()`;

    await prisma.$executeRawUnsafe(sql, projectId, p.id, ...values, tagsProvided, tags, version);
  }
  return patches.length;
}

/** Whether the Postgres mutable-state path is enabled (ADR-0001 Phase 1 dual-run flag). */
export function mutableStateEnabled(): boolean {
  return process.env.MUTABLE_STATE_STORE === "pg";
}
