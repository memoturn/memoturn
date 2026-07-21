import { clampTokens, computeCost, type ModelPrice, providerForModel } from "@memoturn/core";
import type { ObservationState, ScoreState, TraceState } from "@memoturn/db";
import type { ObservationRow, ScoreWriteRow, TraceRow } from "@memoturn/telemetry";
import { getObservationStates, getScoreStates, getTraceStates } from "./mutablestate.js";

/**
 * Mirror builders — ADR-0001 Phase 2. Turn an authoritative Postgres `*State` row into the Doris
 * analytical row, computing the DERIVED fields (observation `latency_ms` + costs) that Phase 1
 * deliberately did not store — they're a pure function of the merged raw state.
 *
 * NULL columns coalesce to the exact defaults the worker mapper produces today, so a mirror row
 * equals the row the current read-merge path would write for the same settled state. `event_ts`
 * becomes `stateVersion` (the Phase-2 sequence column). Phase 2b wires these to write Doris from
 * the merged state and to shadow-compare against the read-merge output; here they're the pure,
 * unit-tested core with no runtime wiring yet.
 */

const iso = (d: Date | null): string => (d ? d.toISOString() : "");
const verTs = (v: bigint): string => new Date(Number(v)).toISOString();

export function mirrorTraceRow(s: TraceState): TraceRow {
  return {
    id: s.id,
    project_id: s.projectId,
    timestamp: iso(s.timestamp) || verTs(s.stateVersion),
    name: s.name ?? "",
    user_id: s.userId ?? "",
    session_id: s.sessionId ?? "",
    release: s.release ?? "",
    version: s.version ?? "",
    environment: s.environment ?? "default",
    public: s.public ? 1 : 0,
    tags: s.tags,
    metadata: s.metadata ?? "{}",
    input: s.input ?? "",
    output: s.output ?? "",
    event_ts: verTs(s.stateVersion),
  };
}

export function mirrorObservationRow(s: ObservationState, prices: ModelPrice[]): ObservationRow {
  const model = s.model ?? "";
  const promptTokens = clampTokens(s.promptTokens ?? undefined);
  const completionTokens = clampTokens(s.completionTokens ?? undefined);
  const totalTokens = clampTokens(s.totalTokens ?? promptTokens + completionTokens);
  const cost = computeCost(model, promptTokens, completionTokens, prices);
  const startTime = iso(s.startTime) || verTs(s.stateVersion);
  const endTime = s.endTime ? iso(s.endTime) : null;
  return {
    id: s.id,
    trace_id: s.traceId ?? "",
    project_id: s.projectId,
    type: (s.type ?? "SPAN") as ObservationRow["type"],
    parent_observation_id: s.parentObservationId ?? "",
    name: s.name ?? "",
    start_time: startTime,
    end_time: endTime,
    environment: s.environment ?? "default",
    level: (s.level ?? "DEFAULT") as ObservationRow["level"],
    status_message: s.statusMessage ?? "",
    model,
    provider: s.provider ?? providerForModel(model, prices),
    model_parameters: s.modelParameters ?? "{}",
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: totalTokens,
    cache_read_tokens: clampTokens(s.cacheReadTokens ?? undefined),
    cache_creation_tokens: clampTokens(s.cacheCreationTokens ?? undefined),
    input_cost: cost.inputCost,
    output_cost: cost.outputCost,
    total_cost: cost.totalCost,
    prompt_id: s.promptId ?? "",
    prompt_version: s.promptVersion ?? "",
    input: s.input ?? "",
    output: s.output ?? "",
    metadata: s.metadata ?? "{}",
    latency_ms: endTime ? Math.max(0, Date.parse(endTime) - Date.parse(startTime)) : 0,
    event_ts: verTs(s.stateVersion),
  };
}

export function mirrorScoreRow(s: ScoreState): ScoreWriteRow {
  return {
    id: s.id,
    project_id: s.projectId,
    trace_id: s.traceId ?? "",
    observation_id: s.observationId ?? "",
    name: s.name ?? "",
    timestamp: iso(s.timestamp) || verTs(s.stateVersion),
    environment: s.environment ?? "default",
    source: (s.source ?? "API") as ScoreWriteRow["source"],
    data_type: (s.dataType ?? "NUMERIC") as ScoreWriteRow["data_type"],
    value: s.value ?? null,
    string_value: s.stringValue ?? "",
    comment: s.comment ?? "",
    config_id: s.configId ?? "",
    event_ts: verTs(s.stateVersion),
  };
}

// ── Shadow-compare (ADR-0001 Phase 2b, step 1) ───────────────────────────────────
// Additively verify, on real traffic, that the Postgres-authoritative + mirror path produces the
// SAME Doris row the current read-merge path writes — the confidence needed before Phase 2b
// removes the read-merge + entity lock. Fields that legitimately differ (the merge version's
// event_ts, and timestamp/start_time whose read-merge fallback is the envelope ts vs the mirror's
// stateVersion — and latency_ms, which derives from start_time) are excluded from the diff.

const IGNORE: Record<"trace" | "observation" | "score", ReadonlySet<string>> = {
  trace: new Set(["event_ts", "timestamp"]),
  observation: new Set(["event_ts", "start_time", "latency_ms"]),
  score: new Set(["event_ts", "timestamp"]),
};

function valueEq(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => x === b[i]);
  if (typeof a === "number" && typeof b === "number") return Math.abs(a - b) < 1e-9; // cost floats
  return a === b;
}

/** Field names where the read-merge row and the mirror row differ (excluding `ignore`). */
export function diffMirror(
  mapped: Record<string, unknown>,
  mirror: Record<string, unknown>,
  ignore: ReadonlySet<string>,
): string[] {
  const diffs: string[] = [];
  for (const k of Object.keys(mapped)) {
    if (!ignore.has(k) && !valueEq(mapped[k], mirror[k])) diffs.push(k);
  }
  return diffs;
}

export interface ShadowResult {
  entity: string;
  matched: number;
  mismatched: number;
  missing: number; // rows in Doris output with no Postgres state (shouldn't happen once merged)
  samples: { id: string; fields: string[] }[];
}

function compareGroup<M extends { id: string }>(
  entity: string,
  mappedRows: M[],
  mirrorFor: (id: string) => Record<string, unknown> | null,
  ignore: ReadonlySet<string>,
): ShadowResult {
  const r: ShadowResult = { entity, matched: 0, mismatched: 0, missing: 0, samples: [] };
  for (const mapped of mappedRows) {
    const mirror = mirrorFor(mapped.id);
    if (!mirror) {
      r.missing++;
      continue;
    }
    const fields = diffMirror(mapped as Record<string, unknown>, mirror, ignore);
    if (fields.length === 0) r.matched++;
    else {
      r.mismatched++;
      if (r.samples.length < 3) r.samples.push({ id: mapped.id, fields });
    }
  }
  return r;
}

/**
 * Compare the mapped (read-merge) rows for a batch against the mirror rows built from the freshly
 * merged Postgres state. Returns per-entity match/mismatch counts + a few sample mismatches. Read
 * the state AFTER the Postgres merge for this batch.
 */
export async function shadowCompareBatch(
  projectId: string,
  mapped: { traces: TraceRow[]; observations: ObservationRow[]; scores: ScoreWriteRow[] },
  prices: ModelPrice[],
): Promise<ShadowResult[]> {
  const out: ShadowResult[] = [];
  if (mapped.traces.length > 0) {
    const st = new Map(
      (
        await getTraceStates(
          projectId,
          mapped.traces.map((t) => t.id),
        )
      ).map((s) => [s.id, s]),
    );
    out.push(
      compareGroup(
        "trace",
        mapped.traces,
        (id) => {
          const s = st.get(id);
          return s ? (mirrorTraceRow(s) as unknown as Record<string, unknown>) : null;
        },
        IGNORE.trace,
      ),
    );
  }
  if (mapped.observations.length > 0) {
    const st = new Map(
      (
        await getObservationStates(
          projectId,
          mapped.observations.map((o) => o.id),
        )
      ).map((s) => [s.id, s]),
    );
    out.push(
      compareGroup(
        "observation",
        mapped.observations,
        (id) => {
          const s = st.get(id);
          return s ? (mirrorObservationRow(s, prices) as unknown as Record<string, unknown>) : null;
        },
        IGNORE.observation,
      ),
    );
  }
  if (mapped.scores.length > 0) {
    const st = new Map(
      (
        await getScoreStates(
          projectId,
          mapped.scores.map((sc) => sc.id),
        )
      ).map((s) => [s.id, s]),
    );
    out.push(
      compareGroup(
        "score",
        mapped.scores,
        (id) => {
          const s = st.get(id);
          return s ? (mirrorScoreRow(s) as unknown as Record<string, unknown>) : null;
        },
        IGNORE.score,
      ),
    );
  }
  return out;
}
