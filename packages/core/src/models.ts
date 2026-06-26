/**
 * Minimal model price registry for cost tracking. Prices are USD per 1M tokens.
 * Phase 3 replaces this with a DB-backed registry + custom model definitions, but
 * the worker uses it today to populate `input_cost` / `output_cost` / `total_cost`.
 */
export interface ModelPrice {
  match: RegExp;
  provider: string;
  inputPerMTok: number;
  outputPerMTok: number;
}

export const MODEL_PRICES: ModelPrice[] = [
  // Anthropic
  { match: /^claude-opus-4/i, provider: "anthropic", inputPerMTok: 15, outputPerMTok: 75 },
  { match: /^claude-sonnet-4/i, provider: "anthropic", inputPerMTok: 3, outputPerMTok: 15 },
  { match: /^claude-haiku-4/i, provider: "anthropic", inputPerMTok: 1, outputPerMTok: 5 },
  { match: /^claude-3-5-sonnet/i, provider: "anthropic", inputPerMTok: 3, outputPerMTok: 15 },
  // OpenAI
  { match: /^gpt-4o-mini/i, provider: "openai", inputPerMTok: 0.15, outputPerMTok: 0.6 },
  { match: /^gpt-4o/i, provider: "openai", inputPerMTok: 2.5, outputPerMTok: 10 },
  { match: /^gpt-4\.1-mini/i, provider: "openai", inputPerMTok: 0.4, outputPerMTok: 1.6 },
  { match: /^gpt-4\.1/i, provider: "openai", inputPerMTok: 2, outputPerMTok: 8 },
  { match: /^o3-mini/i, provider: "openai", inputPerMTok: 1.1, outputPerMTok: 4.4 },
];

export interface CostBreakdown {
  inputCost: number;
  outputCost: number;
  totalCost: number;
}

/**
 * Serializable price override (pattern is a regex source string) — what a project
 * stores in Postgres. Compile to `ModelPrice[]` with `compileModelPrices` before use.
 */
export interface ModelPriceOverride {
  pattern: string;
  provider?: string;
  inputPerMTok: number;
  outputPerMTok: number;
}

/** Compile stored overrides into matchable `ModelPrice` entries (bad patterns are dropped). */
export function compileModelPrices(overrides: ModelPriceOverride[]): ModelPrice[] {
  const compiled: ModelPrice[] = [];
  for (const o of overrides) {
    try {
      compiled.push({
        match: new RegExp(o.pattern, "i"),
        provider: o.provider ?? "",
        inputPerMTok: o.inputPerMTok,
        outputPerMTok: o.outputPerMTok,
      });
    } catch {
      // skip invalid regex patterns
    }
  }
  return compiled;
}

// Project overrides take precedence over the built-in registry (first match wins).
function priceTable(overrides?: ModelPrice[]): ModelPrice[] {
  return overrides?.length ? [...overrides, ...MODEL_PRICES] : MODEL_PRICES;
}

export function computeCost(
  model: string | undefined,
  promptTokens = 0,
  completionTokens = 0,
  overrides?: ModelPrice[],
): CostBreakdown {
  const zero = { inputCost: 0, outputCost: 0, totalCost: 0 };
  if (!model) return zero;
  const price = priceTable(overrides).find((p) => p.match.test(model));
  if (!price) return zero;
  const inputCost = (promptTokens / 1_000_000) * price.inputPerMTok;
  const outputCost = (completionTokens / 1_000_000) * price.outputPerMTok;
  return { inputCost, outputCost, totalCost: inputCost + outputCost };
}

export function providerForModel(model: string | undefined, overrides?: ModelPrice[]): string {
  if (!model) return "";
  return priceTable(overrides).find((p) => p.match.test(model))?.provider ?? "";
}
