import { BRAND_MARKS, type BrandMark } from "./provider-icons.data";

/**
 * Brand marks for LLM model vendors, shown next to model/provider names in tables, lists,
 * charts, and the trace view. Monochrome (`currentColor`) so they read in both themes and add
 * no icon-runtime dependency (paths are inlined in provider-icons.data.ts).
 *
 * Resolution: an explicit provider string wins (matched to a brand slug, directly or via alias);
 * otherwise we infer the vendor from the model name. Unknown vendors render nothing — the caller's
 * text label still stands on its own.
 */

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

// Provider strings whose normalized form differs from the brand slug.
const ALIAS: Record<string, string> = {
  googleai: "gemini",
  googlegenerativeai: "gemini",
  googlevertex: "vertexai",
  vertex: "vertexai",
  azureopenai: "azure",
  amazon: "bedrock",
  aws: "bedrock",
  awsbedrock: "bedrock",
  x: "grok",
  hf: "huggingface",
  metallama: "meta",
  llama: "meta",
  mistralai: "mistral",
  moonshotai: "moonshot",
  "01ai": "yi",
  zerooneai: "yi",
  zhipuai: "zhipu",
  glm: "zhipu",
  ernie: "wenxin",
  alibaba: "qwen",
};

// Fallback inference from the model name when no (known) provider is set. Slugs must exist in BRAND_MARKS.
const BY_MODEL: [RegExp, string][] = [
  [/^claude/i, "anthropic"],
  [/^(gpt|o[134]\b|o[134]-|chatgpt|text-|davinci)/i, "openai"],
  [/^gemma/i, "gemma"],
  [/^gemini/i, "gemini"],
  [/^deepseek/i, "deepseek"],
  [/^(mistral|mixtral|codestral|ministral|magistral)/i, "mistral"],
  [/^(llama|meta-llama)/i, "meta"],
  [/^grok/i, "grok"],
  [/^(command|c4ai)/i, "cohere"],
  [/^(qwen|qwq)/i, "qwen"],
  [/^kimi/i, "kimi"],
  [/^moonshot/i, "moonshot"],
  [/^yi-/i, "yi"],
  [/^phi-/i, "microsoft"],
  [/^(sonar|pplx)/i, "perplexity"],
  [/^nemotron/i, "nvidia"],
  [/^glm/i, "zhipu"],
  [/^ernie/i, "wenxin"],
  [/^hunyuan/i, "hunyuan"],
  [/^doubao/i, "doubao"],
  [/^(minimax|abab)/i, "minimax"],
  [/^step-/i, "stepfun"],
  [/^baichuan/i, "baichuan"],
];

function resolveMark(provider?: string, model?: string): BrandMark | null {
  const p = provider ? norm(provider) : "";
  if (p) {
    if (BRAND_MARKS[p]) return BRAND_MARKS[p];
    const alias = ALIAS[p];
    if (alias && BRAND_MARKS[alias]) return BRAND_MARKS[alias];
  }
  const m = model?.trim();
  if (m) {
    for (const [re, slug] of BY_MODEL) if (re.test(m)) return BRAND_MARKS[slug] ?? null;
  }
  return null;
}

export function ProviderIcon({
  provider,
  model,
  size = 16,
  className,
}: {
  provider?: string;
  model?: string;
  size?: number;
  className?: string;
}) {
  const mark = resolveMark(provider, model);
  if (!mark) return null;
  return (
    <svg
      width={size}
      height={size}
      viewBox={mark.vb}
      fill="currentColor"
      className={className}
      style={{ flex: "none" }}
      aria-hidden="true"
    >
      {mark.d.map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}

/** Model name preceded by its vendor logo — the common table/list cell. */
export function ModelLabel({
  model,
  provider,
  size = 16,
  className,
}: {
  model: string;
  provider?: string;
  size?: number;
  className?: string;
}) {
  return (
    <span className={`inline-flex items-center gap-1.5 ${className ?? ""}`}>
      <ProviderIcon provider={provider} model={model} size={size} />
      <span className="truncate">{model}</span>
    </span>
  );
}
