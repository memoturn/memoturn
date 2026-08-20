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
  { match: /^claude-fable-5/i, provider: "anthropic", inputPerMTok: 10, outputPerMTok: 50 },
  { match: /^claude-opus-5/i, provider: "anthropic", inputPerMTok: 5, outputPerMTok: 25 },
  // Opus 4.5+ dropped to the $5/$25 tier; the catch-all below keeps 4 / 4.1 at legacy pricing.
  { match: /^claude-opus-4-[5-8]/i, provider: "anthropic", inputPerMTok: 5, outputPerMTok: 25 },
  { match: /^claude-opus-4/i, provider: "anthropic", inputPerMTok: 15, outputPerMTok: 75 },
  { match: /^claude-sonnet-5/i, provider: "anthropic", inputPerMTok: 3, outputPerMTok: 15 },
  { match: /^claude-sonnet-4/i, provider: "anthropic", inputPerMTok: 3, outputPerMTok: 15 },
  { match: /^claude-haiku-4/i, provider: "anthropic", inputPerMTok: 1, outputPerMTok: 5 },
  { match: /^claude-3-5-sonnet/i, provider: "anthropic", inputPerMTok: 3, outputPerMTok: 15 },
  // OpenAI (gpt-5.6 = Sol/Terra/Luna tiers; dotted families before the legacy ^gpt-5 catch-all)
  { match: /^gpt-5\.6-sol/i, provider: "openai", inputPerMTok: 5, outputPerMTok: 30 },
  { match: /^gpt-5\.6-terra/i, provider: "openai", inputPerMTok: 2, outputPerMTok: 12 },
  { match: /^gpt-5\.6-luna/i, provider: "openai", inputPerMTok: 0.2, outputPerMTok: 1.2 },
  { match: /^gpt-5\.5-pro/i, provider: "openai", inputPerMTok: 30, outputPerMTok: 180 },
  { match: /^gpt-5\.5-cyber/i, provider: "openai", inputPerMTok: 12.5, outputPerMTok: 75 },
  { match: /^gpt-5\.5/i, provider: "openai", inputPerMTok: 5, outputPerMTok: 30 },
  { match: /^gpt-5\.4-mini/i, provider: "openai", inputPerMTok: 0.75, outputPerMTok: 4.5 },
  { match: /^gpt-5\.4-nano/i, provider: "openai", inputPerMTok: 0.2, outputPerMTok: 1.25 },
  { match: /^gpt-5\.4-pro/i, provider: "openai", inputPerMTok: 30, outputPerMTok: 180 },
  { match: /^gpt-5\.4/i, provider: "openai", inputPerMTok: 2.5, outputPerMTok: 15 },
  { match: /^gpt-5-mini/i, provider: "openai", inputPerMTok: 0.25, outputPerMTok: 2 },
  { match: /^gpt-5-nano/i, provider: "openai", inputPerMTok: 0.05, outputPerMTok: 0.4 },
  { match: /^gpt-5/i, provider: "openai", inputPerMTok: 1.25, outputPerMTok: 10 },
  { match: /^gpt-4o-mini/i, provider: "openai", inputPerMTok: 0.15, outputPerMTok: 0.6 },
  { match: /^gpt-4o/i, provider: "openai", inputPerMTok: 2.5, outputPerMTok: 10 },
  { match: /^gpt-4\.1-mini/i, provider: "openai", inputPerMTok: 0.4, outputPerMTok: 1.6 },
  { match: /^gpt-4\.1/i, provider: "openai", inputPerMTok: 2, outputPerMTok: 8 },
  { match: /^o4-mini/i, provider: "openai", inputPerMTok: 1.1, outputPerMTok: 4.4 },
  { match: /^o3-mini/i, provider: "openai", inputPerMTok: 1.1, outputPerMTok: 4.4 },
  // Google Gemini (standard ≤200K-context tier)
  { match: /^gemini-3\.6-flash/i, provider: "gemini", inputPerMTok: 1.5, outputPerMTok: 7.5 },
  { match: /^gemini-3\.5-flash-lite/i, provider: "gemini", inputPerMTok: 0.3, outputPerMTok: 2.5 },
  { match: /^gemini-3\.5-flash/i, provider: "gemini", inputPerMTok: 1.5, outputPerMTok: 9 },
  { match: /^gemini-3\.1-pro/i, provider: "gemini", inputPerMTok: 2, outputPerMTok: 12 },
  { match: /^gemini-3-flash/i, provider: "gemini", inputPerMTok: 0.5, outputPerMTok: 3 },
  { match: /^gemini-3-pro/i, provider: "gemini", inputPerMTok: 2, outputPerMTok: 12 },
  { match: /^gemini-2\.5-pro/i, provider: "gemini", inputPerMTok: 1.25, outputPerMTok: 10 },
  { match: /^gemini-2\.5-flash-lite/i, provider: "gemini", inputPerMTok: 0.1, outputPerMTok: 0.4 },
  { match: /^gemini-2\.5-flash/i, provider: "gemini", inputPerMTok: 0.3, outputPerMTok: 2.5 },
  { match: /^gemini-2\.0-flash/i, provider: "gemini", inputPerMTok: 0.1, outputPerMTok: 0.4 },
  // AWS Bedrock (model ids are prefixed by vendor, optionally a region shard like `us.`)
  {
    match: /^(?:[a-z]{2}\.)?anthropic\.claude-(?:opus-5|opus-4-[5-8])/i,
    provider: "bedrock",
    inputPerMTok: 5,
    outputPerMTok: 25,
  },
  {
    match: /^(?:[a-z]{2}\.)?anthropic\.claude-(?:opus|3-opus)/i,
    provider: "bedrock",
    inputPerMTok: 15,
    outputPerMTok: 75,
  },
  {
    match: /^(?:[a-z]{2}\.)?anthropic\.claude-(?:sonnet|3-5-sonnet|3-sonnet)/i,
    provider: "bedrock",
    inputPerMTok: 3,
    outputPerMTok: 15,
  },
  {
    match: /^(?:[a-z]{2}\.)?anthropic\.claude-(?:haiku|3-5-haiku|3-haiku)/i,
    provider: "bedrock",
    inputPerMTok: 1,
    outputPerMTok: 5,
  },
  { match: /^(?:[a-z]{2}\.)?amazon\.nova-pro/i, provider: "bedrock", inputPerMTok: 0.8, outputPerMTok: 3.2 },
  { match: /^(?:[a-z]{2}\.)?amazon\.nova-lite/i, provider: "bedrock", inputPerMTok: 0.06, outputPerMTok: 0.24 },
  { match: /^(?:[a-z]{2}\.)?amazon\.nova-micro/i, provider: "bedrock", inputPerMTok: 0.035, outputPerMTok: 0.14 },
  // Azure OpenAI (deployments are commonly named after the base model)
  { match: /^azure\//i, provider: "azure", inputPerMTok: 2.5, outputPerMTok: 10 },
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

/**
 * Sanity cap for per-event token counts. A buggy/malicious SDK reporting billions of
 * tokens would inflate cost rollups and poison metrics, so values above this are clamped.
 */
export const MAX_EVENT_TOKENS = 10_000_000;

/** Clamp a token count into [0, MAX_EVENT_TOKENS]; returns the clamped value. */
export function clampTokens(n: number | undefined): number {
  if (!Number.isFinite(n ?? 0)) return 0;
  return Math.min(Math.max(0, Math.floor(n ?? 0)), MAX_EVENT_TOKENS);
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
  const pt = clampTokens(promptTokens);
  const ct = clampTokens(completionTokens);
  const inputCost = (pt / 1_000_000) * price.inputPerMTok;
  const outputCost = (ct / 1_000_000) * price.outputPerMTok;
  return { inputCost, outputCost, totalCost: inputCost + outputCost };
}

export function providerForModel(model: string | undefined, overrides?: ModelPrice[]): string {
  if (!model) return "";
  return priceTable(overrides).find((p) => p.match.test(model))?.provider ?? "";
}
