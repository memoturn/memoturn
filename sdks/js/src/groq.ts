import type { Memoturn, MemoturnTrace } from "./client.js";
import { tapStream } from "./stream.js";

/**
 * Drop-in wrapper for a Groq client (`groq-sdk`) — records `chat.completions.create` as a
 * memoturn generation (model, params, usage, latency, output), including streaming calls.
 *
 * Groq's SDK is Stainless-generated and structurally close to `openai`'s own client, but its
 * `create()` has a strict, fully-enumerated parameter list with **no `stream_options` field
 * and no catch-all kwargs** — passing `stream_options` (as `wrapOpenAI` does on every streaming
 * call) raises `TypeError: create() got an unexpected keyword argument 'stream_options'` against
 * a real Groq client. That's why this is a small dedicated wrapper instead of just pointing
 * `wrapOpenAI` at a Groq client. Chat completions only — Groq has no Responses API.
 *
 *   const groq = wrapGroq(new Groq(), memoturn);
 *   await groq.chat.completions.create({ model, messages });
 *
 * Pass `{ trace }` to nest generations under an existing trace; otherwise each call gets its
 * own trace. Pass `{ streamTimeoutMs }` to override the idle-stream abandonment backstop
 * (default 120s).
 */

type WrapOptions = { trace?: MemoturnTrace; traceName?: string; streamTimeoutMs?: number };

/** Straight 3-field usage passthrough — Groq has no prompt-caching fields to map. */
function mapUsage(usage: any): Record<string, number> | undefined {
  if (!usage) return undefined;
  return {
    promptTokens: usage.prompt_tokens,
    completionTokens: usage.completion_tokens,
    totalTokens: usage.total_tokens,
  };
}

/** Merge streamed chat-completion chunks into the same `{ output, usage }` shape the
 * non-streaming path records — same style as `createChatStreamAccumulator` in ./openai.ts. */
function createGroqStreamAccumulator() {
  const choices: any[] = [];
  let usage: any;
  return {
    add(chunk: any) {
      for (const choice of chunk?.choices ?? []) {
        const i = choice.index ?? 0;
        choices[i] = choices[i] ?? { role: undefined, content: "" };
        const delta = choice.delta ?? {};
        if (delta.role) choices[i].role = delta.role;
        if (delta.content) choices[i].content += delta.content;
        if (delta.tool_calls) {
          choices[i].tool_calls = choices[i].tool_calls ?? [];
          for (const tc of delta.tool_calls) {
            const t = (choices[i].tool_calls[tc.index] ??= {
              id: tc.id,
              type: tc.type,
              function: { name: "", arguments: "" },
            });
            if (tc.function?.name) t.function.name = tc.function.name;
            if (tc.function?.arguments) t.function.arguments += tc.function.arguments;
          }
        }
      }
      if (chunk?.usage) usage = chunk.usage; // opportunistic — Groq doesn't document a request-side opt-in for this
    },
    finalize() {
      return { output: choices.length <= 1 ? choices[0] : choices, usage: mapUsage(usage) };
    },
  };
}

export function wrapGroq<T extends object>(client: T, memoturn: Memoturn, options: WrapOptions = {}): T {
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
      const value = Reflect.get(target, prop, receiver);
      if (prop !== "completions") return value;
      return new Proxy(value, {
        get(ctarget, cprop, creceiver) {
          const original = Reflect.get(ctarget, cprop, creceiver);
          if (cprop !== "create" || typeof original !== "function") return original;

          return async function create(params: any, ...rest: any[]) {
            const trace = options.trace ?? memoturn.trace({ name: options.traceName ?? "groq.chat" });
            const { model, messages, stream, ...modelParameters } = params ?? {};
            const generation = trace.generation({
              name: "groq.chat",
              model,
              provider: "groq",
              modelParameters,
              input: messages,
            });
            try {
              const response = await original.call(ctarget, params, ...rest);
              if (!stream) {
                generation.end({
                  output: response?.choices?.[0]?.message ?? response,
                  usage: mapUsage(response?.usage),
                });
                return response;
              }
              const accumulator = createGroqStreamAccumulator();
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
        },
      });
    },
  });
}
