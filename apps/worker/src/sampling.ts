import type { MappedRows } from "./mappers.js";

/**
 * Head-based ingest sampling. A project's `rate` (0–100) is the percent of traces KEPT in the
 * query store (Doris); 100 = keep all (the default, a no-op). The decision is a pure, stable
 * function of trace id, so a trace is kept-or-dropped WHOLE and identically across every batch
 * it spans — no orphan observations/scores. The raw batch still lands in blob (the replay
 * source of truth), so sampling only trims the queryable store, never loses data irrecoverably.
 *
 * Tail sampling (keep-on-error / keep-on-high-cost regardless of the head decision) needs a
 * per-trace buffering/decision window and is a deliberate follow-up — see the roadmap.
 */

/** Stable [0,1) hash of a seed string (FNV-1a) — deterministic per-trace sampling. */
export function sample(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 100000) / 100000;
}

/** Whether a trace is kept under head sampling at `rate` (0–100 percent). */
export function headKeep(rate: number, traceId: string): boolean {
  if (rate >= 100) return true;
  if (rate <= 0) return false;
  return sample(traceId) < rate / 100;
}

/**
 * Drop the rows of head-sampled-out traces from a mapped batch. Returns the filtered rows plus
 * `dropped` (distinct traces removed) for observability. `rate >= 100` short-circuits to a no-op.
 */
export function applyHeadSampling(rate: number, rows: MappedRows): { rows: MappedRows; dropped: number } {
  if (rate >= 100) return { rows, dropped: 0 };
  const kept = new Set<string>();
  const seen = new Set<string>();
  const keep = (traceId: string): boolean => {
    if (!seen.has(traceId)) {
      seen.add(traceId);
      if (headKeep(rate, traceId)) kept.add(traceId);
    }
    return kept.has(traceId);
  };
  const filtered: MappedRows = {
    traces: rows.traces.filter((r) => keep(r.id)),
    observations: rows.observations.filter((r) => keep(r.trace_id)),
    scores: rows.scores.filter((r) => keep(r.trace_id)),
    retrieval_documents: rows.retrieval_documents.filter((r) => keep(r.trace_id)),
    embeddings: rows.embeddings.filter((r) => keep(r.trace_id)),
  };
  return { rows: filtered, dropped: seen.size - kept.size };
}
