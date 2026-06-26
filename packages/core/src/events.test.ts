import { describe, expect, it } from "vitest";
import { ingestRequest } from "./events.js";
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

  it("rejects an unknown event type", () => {
    const parsed = ingestRequest.safeParse({
      batch: [{ id: "x", type: "nope", timestamp: "2026-06-25T00:00:00.000Z", body: {} }],
    });
    expect(parsed.success).toBe(false);
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
