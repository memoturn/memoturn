import { describe, expect, it } from "vitest";
import {
  clampTokens,
  compileModelPrices,
  computeCost,
  MAX_EVENT_TOKENS,
  type ModelPriceOverride,
  providerForModel,
} from "./models.js";

describe("computeCost", () => {
  it("prices a known built-in model by token usage", () => {
    // claude-sonnet-4: 3 in / 15 out per 1M
    const cost = computeCost("claude-sonnet-4-5", 1_000_000, 1_000_000);
    expect(cost.inputCost).toBeCloseTo(3);
    expect(cost.outputCost).toBeCloseTo(15);
    expect(cost.totalCost).toBeCloseTo(18);
  });

  it("returns zero for unknown or missing models", () => {
    expect(computeCost(undefined, 100, 100)).toEqual({ inputCost: 0, outputCost: 0, totalCost: 0 });
    expect(computeCost("totally-made-up", 100, 100)).toEqual({ inputCost: 0, outputCost: 0, totalCost: 0 });
  });

  it("applies a project override ahead of the built-in registry", () => {
    const overrides = compileModelPrices([{ pattern: "^my-model", inputPerMTok: 10, outputPerMTok: 20 }]);
    const cost = computeCost("my-model-v1", 1_000_000, 1_000_000, overrides);
    expect(cost.inputCost).toBeCloseTo(10);
    expect(cost.outputCost).toBeCloseTo(20);
  });

  it("lets an override win over a built-in match (first match wins)", () => {
    const overrides = compileModelPrices([{ pattern: "^claude-sonnet-4", inputPerMTok: 1, outputPerMTok: 2 }]);
    const cost = computeCost("claude-sonnet-4-5", 1_000_000, 0, overrides);
    expect(cost.inputCost).toBeCloseTo(1); // override, not the built-in 3
  });
});

describe("clampTokens", () => {
  it("clamps negatives to 0 and caps absurd counts", () => {
    expect(clampTokens(-5)).toBe(0);
    expect(clampTokens(undefined)).toBe(0);
    expect(clampTokens(Number.NaN)).toBe(0);
    expect(clampTokens(1_000)).toBe(1_000);
    expect(clampTokens(MAX_EVENT_TOKENS + 1)).toBe(MAX_EVENT_TOKENS);
  });

  it("bounds cost so an absurd token count can't inflate billing", () => {
    const cost = computeCost("claude-sonnet-4-5", 1e18, 0);
    // input is capped at MAX_EVENT_TOKENS (10M) → 10 * 3/1M = 30
    expect(cost.inputCost).toBeCloseTo((MAX_EVENT_TOKENS / 1_000_000) * 3);
  });
});

describe("compileModelPrices", () => {
  it("drops invalid regex patterns", () => {
    const bad: ModelPriceOverride[] = [{ pattern: "[unterminated", inputPerMTok: 1, outputPerMTok: 1 }];
    expect(compileModelPrices(bad)).toHaveLength(0);
  });
});

describe("providerForModel", () => {
  it("resolves the built-in provider", () => {
    expect(providerForModel("gpt-4o-mini")).toBe("openai");
    expect(providerForModel("claude-opus-4-1")).toBe("anthropic");
  });

  it("uses an override's provider when matched", () => {
    const overrides = compileModelPrices([
      { pattern: "^local-", provider: "self-hosted", inputPerMTok: 0, outputPerMTok: 0 },
    ]);
    expect(providerForModel("local-llama", overrides)).toBe("self-hosted");
  });
});
