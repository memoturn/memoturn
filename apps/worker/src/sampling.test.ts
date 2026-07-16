import { describe, expect, it } from "vitest";
import type { MappedRows } from "./mappers.js";
import { applyHeadSampling, headKeep, sample } from "./sampling.js";

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

// Minimal rows — the sampler only reads `id` (traces) and `trace_id` (everything else).
const rowsFor = (traceIds: string[]): MappedRows =>
  ({
    traces: traceIds.map((id) => ({ id })),
    observations: traceIds.map((id) => ({ trace_id: id, id: `o-${id}` })),
    scores: traceIds.map((id) => ({ trace_id: id })),
    retrieval_documents: traceIds.map((id) => ({ trace_id: id })),
    embeddings: traceIds.map((id) => ({ trace_id: id })),
  }) as unknown as MappedRows;

describe("applyHeadSampling", () => {
  const ids = Array.from({ length: 100 }, (_, i) => `t-${i}`);

  it("is a no-op at rate 100", () => {
    const rows = rowsFor(ids);
    const { rows: out, dropped } = applyHeadSampling(100, rows);
    expect(out).toBe(rows); // same reference — untouched
    expect(dropped).toBe(0);
  });

  it("drops everything at rate 0", () => {
    const { rows: out, dropped } = applyHeadSampling(0, rowsFor(ids));
    expect(out.traces).toHaveLength(0);
    expect(out.observations).toHaveLength(0);
    expect(dropped).toBe(100);
  });

  it("keeps whole traces — an observation's fate matches its trace's", () => {
    const { rows: out } = applyHeadSampling(50, rowsFor(ids));
    const keptTraces = new Set(out.traces.map((t) => t.id));
    // Every surviving observation/score/embedding belongs to a surviving trace (no orphans),
    // and every kept trace keeps its rows.
    for (const o of out.observations) expect(keptTraces.has(o.trace_id)).toBe(true);
    for (const s of out.scores) expect(keptTraces.has(s.trace_id)).toBe(true);
    for (const id of ids) {
      const keep = headKeep(50, id);
      expect(keptTraces.has(id)).toBe(keep);
    }
  });

  it("dropped count = distinct traces removed", () => {
    const { rows: out, dropped } = applyHeadSampling(50, rowsFor(ids));
    expect(dropped).toBe(ids.length - out.traces.length);
  });

  it("sample() returns [0,1)", () => {
    for (const id of ["", "x", "trace-abc"]) {
      const v = sample(id);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});
