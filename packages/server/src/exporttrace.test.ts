import { beforeEach, describe, expect, it, vi } from "vitest";

// exportTraceJson composes getTrace, so the store is mocked at the same seam traces.test.ts uses.
const getTraceHeader = vi.fn();
const listObservationsByTrace = vi.fn();
const listScoresByTrace = vi.fn();
const listRetrievalDocumentsByObservationIds = vi.fn();
vi.mock("@memoturn/telemetry", () => ({
  TRACE_PREVIEW_CHARS: 300,
  telemetry: () => ({
    getTraceHeader,
    listObservationsByTrace,
    listScoresByTrace,
    listRetrievalDocumentsByObservationIds,
  }),
}));

const { exportTraceJson, TRACE_EXPORT_VERSION } = await import("./export.js");

describe("exportTraceJson", () => {
  beforeEach(() => {
    getTraceHeader.mockReset();
    listObservationsByTrace.mockReset();
    listScoresByTrace.mockReset();
    listRetrievalDocumentsByObservationIds.mockReset();
  });

  it("returns null for a trace that is not in this project", async () => {
    getTraceHeader.mockResolvedValue(null);
    expect(await exportTraceJson("p1", "nope")).toBeNull();
    // A missing trace must not fan out into the other store reads.
    expect(listObservationsByTrace).not.toHaveBeenCalled();
  });

  it("emits a versioned envelope wrapping the full trace", async () => {
    getTraceHeader.mockResolvedValue({
      id: "t1",
      name: "checkout",
      timestamp: "2026-08-07T10:00:00.000Z",
      environment: "production",
    });
    listObservationsByTrace.mockResolvedValue([
      {
        id: "o1",
        total_cost: 0.25,
        total_tokens: 300,
        latency_ms: 120,
        reasoning_tokens: 120,
        retrieval_documents: [],
      },
    ]);
    listScoresByTrace.mockResolvedValue([{ id: "s1", name: "helpfulness", value: 0.9 }]);
    listRetrievalDocumentsByObservationIds.mockResolvedValue([]);

    const json = await exportTraceJson("p1", "t1", new Date("2026-08-07T12:00:00.000Z"));
    const doc = JSON.parse(json!);

    expect(doc.memoturn_export).toEqual({
      kind: "trace",
      version: TRACE_EXPORT_VERSION,
      exported_at: "2026-08-07T12:00:00.000Z",
      project_id: "p1",
    });
    expect(doc.trace.id).toBe("t1");
    // The whole trace travels with the document — observations and scores, not just the header.
    expect(doc.trace.observations).toHaveLength(1);
    expect(doc.trace.observations[0].reasoning_tokens).toBe(120);
    expect(doc.trace.scores).toHaveLength(1);
    expect(doc.trace.observation_count).toBe(1);
    // Pretty-printed and newline-terminated so the file is diffable and shell-friendly.
    expect(json!.endsWith("\n")).toBe(true);
    expect(json).toContain('\n  "trace"');
  });

  it("attaches retrieved documents to the span that produced them", async () => {
    getTraceHeader.mockResolvedValue({ id: "t1", name: "rag", timestamp: "2026-08-07T10:00:00.000Z" });
    listObservationsByTrace.mockResolvedValue([
      { id: "o1", total_cost: 0, total_tokens: 0, latency_ms: 0, retrieval_documents: [] },
    ]);
    listScoresByTrace.mockResolvedValue([]);
    listRetrievalDocumentsByObservationIds.mockResolvedValue([
      { observation_id: "o1", rank: 0, score: 0.82, doc_id: "d1", content: "chunk", metadata: "{}" },
    ]);

    const doc = JSON.parse((await exportTraceJson("p1", "t1"))!);
    expect(doc.trace.observations[0].retrieval_documents).toEqual([
      { rank: 0, score: 0.82, doc_id: "d1", content: "chunk", metadata: "{}" },
    ]);
  });
});
