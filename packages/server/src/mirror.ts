import { clampTokens, computeCost, type ModelPrice, providerForModel } from "@memoturn/core";
import type { ObservationState, ScoreState, TraceState } from "@memoturn/db";
import type { ObservationRow, ScoreWriteRow, TraceRow } from "@memoturn/telemetry";

/**
 * Mirror builders — ADR-0001 Phase 2. Turn an authoritative Postgres `*State` row into the Doris
 * analytical row, computing the DERIVED fields (observation `latency_ms` + costs) that Phase 1
 * deliberately did not store — they're a pure function of the merged raw state.
 *
 * NULL columns coalesce to the same defaults the legacy mapper used, and `event_ts` carries
 * `stateVersion` (the merge-on-write sequence) so out-of-order/concurrent Doris writes converge on
 * the latest merged state. The ingest worker writes Doris from these rows (ADR-0001 Phase 2b).
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
