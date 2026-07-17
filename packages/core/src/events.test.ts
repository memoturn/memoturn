import { describe, expect, it } from "vitest";
import { ingestRequest, scoreBody } from "./events.js";
import { computeCost } from "./models.js";

describe("ingestRequest", () => {
  it("accepts a valid trace + generation batch", () => {
    const parsed = ingestRequest.safeParse({
      batch: [
        {
          id: "evt-1",
          type: "trace-create",
          timestamp: "2026-06-25T00:00:00.000Z",
          body: { id: "trace-1", name: "demo", environment: "default" },
        },
        {
          id: "evt-2",
          type: "generation-create",
          timestamp: "2026-06-25T00:00:01.000Z",
          body: {
            id: "obs-1",
            traceId: "trace-1",
            model: "claude-sonnet-4-6",
            environment: "default",
            usage: { promptTokens: 100, completionTokens: 50 },
          },
        },
      ],
    });
    expect(parsed.success).toBe(true);
  });

  it("accepts a span body with an observationType override, and without one", () => {
    const withOverride = ingestRequest.safeParse({
      batch: [
        {
          id: "evt-1",
          type: "span-create",
          timestamp: "2026-06-25T00:00:00.000Z",
          body: { id: "obs-1", traceId: "trace-1", environment: "default", observationType: "TOOL" },
        },
      ],
    });
    expect(withOverride.success).toBe(true);

    const withoutOverride = ingestRequest.safeParse({
      batch: [
        {
          id: "evt-2",
          type: "span-create",
          timestamp: "2026-06-25T00:00:00.000Z",
          body: { id: "obs-2", traceId: "trace-1", environment: "default" },
        },
      ],
    });
    expect(withoutOverride.success).toBe(true);
  });

  it("rejects an invalid observationType override", () => {
    const parsed = ingestRequest.safeParse({
      batch: [
        {
          id: "evt-3",
          type: "span-create",
          timestamp: "2026-06-25T00:00:00.000Z",
          body: { id: "obs-3", traceId: "trace-1", environment: "default", observationType: "ROBOT" },
        },
      ],
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects an unknown event type", () => {
    const parsed = ingestRequest.safeParse({
      batch: [{ id: "x", type: "nope", timestamp: "2026-06-25T00:00:00.000Z", body: {} }],
    });
    expect(parsed.success).toBe(false);
  });
});

describe("scoreBody", () => {
  const base = { id: "score-1", traceId: "trace-1", name: "quality" };

  it("accepts CORRECTION and TEXT data types", () => {
    expect(scoreBody.safeParse({ ...base, dataType: "CORRECTION", stringValue: "fixed output" }).success).toBe(true);
    expect(scoreBody.safeParse({ ...base, dataType: "TEXT", stringValue: "looks good" }).success).toBe(true);
  });

  it("accepts a BOOLEAN score with value 0 or 1", () => {
    expect(scoreBody.safeParse({ ...base, dataType: "BOOLEAN", value: 0 }).success).toBe(true);
    expect(scoreBody.safeParse({ ...base, dataType: "BOOLEAN", value: 1 }).success).toBe(true);
  });

  it("rejects a BOOLEAN score with a value other than 0 or 1", () => {
    const parsed = scoreBody.safeParse({ ...base, dataType: "BOOLEAN", value: 2 });
    expect(parsed.success).toBe(false);
  });

  it("rejects a TEXT score exceeding the 500-char cap", () => {
    const parsed = scoreBody.safeParse({ ...base, dataType: "TEXT", stringValue: "x".repeat(501) });
    expect(parsed.success).toBe(false);
  });

  it("accepts a TEXT score at exactly the 500-char cap", () => {
    const parsed = scoreBody.safeParse({ ...base, dataType: "TEXT", stringValue: "x".repeat(500) });
    expect(parsed.success).toBe(true);
  });
});

describe("computeCost", () => {
  it("prices a known model", () => {
    const cost = computeCost("claude-sonnet-4-6", 1_000_000, 1_000_000);
    expect(cost.inputCost).toBeCloseTo(3);
    expect(cost.outputCost).toBeCloseTo(15);
    expect(cost.totalCost).toBeCloseTo(18);
  });

  it("returns zero for an unknown model", () => {
    expect(computeCost("mystery-model", 100, 100).totalCost).toBe(0);
  });
});
