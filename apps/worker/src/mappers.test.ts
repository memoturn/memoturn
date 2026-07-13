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
