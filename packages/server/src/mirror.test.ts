import { compileModelPrices } from "@memoturn/core";
import type { ObservationState, ScoreState, TraceState } from "@memoturn/db";
import { describe, expect, it } from "vitest";
import { diffMirror, mirrorObservationRow, mirrorScoreRow, mirrorTraceRow } from "./mirror.js";

const V = BigInt(Date.parse("2026-01-01T00:00:00.000Z"));
const traceState = (over: Partial<TraceState>): TraceState =>
  ({ projectId: "p", id: "t1", tags: [], stateVersion: V, ...over }) as unknown as TraceState;
const obsState = (over: Partial<ObservationState>): ObservationState =>
  ({ projectId: "p", id: "o1", stateVersion: V, ...over }) as unknown as ObservationState;
const scoreState = (over: Partial<ScoreState>): ScoreState =>
  ({ projectId: "p", id: "s1", stateVersion: V, ...over }) as unknown as ScoreState;

const prices = compileModelPrices([{ pattern: "^test-model$", provider: "acme", inputPerMTok: 1, outputPerMTok: 2 }]);

describe("mirrorTraceRow", () => {
  it("coalesces NULL columns to the mapper's defaults", () => {
    const r = mirrorTraceRow(traceState({ name: "Chat" }));
    expect(r).toMatchObject({
      id: "t1",
      name: "Chat",
      environment: "default",
      public: 0,
      metadata: "{}",
      input: "",
      output: "",
      tags: [],
    });
  });

  it("maps boolean public to 0/1", () => {
    expect(mirrorTraceRow(traceState({ public: true })).public).toBe(1);
  });
});

describe("mirrorObservationRow", () => {
  it("computes latency from start/end and cost from tokens + model price", () => {
    const r = mirrorObservationRow(
      obsState({
        model: "test-model",
        promptTokens: 1_000_000,
        completionTokens: 1_000_000,
        startTime: new Date("2026-01-01T00:00:00.000Z"),
        endTime: new Date("2026-01-01T00:00:02.500Z"),
      }),
      prices,
    );
    expect(r.latency_ms).toBe(2500);
    expect(r.input_cost).toBeCloseTo(1);
    expect(r.output_cost).toBeCloseTo(2);
    expect(r.total_cost).toBeCloseTo(3);
    expect(r.provider).toBe("acme"); // derived from the price entry when not stored
    expect(r.total_tokens).toBe(2_000_000); // defaulted to prompt + completion
  });

  it("latency is 0 with no end time, and defaults coalesce", () => {
    const r = mirrorObservationRow(obsState({ type: "SPAN" }), prices);
    expect(r.latency_ms).toBe(0);
    expect(r.end_time).toBeNull();
    expect(r.model_parameters).toBe("{}");
    expect(r.level).toBe("DEFAULT");
    expect(r.total_cost).toBe(0);
  });
});

describe("diffMirror", () => {
  const ignore = new Set(["event_ts", "timestamp"]);

  it("reports no diffs for equal rows (ignoring the excluded fields)", () => {
    const a = { id: "t1", name: "x", environment: "prod", event_ts: "A", timestamp: "A" };
    const b = { id: "t1", name: "x", environment: "prod", event_ts: "B", timestamp: "B" };
    expect(diffMirror(a, b, ignore)).toEqual([]);
  });

  it("reports the fields that differ", () => {
    const a = { id: "t1", name: "x", environment: "prod" };
    const b = { id: "t1", name: "y", environment: "default" };
    expect(diffMirror(a, b, ignore).sort()).toEqual(["environment", "name"]);
  });

  it("compares arrays by element and floats with tolerance", () => {
    expect(diffMirror({ tags: ["a", "b"], c: 0.1 + 0.2 }, { tags: ["a", "b"], c: 0.3 }, ignore)).toEqual([]);
    expect(diffMirror({ tags: ["a"] }, { tags: ["a", "b"] }, ignore)).toEqual(["tags"]);
  });
});

describe("mirrorScoreRow", () => {
  it("coalesces NULL source/dataType to defaults and preserves a null value", () => {
    const r = mirrorScoreRow(
      scoreState({ name: "quality", value: null, stringValue: "good", dataType: "CATEGORICAL" }),
    );
    expect(r).toMatchObject({
      name: "quality",
      source: "API",
      data_type: "CATEGORICAL",
      value: null,
      string_value: "good",
      comment: "",
    });
  });
});
