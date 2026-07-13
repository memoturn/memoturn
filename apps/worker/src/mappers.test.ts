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
