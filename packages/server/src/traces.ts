import type {
  ObservationDetail,
  ScoreRow,
  SessionSummary,
  SingleFilter,
  TraceDetail,
  TraceFacets,
  TraceSummary,
  TraceTags,
  UserSummary,
} from "@memoturn/contracts";
import { isoNow } from "@memoturn/core";
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

export async function countTraces(projectId: string, filters: TraceFilters = {}): Promise<number> {
  return telemetry().countTraces(projectId, filters);
}

/**
 * Replace a trace's tags. Reads the stored trace row and re-inserts it with the new tags and a
 * newer event_ts — the telemetry store's last-writer-wins merge overwrites the old row without a
 * DELETE (same mechanism as score correction). Returns null when the trace doesn't exist.
 */
export async function setTraceTags(projectId: string, traceId: string, tags: string[]): Promise<TraceTags | null> {
  const store = telemetry();
  const [row] = await store.getTraceRowsByIds(projectId, [traceId]);
  if (!row) return null;
  const clean = [...new Set(tags.map((t) => t.trim()).filter(Boolean))];
  await store.insertRows("traces", [{ ...row, tags: clean, event_ts: isoNow() }]);
  return { traceId, tags: clean };
}

/**
 * Trace volume over the range for the histogram above the list. Buckets by hour for short
 * ranges (≤ 2 days) and by day otherwise, so the bars stay readable at both scales.
 */
export async function traceHistogram(
  projectId: string,
  filters: TraceFilters = {},
): Promise<import("@memoturn/contracts").TraceHistogram> {
  const interval = filters.days && filters.days > 0 && filters.days <= 2 ? "hour" : "day";
  const buckets = await telemetry().traceHistogram(projectId, filters, interval);
  return { interval, buckets };
}

export async function traceFacets(
  projectId: string,
  opts: {
    days?: number;
    limit?: number;
    environment?: string;
    search?: string;
    userId?: string;
    tag?: string;
    scoreName?: string;
    level?: string;
    type?: string;
    filters?: SingleFilter[];
  } = {},
): Promise<TraceFacets> {
  return telemetry().traceFacets(projectId, opts);
}

export async function listSessions(
  projectId: string,
  opts: { limit?: number; offset?: number; days?: number; search?: string } = {},
): Promise<SessionSummary[]> {
  return telemetry().listSessions(projectId, opts);
}

export async function countSessions(projectId: string, days?: number, search?: string): Promise<number> {
  return telemetry().countSessions(projectId, days, search);
}

export async function listUsers(
  projectId: string,
  opts: { limit?: number; offset?: number; days?: number; search?: string } = {},
): Promise<UserSummary[]> {
  return telemetry().listUsers(projectId, opts);
}

export async function countUsers(projectId: string, days?: number, search?: string): Promise<number> {
  return telemetry().countUsers(projectId, days, search);
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

  // RAG: attach retrieved documents to the spans that produced them.
  const docs = await store.listRetrievalDocumentsByObservationIds(
    projectId,
    observations.map((o) => o.id),
  );
  if (docs.length > 0) {
    const byObs = new Map<string, (typeof observations)[number]["retrieval_documents"]>();
    for (const d of docs) {
      const arr = byObs.get(d.observation_id) ?? [];
      arr.push({ rank: d.rank, score: d.score, doc_id: d.doc_id, content: d.content, metadata: d.metadata });
      byObs.set(d.observation_id, arr);
    }
    for (const o of observations) o.retrieval_documents = byObs.get(o.id) ?? [];
  }

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
