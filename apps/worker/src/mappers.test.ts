import type { IngestEvent } from "@memoturn/core";
import { telemetry } from "@memoturn/telemetry";
import { describe, expect, it } from "vitest";
import { mapEvents } from "./mappers.js";

const PROJECT = "test-proj";

function sampleBatch(traceId: string): IngestEvent[] {
  return [
    {
      id: "e1",
      type: "trace-create",
      timestamp: "2026-06-25T00:00:00.000Z",
      body: { id: traceId, name: "t", environment: "default" },
    },
    {
      id: "e2",
      type: "generation-create",
      timestamp: "2026-06-25T00:00:00.000Z",
      body: {
        id: `${traceId}-g`,
        traceId,
        name: "gen",
        model: "claude-sonnet-4-6",
        environment: "default",
        startTime: "2026-06-25T00:00:00.000Z",
      },
    },
    {
      id: "e3",
      type: "generation-update",
      timestamp: "2026-06-25T00:00:01.000Z",
      body: {
        id: `${traceId}-g`,
        traceId,
        environment: "default",
        endTime: "2026-06-25T00:00:01.000Z",
        output: "hi",
        usage: { promptTokens: 1000, completionTokens: 1000 },
      },
    },
  ];
}

describe("mapEvents", () => {
  it("merges create+update and computes cost for a known model", () => {
    const { traces, observations } = mapEvents(PROJECT, sampleBatch("t1"));
    expect(traces).toHaveLength(1);
    expect(observations).toHaveLength(1);
    const o = observations[0]!;
    expect(o.type).toBe("GENERATION");
    expect(o.output).toBe("hi"); // update merged onto create
    expect(o.total_tokens).toBe(2000);
    expect(o.total_cost).toBeCloseTo(0.018); // 1M in @ $3 + 1M out @ $15 per MTok
    expect(o.provider).toBe("anthropic");
    expect(o.latency_ms).toBe(1000); // endTime − startTime, computed by the mapper
  });

  it("maps prompt-cache usage onto the observation row", () => {
    const { observations } = mapEvents(PROJECT, [
      {
        id: "e1",
        type: "generation-create",
        timestamp: "2026-06-25T00:00:00.000Z",
        body: {
          id: "cache-g",
          traceId: "tc",
          model: "claude-sonnet-4-6",
          environment: "default",
          startTime: "2026-06-25T00:00:00.000Z",
          usage: { promptTokens: 1000, completionTokens: 10, cacheReadTokens: 760, cacheCreationTokens: 240 },
        },
      },
    ]);
    const o = observations[0]!;
    expect(o.cache_read_tokens).toBe(760);
    expect(o.cache_creation_tokens).toBe(240);
  });

  it("treats a cross-batch partial update as a patch over the stored row (bases)", () => {
    // Batch 1 materialized this row (create with full state)...
    const [base] = mapEvents(PROJECT, sampleBatch("t2").slice(0, 2)).observations;
    expect(base!.model).toBe("claude-sonnet-4-6");

    // ...batch 2 carries only the update. Without a base every unset field would
    // collapse to defaults; with the base they must survive.
    const updateOnly = sampleBatch("t2").slice(2);
    const { observations } = mapEvents(PROJECT, updateOnly, [], {
      observations: new Map([[base!.id, base!]]),
    });
    const o = observations[0]!;
    expect(o.name).toBe("gen"); // set at create time, absent from the update
    expect(o.model).toBe("claude-sonnet-4-6");
    expect(o.provider).toBe("anthropic");
    expect(o.start_time).toBe("2026-06-25T00:00:00.000Z");
    expect(o.output).toBe("hi"); // carried by the update itself
    expect(o.total_tokens).toBe(2000); // usage in update → recomputed with base model
    expect(o.total_cost).toBeCloseTo(0.018);
    expect(o.latency_ms).toBe(1000); // base start_time + update endTime
    expect(o.event_ts).toBe("2026-06-25T00:00:01.000Z"); // newest event wins LWW
  });

  it("keeps base tokens/cost when an update carries no usage", () => {
    const [base] = mapEvents(PROJECT, sampleBatch("t3").slice(0, 3)).observations;
    const patch = mapEvents(
      PROJECT,
      [
        {
          id: "e4",
          type: "generation-update",
          timestamp: "2026-06-25T00:00:02.000Z",
          body: { id: "t3-g", traceId: "t3", environment: "default", statusMessage: "done" },
        },
      ],
      [],
      { observations: new Map([[base!.id, base!]]) },
    ).observations[0]!;
    expect(patch.status_message).toBe("done");
    expect(patch.total_tokens).toBe(2000); // inherited, not reset to 0
    expect(patch.total_cost).toBeCloseTo(0.018);
    expect(patch.output).toBe("hi");
  });

  it("explodes retrievedDocuments into retrieval_documents rows (rank/score preserved)", () => {
    const events: IngestEvent[] = [
      {
        id: "t",
        type: "trace-create",
        timestamp: "2026-07-15T00:00:00.000Z",
        body: { id: "tr", environment: "default" },
      },
      {
        id: "s",
        type: "span-create",
        timestamp: "2026-07-15T00:00:00.000Z",
        body: {
          id: "sp",
          traceId: "tr",
          name: "retriever",
          environment: "default",
          startTime: "2026-07-15T00:00:00.000Z",
          retrievedDocuments: [
            { rank: 0, score: 0.9, content: "doc a", id: "a", metadata: { src: "kb" } },
            { rank: 1, score: 0.5, content: "doc b" },
          ],
        },
      },
    ];
    const { retrieval_documents } = mapEvents(PROJECT, events);
    expect(retrieval_documents).toHaveLength(2);
    expect(retrieval_documents[0]).toMatchObject({
      observation_id: "sp",
      trace_id: "tr",
      rank: 0,
      score: 0.9,
      doc_id: "a",
      content: "doc a",
    });
    expect(retrieval_documents[0]!.metadata).toContain("kb");
    expect(retrieval_documents[1]).toMatchObject({ rank: 1, score: 0.5, doc_id: "" });
  });

  it("maps an observation embedding into an embeddings row with the right dim", () => {
    const events: IngestEvent[] = [
      {
        id: "t",
        type: "trace-create",
        timestamp: "2026-07-15T00:00:00.000Z",
        body: { id: "tr", environment: "default" },
      },
      {
        id: "g",
        type: "generation-create",
        timestamp: "2026-07-15T00:00:00.000Z",
        body: {
          id: "ge",
          traceId: "tr",
          model: "text-embedding-3-small",
          environment: "default",
          startTime: "2026-07-15T00:00:00.000Z",
          embedding: [0.1, 0.2, 0.3, 0.4],
        },
      },
    ];
    const { embeddings } = mapEvents(PROJECT, events);
    expect(embeddings).toHaveLength(1);
    expect(embeddings[0]).toMatchObject({ observation_id: "ge", trace_id: "tr", kind: "OBSERVATION", dim: 4 });
    expect(embeddings[0]!.vector).toEqual([0.1, 0.2, 0.3, 0.4]);
  });

  it("produces no retrieval/embedding rows for a plain span", () => {
    const events: IngestEvent[] = [
      {
        id: "t",
        type: "trace-create",
        timestamp: "2026-07-15T00:00:00.000Z",
        body: { id: "tr", environment: "default" },
      },
      {
        id: "s",
        type: "span-create",
        timestamp: "2026-07-15T00:00:00.000Z",
        body: { id: "sp", traceId: "tr", environment: "default", startTime: "2026-07-15T00:00:00.000Z" },
      },
    ];
    const { retrieval_documents, embeddings } = mapEvents(PROJECT, events);
    expect(retrieval_documents).toHaveLength(0);
    expect(embeddings).toHaveLength(0);
  });
});

// Integration: full round-trip through the telemetry store. Skipped if it isn't reachable.
const storeReachable = await telemetry().ping();

describe.skipIf(!storeReachable)("ingest → telemetry store round-trip", () => {
  it("inserts mapped rows and reads them back", async () => {
    const store = telemetry();
    const traceId = `it-${Date.now()}`;
    const { traces, observations } = mapEvents(PROJECT, sampleBatch(traceId));
    await store.insertRows("traces", traces);
    await store.insertRows("observations", observations);

    const rows = await store.listObservationsByTrace(PROJECT, traceId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.total_tokens).toBe(2000);
    expect(rows[0]!.total_cost).toBeCloseTo(0.018, 4);
    expect(rows[0]!.latency_ms).toBe(1000);

    // cleanup (removes the trace, its observations, and any scores)
    await store.deleteTraces(PROJECT, [traceId]);
  });
});
