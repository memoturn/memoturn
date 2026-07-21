import type { GenerationBody, ScoreBody, TraceBody } from "@memoturn/core";
import { prisma } from "@memoturn/db";

/**
 * Mutable entity state — ADR-0001, Phase 1.
 *
 * Ingest events merge into Postgres `*State` tables field-by-field: only fields an event
 * actually carries overwrite; everything else keeps its stored value. Each merge is an atomic
 * `INSERT … ON CONFLICT DO UPDATE SET col = COALESCE(EXCLUDED.col, stored.col)`, so concurrent
 * batches patching the same entity can't lose each other's fields (Postgres serializes the
 * conflicting upsert) and retries are idempotent — the correctness Doris's single row-level
 * sequence column can't provide. Doris becomes the analytical mirror in Phase 2; this phase runs
 * additively behind MUTABLE_STATE_STORE to validate the merge.
 *
 * "Provided by the event" is decided from the RAW wire body (the keys the client actually sent),
 * NOT the zod-parsed body — zod fills defaults (e.g. `environment: "default"`), which would
 * otherwise make every update clobber that field. Values come from the parsed/masked body so
 * stored state matches what the pipeline persists. Derived fields (observation latency/cost) are
 * NOT stored — they are computed from the merged raw state at mirror time (Phase 2).
 */

const jsonStr = (v: unknown): string => (typeof v === "string" ? v : JSON.stringify(v));

/** A mergeable column and its Postgres type — the cast is required so a NULL bind param (an
 * unprovided field) has a known type, else Postgres can't infer it inside COALESCE. */
type ColDef = readonly [col: string, pgType: string];

interface StateUpsert {
  id: string;
  version: bigint; // merge version (epoch ms of the envelope timestamp)
  scalars: Record<string, unknown>;
  /** Optional provided-flag + value for a single array column (traces' `tags`). */
  arrayProvided?: boolean;
  arrayValue?: string[];
}

/**
 * One atomic field-level upsert per row into `table`. Scalar columns merge via
 * `COALESCE(provided, stored)`; the optional `arrayCol` uses a provided-flag CASE because a
 * non-null array can't ride the COALESCE-of-NULL trick. Returns the number of rows applied.
 */
async function upsertState(
  table: string,
  scalarCols: readonly ColDef[],
  arrayCol: string | null,
  projectId: string,
  rows: StateUpsert[],
): Promise<number> {
  for (const r of rows) {
    const base = 2; // $1 projectId, $2 id
    const cast = (i: number) => `$${base + i + 1}::${scalarCols[i]![1]}`;
    const params: unknown[] = [projectId, r.id, ...scalarCols.map(([c]) => r.scalars[c] ?? null)];

    const insertCols = scalarCols.map(([c]) => `"${c}"`).join(", ");
    const insertVals = scalarCols.map((_, i) => cast(i)).join(", ");
    const colAssign = scalarCols.map(([c], i) => `"${c}" = COALESCE(${cast(i)}, "${table}"."${c}")`).join(", ");

    let idx = base + scalarCols.length; // index of the last scalar param
    let arrayInsertCol = "";
    let arrayInsertVal = "";
    let arrayAssign = "";
    if (arrayCol) {
      const provIdx = idx + 1;
      const valIdx = idx + 2;
      idx = valIdx;
      params.push(r.arrayProvided ?? false, r.arrayValue ?? []);
      arrayInsertCol = `, "${arrayCol}"`;
      arrayInsertVal = `, $${valIdx}::text[]`;
      arrayAssign = `, "${arrayCol}" = CASE WHEN $${provIdx}::boolean THEN EXCLUDED."${arrayCol}" ELSE "${table}"."${arrayCol}" END`;
    }
    const verIdx = idx + 1;
    params.push(r.version);

    const sql = `
      INSERT INTO "${table}" ("projectId", "id", ${insertCols}${arrayInsertCol}, "stateVersion", "updatedAt")
      VALUES ($1, $2, ${insertVals}${arrayInsertVal}, $${verIdx}::bigint, now())
      ON CONFLICT ("projectId", "id") DO UPDATE SET
        ${colAssign}${arrayAssign},
        "stateVersion" = GREATEST("${table}"."stateVersion", EXCLUDED."stateVersion"),
        "updatedAt" = now()`;
    await prisma.$executeRawUnsafe(sql, ...params);
  }
  return rows.length;
}

/** Merge version = the event's envelope timestamp in epoch ms (retry-stable; GREATEST keeps it rising). */
const versionOf = (eventTs: string): bigint => {
  const ms = Date.parse(eventTs);
  return BigInt(Number.isFinite(ms) ? ms : 0);
};

// ── Traces ───────────────────────────────────────────────────────────────────────

export interface TracePatch {
  id: string;
  mergeVersion: bigint;
  scalars: Record<string, unknown>;
  tags?: string[];
}

const TRACE_COLS: readonly ColDef[] = [
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

/**
 * Build a sparse trace patch from the fields the client actually sent (present in `rawBody`),
 * taking values from `maskedBody`. `eventTs` is the envelope timestamp (the merge version).
 */
export function extractTracePatch(
  rawBody: Record<string, unknown>,
  maskedBody: TraceBody,
  eventTs: string,
): TracePatch {
  const has = (k: string) => Object.hasOwn(rawBody, k);
  const s: Record<string, unknown> = {};
  if (has("name")) s.name = maskedBody.name ?? "";
  if (has("timestamp") && maskedBody.timestamp) s.timestamp = new Date(maskedBody.timestamp);
  if (has("userId")) s.userId = maskedBody.userId ?? "";
  if (has("sessionId")) s.sessionId = maskedBody.sessionId ?? "";
  if (has("release")) s.release = maskedBody.release ?? "";
  if (has("version")) s.version = maskedBody.version ?? "";
  if (has("environment")) s.environment = maskedBody.environment;
  if (has("public")) s.public = maskedBody.public ?? false;
  if (has("metadata")) s.metadata = jsonStr(maskedBody.metadata);
  if (has("input")) s.input = jsonStr(maskedBody.input);
  if (has("output")) s.output = jsonStr(maskedBody.output);
  const p: TracePatch = { id: maskedBody.id, mergeVersion: versionOf(eventTs), scalars: s };
  if (has("tags")) p.tags = maskedBody.tags ?? [];
  return p;
}

export async function mergeTraceStates(projectId: string, patches: TracePatch[]): Promise<number> {
  return upsertState(
    "TraceState",
    TRACE_COLS,
    "tags",
    projectId,
    patches.map((p) => ({
      id: p.id,
      version: p.mergeVersion,
      scalars: p.scalars,
      arrayProvided: p.tags !== undefined,
      arrayValue: p.tags ?? [],
    })),
  );
}

// ── Observations ───────────────────────────────────────────────────────────────────

/** Base observation type per event kind; `observationType` on the body overrides it (TOOL/AGENT/…). */
const OBS_TYPE: Record<string, string> = {
  "span-create": "SPAN",
  "span-update": "SPAN",
  "generation-create": "GENERATION",
  "generation-update": "GENERATION",
  "event-create": "EVENT",
};

export interface ObservationPatch {
  id: string;
  mergeVersion: bigint;
  scalars: Record<string, unknown>;
}

const OBS_COLS: readonly ColDef[] = [
  ["traceId", "text"],
  ["type", "text"],
  ["parentObservationId", "text"],
  ["name", "text"],
  ["startTime", "timestamp"],
  ["endTime", "timestamp"],
  ["environment", "text"],
  ["level", "text"],
  ["statusMessage", "text"],
  ["model", "text"],
  ["provider", "text"],
  ["modelParameters", "text"],
  ["promptTokens", "integer"],
  ["completionTokens", "integer"],
  ["totalTokens", "integer"],
  ["cacheReadTokens", "integer"],
  ["cacheCreationTokens", "integer"],
  ["promptId", "text"],
  ["promptVersion", "text"],
  ["input", "text"],
  ["output", "text"],
  ["metadata", "text"],
];

/**
 * Build a sparse observation patch. `eventType` (span-create/…/generation-update) sets the base
 * `type` (overridden by the body's `observationType`); token fields live under the `usage` key.
 */
export function extractObservationPatch(
  rawBody: Record<string, unknown>,
  maskedBody: GenerationBody,
  eventType: string,
  eventTs: string,
): ObservationPatch {
  const has = (k: string) => Object.hasOwn(rawBody, k);
  const s: Record<string, unknown> = {};
  // `type` is always known from the event kind (+ optional override) — set it on every event.
  s.type = maskedBody.observationType ?? OBS_TYPE[eventType] ?? "SPAN";
  s.traceId = maskedBody.traceId; // required on every observation event
  if (has("parentObservationId")) s.parentObservationId = maskedBody.parentObservationId ?? "";
  if (has("name")) s.name = maskedBody.name ?? "";
  if (has("startTime") && maskedBody.startTime) s.startTime = new Date(maskedBody.startTime);
  if (has("endTime") && maskedBody.endTime) s.endTime = new Date(maskedBody.endTime);
  if (has("environment")) s.environment = maskedBody.environment;
  if (has("level")) s.level = maskedBody.level ?? "DEFAULT";
  if (has("statusMessage")) s.statusMessage = maskedBody.statusMessage ?? "";
  if (has("model")) s.model = maskedBody.model ?? "";
  if (has("provider")) s.provider = maskedBody.provider ?? "";
  if (has("modelParameters")) s.modelParameters = jsonStr(maskedBody.modelParameters);
  if (has("promptId")) s.promptId = maskedBody.promptId ?? "";
  if (has("promptVersion")) s.promptVersion = maskedBody.promptVersion ?? "";
  if (has("input")) s.input = jsonStr(maskedBody.input);
  if (has("output")) s.output = jsonStr(maskedBody.output);
  if (has("metadata")) s.metadata = jsonStr(maskedBody.metadata);

  // Tokens are nested under `usage`; provided-ness is per-key within that object.
  if (has("usage")) {
    const rawUsage = (rawBody.usage as Record<string, unknown>) ?? {};
    const u = maskedBody.usage ?? {};
    const setTok = (col: string, k: keyof NonNullable<GenerationBody["usage"]>) => {
      if (Object.hasOwn(rawUsage, k)) s[col] = u[k] ?? 0;
    };
    setTok("promptTokens", "promptTokens");
    setTok("completionTokens", "completionTokens");
    setTok("totalTokens", "totalTokens");
    setTok("cacheReadTokens", "cacheReadTokens");
    setTok("cacheCreationTokens", "cacheCreationTokens");
  }
  return { id: maskedBody.id, mergeVersion: versionOf(eventTs), scalars: s };
}

export async function mergeObservationStates(projectId: string, patches: ObservationPatch[]): Promise<number> {
  return upsertState(
    "ObservationState",
    OBS_COLS,
    null,
    projectId,
    patches.map((p) => ({ id: p.id, version: p.mergeVersion, scalars: p.scalars })),
  );
}

// ── Scores ───────────────────────────────────────────────────────────────────────

export interface ScorePatch {
  id: string;
  mergeVersion: bigint;
  scalars: Record<string, unknown>;
}

const SCORE_COLS: readonly ColDef[] = [
  ["traceId", "text"],
  ["observationId", "text"],
  ["name", "text"],
  ["timestamp", "timestamp"],
  ["environment", "text"],
  ["source", "text"],
  ["dataType", "text"],
  ["value", "double precision"],
  ["stringValue", "text"],
  ["comment", "text"],
  ["configId", "text"],
];

/**
 * Build a sparse score patch from the fields the client actually sent (present in `rawBody`).
 * Scores are lightly mutable (corrections re-send the same id); `source`/`dataType` NULL when
 * unsent coalesce to their defaults at mirror time (like `environment`). Note: because `value`
 * merges via COALESCE, a correction can't clear a prior numeric value back to NULL — acceptable
 * for Phase 1 (a real correction re-sends the value).
 */
export function extractScorePatch(
  rawBody: Record<string, unknown>,
  maskedBody: ScoreBody,
  eventTs: string,
): ScorePatch {
  const has = (k: string) => Object.hasOwn(rawBody, k);
  const s: Record<string, unknown> = {};
  s.traceId = maskedBody.traceId; // required on every score
  s.name = maskedBody.name; // required
  if (has("observationId")) s.observationId = maskedBody.observationId ?? "";
  if (has("timestamp") && maskedBody.timestamp) s.timestamp = new Date(maskedBody.timestamp);
  if (has("environment")) s.environment = maskedBody.environment;
  if (has("source")) s.source = maskedBody.source;
  if (has("dataType")) s.dataType = maskedBody.dataType;
  if (has("value")) s.value = maskedBody.value ?? null;
  if (has("stringValue")) s.stringValue = maskedBody.stringValue ?? "";
  if (has("comment")) s.comment = maskedBody.comment ?? "";
  if (has("configId")) s.configId = maskedBody.configId ?? "";
  return { id: maskedBody.id, mergeVersion: versionOf(eventTs), scalars: s };
}

export async function mergeScoreStates(projectId: string, patches: ScorePatch[]): Promise<number> {
  return upsertState(
    "ScoreState",
    SCORE_COLS,
    null,
    projectId,
    patches.map((p) => ({ id: p.id, version: p.mergeVersion, scalars: p.scalars })),
  );
}

// ── State readers (Phase 2 mirror / shadow-compare) ──────────────────────────────

export function getTraceStates(projectId: string, ids: string[]) {
  return prisma.traceState.findMany({ where: { projectId, id: { in: ids } } });
}
export function getObservationStates(projectId: string, ids: string[]) {
  return prisma.observationState.findMany({ where: { projectId, id: { in: ids } } });
}
export function getScoreStates(projectId: string, ids: string[]) {
  return prisma.scoreState.findMany({ where: { projectId, id: { in: ids } } });
}

/** Whether the Postgres mutable-state path is enabled (ADR-0001 Phase 1 dual-run flag). */
export function mutableStateEnabled(): boolean {
  return process.env.MUTABLE_STATE_STORE === "pg";
}
