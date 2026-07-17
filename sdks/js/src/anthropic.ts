import type { Memoturn, MemoturnTrace } from "./client.js";
import { tapStream } from "./stream.js";

/** Model parameters worth recording — everything else (messages, system, tools, …) is payload. */
const MODEL_PARAMETER_ALLOWLIST = ["max_tokens", "temperature", "top_p", "top_k", "stop_sequences"] as const;

/**
 * Drop-in wrapper for the Anthropic SDK. Wraps `client.messages.create` so each call is
 * recorded as a memoturn generation (model, params, usage incl. cache tokens, latency, output)
 * — including streaming calls (`stream: true`), which are accumulated into the same
 * output/usage shape as a non-streaming call while still being yielded to the caller in real
 * time (no buffering, no added latency).
 *
 *   const anthropic = wrapAnthropic(new Anthropic(), memoturn);
 *   await anthropic.messages.create({ model, max_tokens, messages });
 *
 * Pass `{ trace }` to nest generations under an existing trace; otherwise each call
 * gets its own trace. Pass `{ streamTimeoutMs }` to override the idle-stream abandonment
 * backstop (default 120s).
 */
export function wrapAnthropic<T extends object>(
  client: T,
  memoturn: Memoturn,
  options: { trace?: MemoturnTrace; traceName?: string; streamTimeoutMs?: number } = {},
): T {
  return new Proxy(client, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (prop === "messages") return wrapMessages(value, memoturn, options);
      return value;
    },
  });
}

/** Map Anthropic usage (incl. prompt-cache tokens) to the recorded usage shape — shared by
 * the non-streaming path and the stream accumulator's `.finalize()`. */
function mapAnthropicUsage(usage: any): Record<string, number> | undefined {
  if (!usage) return undefined;
  return {
    promptTokens: usage.input_tokens,
    completionTokens: usage.output_tokens,
    totalTokens: (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0),
    ...(usage.cache_read_input_tokens != null ? { cacheReadTokens: usage.cache_read_input_tokens } : {}),
    ...(usage.cache_creation_input_tokens != null ? { cacheCreationTokens: usage.cache_creation_input_tokens } : {}),
  };
}

/** Merge Anthropic streaming events (`message_start`/`content_block_*`/`message_delta`) into
 * the same `{ output, usage }` shape the non-streaming path records. */
function createAnthropicStreamAccumulator() {
  const blocks: Record<number, any> = {};
  const jsonBuffers: Record<number, string> = {};
  let usage: any;

  return {
    add(event: any) {
      switch (event?.type) {
        case "message_start": {
          if (event.message?.usage) usage = { ...usage, ...event.message.usage };
          break;
        }
        case "content_block_start": {
          blocks[event.index] = { ...event.content_block };
          break;
        }
        case "content_block_delta": {
          const block = (blocks[event.index] ??= {});
          const delta = event.delta ?? {};
          if (delta.type === "text_delta") {
            block.text = (block.text ?? "") + (delta.text ?? "");
          } else if (delta.type === "input_json_delta") {
            jsonBuffers[event.index] = (jsonBuffers[event.index] ?? "") + (delta.partial_json ?? "");
          } else if (delta.type === "thinking_delta") {
            block.thinking = (block.thinking ?? "") + (delta.thinking ?? "");
          } else if (delta.type === "signature_delta") {
            block.signature = delta.signature;
          } else {
            // Unknown/future delta type — merge whatever fields it carries as a best effort.
            for (const [k, v] of Object.entries(delta)) {
              if (k !== "type") block[k] = v;
            }
          }
          break;
        }
        case "content_block_stop": {
          const buffered = jsonBuffers[event.index];
          if (buffered !== undefined) {
            const block = (blocks[event.index] ??= {});
            try {
              block.input = JSON.parse(buffered);
            } catch {
              // Malformed/partial JSON — never throw out of the accumulator.
              block.input = buffered;
            }
            delete jsonBuffers[event.index];
          }
          break;
        }
        case "message_delta": {
          if (event.usage) usage = { ...usage, ...event.usage };
          break;
        }
        default:
          break; // message_stop and anything else: stream exhaustion is what tapStream detects.
      }
    },
    finalize() {
      const output = Object.keys(blocks)
        .map(Number)
        .sort((a, b) => a - b)
        .map((i) => blocks[i])
        .filter(Boolean);
      return { output, usage: mapAnthropicUsage(usage) };
    },
  };
}

function wrapMessages(
  messages: any,
  memoturn: Memoturn,
  options: { trace?: MemoturnTrace; traceName?: string; streamTimeoutMs?: number },
): any {
  return new Proxy(messages, {
    get(target, prop, receiver) {
      const original = Reflect.get(target, prop, receiver);
      if (prop !== "create" || typeof original !== "function") return original;

      return async function create(params: any, ...rest: any[]) {
        const trace = options.trace ?? memoturn.trace({ name: options.traceName ?? "anthropic.messages" });
        const modelParameters: Record<string, unknown> = {};
        for (const key of MODEL_PARAMETER_ALLOWLIST) {
          if (params?.[key] !== undefined) modelParameters[key] = params[key];
        }
        const generation = trace.generation({
          name: "anthropic.messages",
          model: params?.model,
          provider: "anthropic",
          modelParameters,
          // Keep `system` (system prompt) alongside the messages when present.
          input: params?.system != null ? { system: params.system, messages: params?.messages } : params?.messages,
        });

        if (params?.stream) {
          try {
            // Anthropic's streaming protocol always includes final usage in `message_delta`
            // — no `stream_options`-equivalent injection is needed to get usage.
            const response = await original.call(target, params, ...rest);
            const accumulator = createAnthropicStreamAccumulator();
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
        }

        try {
          const response = await original.call(target, params, ...rest);
          generation.end({ output: response?.content ?? response, usage: mapAnthropicUsage(response?.usage) });
          return response;
        } catch (err) {
          generation.end({ level: "ERROR", statusMessage: String(err) });
          throw err;
        }
      };
    },
  });
}
