import type { IngestEvent } from "@memoturn/core";
import { clickhouse } from "@memoturn/db/clickhouse";
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
  });
});

// Integration: full round-trip through ClickHouse. Skipped if CH isn't reachable.
const chReachable = await clickhouse()
  .query({ query: "SELECT 1" })
  .then(() => true)
  .catch(() => false);

describe.skipIf(!chReachable)("ingest → ClickHouse round-trip", () => {
  it("inserts mapped rows and reads them back", async () => {
    const ch = clickhouse();
    const traceId = `it-${Date.now()}`;
    const { traces, observations } = mapEvents(PROJECT, sampleBatch(traceId));
    await ch.insert({ table: "traces", values: traces, format: "JSONEachRow" });
    await ch.insert({ table: "observations", values: observations, format: "JSONEachRow" });

    const rows = await ch
      .query({
        query: `SELECT total_tokens, round(total_cost, 4) AS cost FROM observations FINAL WHERE project_id = {p:String} AND trace_id = {t:String}`,
        query_params: { p: PROJECT, t: traceId },
        format: "JSONEachRow",
      })
      .then((r) => r.json<{ total_tokens: number; cost: number }>());

    expect(rows).toHaveLength(1);
    expect(Number(rows[0]!.total_tokens)).toBe(2000);
    expect(Number(rows[0]!.cost)).toBeCloseTo(0.018);

    // cleanup
    await ch.command({
      query: `DELETE FROM traces WHERE project_id = {p:String} AND id = {t:String}`,
      query_params: { p: PROJECT, t: traceId },
    });
    await ch.command({
      query: `DELETE FROM observations WHERE project_id = {p:String} AND trace_id = {t:String}`,
      query_params: { p: PROJECT, t: traceId },
    });
  });
});
