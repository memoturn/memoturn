import type { SamplingPolicy } from "@memoturn/contracts";
import type { MappedRows } from "./mappers.js";

/**
 * Ingest sampling — head + tail — applied at the Doris/PG mirror step.
 *
 * HEAD: a project's `rate` (0–100) is the percent of traces KEPT, decided by a pure,
 * stable hash of trace id, so a trace is kept-or-dropped WHOLE and identically across
 * every batch it spans — no orphan observations/scores. `rate >= 100` is a no-op.
 *
 * TAIL (keep-rules): a trace is ALSO kept — regardless of the head dice — when it looks
 * worth debugging: `keepOnError` (an ERROR-level observation), `keepLatencyMs` (a span at
 * or over that latency), `keepMinCostUsd` (summed cost at or over that spend). So a low
 * head rate sheds routine volume while the interesting traces always survive.
 *
 * The raw batch always lands in blob (the replay source of truth), so sampling only trims
 * the queryable store, never loses data irrecoverably.
 *
 * LIMITATION (documented, minor): keep-rules are evaluated against the rows in the CURRENT
 * batch. The head baseline is fully cross-batch-consistent (stable hash), but if a
 * keep-signal (e.g. an error span) arrives in a LATER batch than already-dropped spans of
 * the same trace, the kept trace is partial. In practice SDKs flush a trace's spans
 * together and terminal errors land with the trace, so this is rare; blob replay is the
 * full-fidelity recovery path.
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

/** True when any keep-rule is configured (tail sampling active). */
function hasKeepRules(p: SamplingPolicy): boolean {
  return p.keepOnError || p.keepLatencyMs !== null || p.keepMinCostUsd !== null;
}

/**
 * Per-trace set of trace ids in this batch that trip a keep-rule (error / latency / cost).
 * Cost is summed per trace across the batch's observations; latency/error match any span.
 */
function rulesMatchedTraceIds(policy: SamplingPolicy, rows: MappedRows): Set<string> {
  const kept = new Set<string>();
  if (!hasKeepRules(policy)) return kept;
  const costByTrace = new Map<string, number>();
  for (const o of rows.observations) {
    if (policy.keepOnError && o.level === "ERROR") kept.add(o.trace_id);
    if (policy.keepLatencyMs !== null && o.latency_ms >= policy.keepLatencyMs) kept.add(o.trace_id);
    if (policy.keepMinCostUsd !== null) {
      costByTrace.set(o.trace_id, (costByTrace.get(o.trace_id) ?? 0) + (o.total_cost ?? 0));
    }
  }
  if (policy.keepMinCostUsd !== null) {
    for (const [traceId, cost] of costByTrace) if (cost >= policy.keepMinCostUsd) kept.add(traceId);
  }
  return kept;
}

/**
 * Drop the rows of sampled-out traces from a mapped batch. A trace is kept if the head
 * dice keeps it OR any keep-rule matches its rows in this batch. Returns the filtered rows
 * plus `dropped` (distinct traces removed) and `ruleKept` (distinct traces rescued by a
 * keep-rule that the head rate would have dropped) for observability. `rate >= 100` with
 * no keep-rules is a no-op — keep-rules only rescue traces the head rate would drop, so
 * full-keep is unaffected either way.
 */
export function applySampling(
  policy: SamplingPolicy,
  rows: MappedRows,
): { rows: MappedRows; dropped: number; ruleKept: number } {
  if (policy.rate >= 100) return { rows, dropped: 0, ruleKept: 0 };

  const ruleTraces = rulesMatchedTraceIds(policy, rows);
  const decided = new Map<string, boolean>();
  let ruleKept = 0;
  const keep = (traceId: string): boolean => {
    let d = decided.get(traceId);
    if (d === undefined) {
      const head = headKeep(policy.rate, traceId);
      const rule = ruleTraces.has(traceId);
      d = head || rule;
      if (rule && !head) ruleKept++;
      decided.set(traceId, d);
    }
    return d;
  };

  const filtered: MappedRows = {
    traces: rows.traces.filter((r) => keep(r.id)),
    observations: rows.observations.filter((r) => keep(r.trace_id)),
    scores: rows.scores.filter((r) => keep(r.trace_id)),
    retrieval_documents: rows.retrieval_documents.filter((r) => keep(r.trace_id)),
    embeddings: rows.embeddings.filter((r) => keep(r.trace_id)),
  };
  const dropped = [...decided.values()].filter((v) => !v).length;
  return { rows: filtered, dropped, ruleKept };
}
