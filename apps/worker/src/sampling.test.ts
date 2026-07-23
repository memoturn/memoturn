import type { SamplingPolicy } from "@memoturn/contracts";
import { describe, expect, it } from "vitest";
import type { MappedRows } from "./mappers.js";
import { applySampling, headKeep, sample } from "./sampling.js";

describe("headKeep", () => {
  it("keeps everything at 100 and nothing at 0", () => {
    for (const id of ["a", "b", "trace-xyz", ""]) {
      expect(headKeep(100, id)).toBe(true);
      expect(headKeep(0, id)).toBe(false);
    }
  });

  it("is deterministic per trace id", () => {
    expect(headKeep(50, "trace-42")).toBe(headKeep(50, "trace-42"));
  });

  it("keeps roughly rate% of ids", () => {
    let kept = 0;
    const N = 2000;
    for (let i = 0; i < N; i++) if (headKeep(30, `trace-${i}`)) kept++;
    expect(kept).toBeGreaterThan(N * 0.22);
    expect(kept).toBeLessThan(N * 0.38);
  });
});

const policy = (over: Partial<SamplingPolicy> = {}): SamplingPolicy => ({
  rate: 100,
  keepOnError: false,
  keepLatencyMs: null,
  keepMinCostUsd: null,
  ...over,
});

// Minimal rows — the sampler reads `id` (traces), `trace_id`, and observation
// level/latency_ms/total_cost (for keep-rules).
type ObsSpec = { trace: string; level?: string; latency_ms?: number; total_cost?: number };
const rows = (traceIds: string[], obs: ObsSpec[] = []): MappedRows => {
  const specs: ObsSpec[] = obs.length ? obs : traceIds.map((t) => ({ trace: t }));
  return {
    traces: traceIds.map((id) => ({ id })),
    observations: specs.map((o, i) => ({
      trace_id: o.trace,
      id: `o-${i}`,
      level: o.level ?? "DEFAULT",
      latency_ms: o.latency_ms ?? 0,
      total_cost: o.total_cost ?? 0,
    })),
    scores: traceIds.map((id) => ({ trace_id: id })),
    retrieval_documents: traceIds.map((id) => ({ trace_id: id })),
    embeddings: traceIds.map((id) => ({ trace_id: id })),
  } as unknown as MappedRows;
};

describe("applySampling — head", () => {
  const ids = Array.from({ length: 100 }, (_, i) => `t-${i}`);

  it("is a no-op at rate 100 (even with keep-rules set — full-keep is unaffected)", () => {
    const r = rows(ids);
    const { rows: out, dropped, ruleKept } = applySampling(policy({ keepOnError: true }), r);
    expect(out).toBe(r); // same reference — untouched
    expect(dropped).toBe(0);
    expect(ruleKept).toBe(0);
  });

  it("drops everything at rate 0 with no keep-rules", () => {
    const { rows: out, dropped } = applySampling(policy({ rate: 0 }), rows(ids));
    expect(out.traces).toHaveLength(0);
    expect(out.observations).toHaveLength(0);
    expect(dropped).toBe(100);
  });

  it("keeps whole traces — an observation's fate matches its trace's head decision", () => {
    const { rows: out } = applySampling(policy({ rate: 50 }), rows(ids));
    const keptTraces = new Set(out.traces.map((t) => t.id));
    for (const o of out.observations) expect(keptTraces.has(o.trace_id)).toBe(true);
    for (const s of out.scores) expect(keptTraces.has(s.trace_id)).toBe(true);
    for (const id of ids) expect(keptTraces.has(id)).toBe(headKeep(50, id));
  });

  it("dropped count = distinct traces removed", () => {
    const { rows: out, dropped } = applySampling(policy({ rate: 50 }), rows(ids));
    expect(dropped).toBe(ids.length - out.traces.length);
  });
});

describe("applySampling — tail keep-rules", () => {
  // A trace the head hash DROPS at rate 1 (so any survival is due to a keep-rule).
  const dropped1 = Array.from({ length: 200 }, (_, i) => `t-${i}`).find((id) => !headKeep(1, id))!;

  it("keepOnError rescues an error trace the head rate would drop", () => {
    const r = rows([dropped1], [{ trace: dropped1, level: "ERROR" }]);
    const { rows: out, ruleKept } = applySampling(policy({ rate: 1, keepOnError: true }), r);
    expect(out.traces.map((t) => t.id)).toContain(dropped1);
    expect(ruleKept).toBe(1);
    // Without the rule the same trace is dropped.
    expect(applySampling(policy({ rate: 1 }), r).rows.traces).toHaveLength(0);
  });

  it("keepLatencyMs rescues a slow trace (>= threshold)", () => {
    const r = rows([dropped1], [{ trace: dropped1, latency_ms: 5000 }]);
    expect(applySampling(policy({ rate: 1, keepLatencyMs: 5000 }), r).rows.traces).toHaveLength(1);
    expect(applySampling(policy({ rate: 1, keepLatencyMs: 5001 }), r).rows.traces).toHaveLength(0);
  });

  it("keepMinCostUsd rescues an expensive trace (summed across the batch's spans)", () => {
    const r = rows(
      [dropped1],
      [
        { trace: dropped1, total_cost: 0.04 },
        { trace: dropped1, total_cost: 0.03 },
      ],
    );
    // 0.07 total >= 0.05 → kept; > 0.07 → dropped.
    expect(applySampling(policy({ rate: 1, keepMinCostUsd: 0.05 }), r).rows.traces).toHaveLength(1);
    expect(applySampling(policy({ rate: 1, keepMinCostUsd: 0.08 }), r).rows.traces).toHaveLength(0);
  });

  it("a clean trace is still subject to the head dice (rules don't keep everything)", () => {
    const ids = Array.from({ length: 100 }, (_, i) => `c-${i}`);
    const { rows: out } = applySampling(policy({ rate: 20, keepOnError: true }), rows(ids));
    // No errors → keep-rules match nothing → only the head-sampled survive.
    const keptTraces = new Set(out.traces.map((t) => t.id));
    for (const id of ids) expect(keptTraces.has(id)).toBe(headKeep(20, id));
  });

  it("ruleKept counts only traces the head rate would have dropped (no double-credit)", () => {
    // Split ids by their head-20 decision; give every trace an error span.
    const ids = Array.from({ length: 100 }, (_, i) => `m-${i}`);
    const obs = ids.map((t) => ({ trace: t, level: "ERROR" }));
    const { ruleKept } = applySampling(policy({ rate: 20, keepOnError: true }), rows(ids, obs));
    const headDropped = ids.filter((id) => !headKeep(20, id)).length;
    expect(ruleKept).toBe(headDropped);
  });
});

describe("sample()", () => {
  it("returns [0,1)", () => {
    for (const id of ["", "x", "trace-abc"]) {
      const v = sample(id);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});
