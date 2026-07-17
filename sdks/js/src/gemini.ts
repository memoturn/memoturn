import type { Memoturn, MemoturnTrace } from "./client.js";
import { tapStream } from "./stream.js";

/**
 * Drop-in wrapper for the Google Gemini SDK (`@google/genai`). Wraps both
 * `client.models.generateContent` and `client.models.generateContentStream` so each call is
 * recorded as a memoturn generation (model, params, usage, latency, output).
 *
 * Structurally different from OpenAI/Anthropic: Gemini has **no `stream: true` flag** —
 * streaming is a completely separate, always-streaming method, wrapped independently from the
 * non-streaming one. Each yielded chunk is a *full* response object (the same shape as the
 * non-streaming return value), not a distinct delta type: `.text` per chunk is an incremental
 * delta (concatenated across chunks for `output`), while `.usageMetadata` is cumulative in
 * Gemini's protocol — the latest non-null one is taken as-is, never accumulated manually.
 *
 *   const gemini = wrapGemini(new GoogleGenAI({ apiKey }), memoturn);
 *   await gemini.models.generateContent({ model, contents, config });
 *   await gemini.models.generateContentStream({ model, contents, config });
 *
 * Pass `{ trace }` to nest generations under an existing trace; otherwise each call gets its
 * own trace. Pass `{ streamTimeoutMs }` to override the idle-stream abandonment backstop
 * (default 120s).
 */
export function wrapGemini<T extends object>(client: T, memoturn: Memoturn, options: WrapOptions = {}): T {
  return new Proxy(client, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (prop === "models") return wrapModels(value, memoturn, options);
      return value;
    },
  });
}

type WrapOptions = { trace?: MemoturnTrace; traceName?: string; streamTimeoutMs?: number };

/** Split Gemini's nested `config` into the recorded `input` (systemInstruction promoted
 * alongside `contents`, mirroring Anthropic's `system` + `messages` combined input) and
 * `modelParameters` (everything else in `config` — OpenAI's exclusion philosophy, applied
 * to `config` instead of flat kwargs, since Gemini's config surface is large/unstable
 * rather than the small fixed set an allowlist fits). */
function splitConfigInput(
  contents: unknown,
  config: any,
): { input: unknown; modelParameters: Record<string, unknown> } {
  const { systemInstruction, ...modelParameters } = config ?? {};
  return {
    input: systemInstruction != null ? { systemInstruction, contents } : contents,
    modelParameters,
  };
}

function extractGeminiOutput(response: any): unknown {
  return response?.text ?? response?.candidates ?? response;
}

function mapGeminiUsage(usage: any): Record<string, number> | undefined {
  if (!usage) return undefined;
  const promptTokens = usage.promptTokenCount;
  const completionTokens = usage.candidatesTokenCount;
  return {
    promptTokens,
    completionTokens,
    ...(promptTokens != null && completionTokens != null ? { totalTokens: promptTokens + completionTokens } : {}),
    ...(usage.cachedContentTokenCount != null ? { cacheReadTokens: usage.cachedContentTokenCount } : {}),
  };
}

/** Merge streamed Gemini response chunks into the same `{ output, usage }` shape the
 * non-streaming path records. Each chunk is a full response object: `.text` is an
 * incremental delta (concatenated), `.usageMetadata` is cumulative (latest wins). */
function createGeminiStreamAccumulator() {
  let text = "";
  let sawText = false;
  let usage: any;
  return {
    add(chunk: any) {
      if (typeof chunk?.text === "string") {
        text += chunk.text;
        sawText = true;
      }
      if (chunk?.usageMetadata) usage = chunk.usageMetadata;
    },
    finalize() {
      return { output: sawText ? text : undefined, usage: mapGeminiUsage(usage) };
    },
  };
}

function wrapModels(models: any, memoturn: Memoturn, options: WrapOptions): any {
  return new Proxy(models, {
    get(target, prop, receiver) {
      const original = Reflect.get(target, prop, receiver);

      if (prop === "generateContent" && typeof original === "function") {
        return async function generateContent(params: any, ...rest: any[]) {
          const trace = options.trace ?? memoturn.trace({ name: options.traceName ?? "gemini.generateContent" });
          const { model, contents, config } = params ?? {};
          const { input, modelParameters } = splitConfigInput(contents, config);
          const generation = trace.generation({
            name: "gemini.generateContent",
            model,
            provider: "gemini",
            modelParameters,
            input,
          });
          try {
            const response = await original.call(target, params, ...rest);
            generation.end({
              output: extractGeminiOutput(response),
              usage: mapGeminiUsage(response?.usageMetadata),
            });
            return response;
          } catch (err) {
            generation.end({ level: "ERROR", statusMessage: String(err) });
            throw err;
          }
        };
      }

      if (prop === "generateContentStream" && typeof original === "function") {
        return async function generateContentStream(params: any, ...rest: any[]) {
          const trace = options.trace ?? memoturn.trace({ name: options.traceName ?? "gemini.generateContentStream" });
          const { model, contents, config } = params ?? {};
          const { input, modelParameters } = splitConfigInput(contents, config);
          const generation = trace.generation({
            name: "gemini.generateContentStream",
            model,
            provider: "gemini",
            modelParameters,
            input,
          });
          try {
            const response = await original.call(target, params, ...rest);
            const accumulator = createGeminiStreamAccumulator();
            return tapStream(
              response,
              {
                onChunk: (chunk: any) => accumulator.add(chunk),
                onDone: (err, reason) => {
                  if (reason === "error") {
                    generation.end({ level: "ERROR", statusMessage: String(err), ...accumulator.finalize() });
                  } else if (reason === "abandoned") {
                    generation.end({
                      level: "WARNING",
                      statusMessage: "stream ended before completion",
                      ...accumulator.finalize(),
                    });
                  } else {
                    generation.end({ ...accumulator.finalize() });
                  }
                },
              },
              { idleTimeoutMs: options.streamTimeoutMs },
            );
          } catch (err) {
            generation.end({ level: "ERROR", statusMessage: String(err) });
            throw err;
          }
        };
      }

      return original;
    },
  });
}
