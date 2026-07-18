import type { Memoturn, MemoturnTrace } from "./client.js";
import { tapStream } from "./stream.js";

/**
 * Drop-in wrapper for a Mistral client (`@mistralai/mistralai` v1+) — records `chat.complete`
 * and `chat.stream` calls as memoturn generations (model, params, usage, latency, output).
 *
 * Mistral's TS SDK is Speakeasy-generated: streaming is a **separate method** (`chat.stream`,
 * like Gemini) rather than a `stream: true` flag, each streamed event wraps the actual chunk in
 * a `.data` property (`CompletionEvent { data: CompletionChunk }`), and all response fields are
 * **camelCase** after the SDK's wire remap (`usage.promptTokens`, `delta.toolCalls`, …) — three
 * structural differences from the OpenAI-compatible wire API that make `wrapOpenAI`/`wrapGroq`
 * unusable against it, hence this dedicated wrapper.
 *
 *   const mistral = wrapMistral(new Mistral({ apiKey }), memoturn);
 *   await mistral.chat.complete({ model: "mistral-large-latest", messages });
 *
 * Pass `{ trace }` to nest generations under an existing trace; otherwise each call gets its
 * own trace. Pass `{ streamTimeoutMs }` to override the idle-stream abandonment backstop
 * (default 120s).
 */

type WrapOptions = { trace?: MemoturnTrace; traceName?: string; streamTimeoutMs?: number };

/** Mistral's SDK already remaps usage to camelCase — a straight 3-field passthrough. */
function mapUsage(usage: any): Record<string, number> | undefined {
  if (!usage) return undefined;
  return {
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    totalTokens: usage.totalTokens,
  };
}

/** Delta content is `string | ContentChunk[]` — flatten text parts either way. */
function deltaText(content: any): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part: any) => (typeof part === "string" ? part : (part?.text ?? ""))).join("");
  }
  return "";
}

/** Merge streamed `CompletionEvent`s (each wrapping a chunk in `.data`) into the same
 * `{ output, usage }` shape the non-streaming path records. */
function createMistralStreamAccumulator() {
  const choices: any[] = [];
  let usage: any;
  return {
    add(event: any) {
      const chunk = event?.data ?? event; // tolerate unwrapped chunks on SDK drift
      for (const choice of chunk?.choices ?? []) {
        const i = choice.index ?? 0;
        choices[i] = choices[i] ?? { role: undefined, content: "" };
        const delta = choice.delta ?? {};
        if (delta.role) choices[i].role = delta.role;
        if (delta.content != null) choices[i].content += deltaText(delta.content);
        if (delta.toolCalls) {
          choices[i].toolCalls = choices[i].toolCalls ?? [];
          for (const tc of delta.toolCalls) {
            const t = (choices[i].toolCalls[tc.index ?? 0] ??= {
              id: tc.id,
              type: tc.type,
              function: { name: "", arguments: "" },
            });
            if (tc.function?.name) t.function.name = tc.function.name;
            if (tc.function?.arguments) {
              // Arguments may stream as string fragments, or arrive whole as an object.
              if (typeof tc.function.arguments === "string") t.function.arguments += tc.function.arguments;
              else t.function.arguments = tc.function.arguments;
            }
          }
        }
      }
      if (chunk?.usage) usage = chunk.usage; // Mistral sends usage on the final chunk
    },
    finalize() {
      return { output: choices.length <= 1 ? choices[0] : choices, usage: mapUsage(usage) };
    },
  };
}

export function wrapMistral<T extends object>(client: T, memoturn: Memoturn, options: WrapOptions = {}): T {
  return new Proxy(client, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (prop === "chat") return wrapChat(value, memoturn, options);
      return value;
    },
  });
}

function wrapChat(chat: any, memoturn: Memoturn, options: WrapOptions): any {
  return new Proxy(chat, {
    get(target, prop, receiver) {
      const original = Reflect.get(target, prop, receiver);
      if ((prop !== "complete" && prop !== "stream") || typeof original !== "function") return original;
      const streaming = prop === "stream";

      return async function call(params: any, ...rest: any[]) {
        const trace = options.trace ?? memoturn.trace({ name: options.traceName ?? "mistral.chat" });
        const { model, messages, ...modelParameters } = params ?? {};
        const generation = trace.generation({
          name: "mistral.chat",
          model,
          provider: "mistral",
          modelParameters,
          input: messages,
        });
        try {
          const response = await original.call(target, params, ...rest);
          if (!streaming) {
            generation.end({
              output: response?.choices?.[0]?.message ?? response,
              usage: mapUsage(response?.usage),
            });
            return response;
          }
          const accumulator = createMistralStreamAccumulator();
          return tapStream(
            response,
            {
              onChunk: (event: any) => accumulator.add(event),
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
    },
  });
}
