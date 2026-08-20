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

  it("prices the current model generation", () => {
    expect(computeCost("claude-opus-5", 1_000_000, 1_000_000).totalCost).toBeCloseTo(30); // 5 + 25
    expect(computeCost("claude-sonnet-5", 1_000_000, 1_000_000).totalCost).toBeCloseTo(18); // 3 + 15
    expect(computeCost("gpt-5.6-terra", 1_000_000, 1_000_000).totalCost).toBeCloseTo(14); // 2 + 12
    expect(computeCost("gpt-5.6-sol", 1_000_000, 1_000_000).totalCost).toBeCloseTo(35); // 5 + 30
    expect(computeCost("gemini-3.1-pro-preview", 1_000_000, 1_000_000).totalCost).toBeCloseTo(14); // 2 + 12
    expect(computeCost("gemini-3.5-flash", 1_000_000, 1_000_000).totalCost).toBeCloseTo(10.5); // 1.5 + 9
  });

  it("keeps dotted gpt-5.x families ahead of the legacy ^gpt-5 catch-all", () => {
    // Ordering regression: /^gpt-5/ must not shadow the dotted families.
    expect(computeCost("gpt-5.6-luna", 1_000_000, 1_000_000).totalCost).toBeCloseTo(1.4); // 0.2 + 1.2
    expect(computeCost("gpt-5.4", 1_000_000, 1_000_000).totalCost).toBeCloseTo(17.5); // 2.5 + 15
    expect(computeCost("gpt-5", 1_000_000, 1_000_000).totalCost).toBeCloseTo(11.25); // legacy 1.25 + 10
    expect(computeCost("gpt-5-mini", 1_000_000, 1_000_000).totalCost).toBeCloseTo(2.25); // 0.25 + 2
  });

  it("prices opus 4.5+ at the $5/$25 tier without disturbing legacy opus 4/4.1", () => {
    // Regression: the ^claude-opus-4 catch-all used to shadow 4.5-4.8 at legacy $15/$75.
    expect(computeCost("claude-opus-4-8", 1_000_000, 0).inputCost).toBeCloseTo(5);
    expect(computeCost("claude-opus-4-5", 1_000_000, 0).inputCost).toBeCloseTo(5);
    expect(computeCost("claude-opus-4-1", 1_000_000, 0).inputCost).toBeCloseTo(15);
    expect(computeCost("us.anthropic.claude-opus-5", 1_000_000, 0).inputCost).toBeCloseTo(5);
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
    expect(providerForModel("claude-opus-5")).toBe("anthropic");
    expect(providerForModel("gpt-5.6-sol")).toBe("openai");
    expect(providerForModel("gemini-3.5-flash")).toBe("gemini");
  });

  it("uses an override's provider when matched", () => {
    const overrides = compileModelPrices([
      { pattern: "^local-", provider: "self-hosted", inputPerMTok: 0, outputPerMTok: 0 },
    ]);
    expect(providerForModel("local-llama", overrides)).toBe("self-hosted");
  });
});
