import type { ObservationDetail, ScoreRow, SessionSummary, TraceDetail, TraceSummary } from "@memoturn/contracts";
import { type TraceFilters, type TraceIO, type TraceScore, telemetry } from "@memoturn/telemetry";

/**
 * Trace reads for the API + dashboard UI, backed by the telemetry store. The store
 * scopes every query by project_id and returns contract-shaped rows; this module only
 * assembles composites (trace detail, per-trace maps).
 */

export type {
  ObservationDetail,
  ScoreRow,
  SessionSummary,
  TraceDetail,
  TraceFilters,
  TraceIO,
  TraceScore,
  TraceSummary,
};

export async function listTraces(projectId: string, filters: TraceFilters = {}): Promise<TraceSummary[]> {
  return telemetry().listTraces(projectId, filters);
}

export async function listSessions(projectId: string, limit = 50): Promise<SessionSummary[]> {
  return telemetry().listSessions(projectId, limit);
}

/** Lightweight fetch of name/input/output for a set of traces (for review queues). */
export async function getTraceIO(projectId: string, traceIds: string[]): Promise<Map<string, TraceIO>> {
  const rows = await telemetry().getTraceIO(projectId, traceIds);
  return new Map(rows.map((r) => [r.id, r]));
}

/** Fetch scores for a set of traces, grouped by trace id (for experiment comparison). */
export async function getScoresByTraceIds(projectId: string, traceIds: string[]): Promise<Map<string, TraceScore[]>> {
  const rows = await telemetry().getScoresByTraceIds(projectId, traceIds);
  const map = new Map<string, TraceScore[]>();
  for (const r of rows) {
    const arr = map.get(r.trace_id) ?? [];
    arr.push(r);
    map.set(r.trace_id, arr);
  }
  return map;
}

export async function getTrace(projectId: string, traceId: string): Promise<TraceDetail | null> {
  const store = telemetry();
  const header = await store.getTraceHeader(projectId, traceId);
  if (!header) return null;

  const observations = await store.listObservationsByTrace(projectId, traceId);
  const scores = await store.listScoresByTrace(projectId, traceId);

  return {
    ...header,
    observation_count: observations.length,
    total_cost: observations.reduce((s, o) => s + o.total_cost, 0),
    total_tokens: observations.reduce((s, o) => s + o.total_tokens, 0),
    latency_ms: observations.reduce((m, o) => Math.max(m, o.latency_ms), 0),
    observations,
    scores,
  };
}
