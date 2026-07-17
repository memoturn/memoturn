import type { Memoturn, MemoturnTrace } from "./client.js";

/** Model parameters worth recording — everything else (messages, system, tools, …) is payload. */
const MODEL_PARAMETER_ALLOWLIST = ["max_tokens", "temperature", "top_p", "top_k", "stop_sequences"] as const;

/**
 * Drop-in wrapper for the Anthropic SDK. Wraps `client.messages.create` so each call is
 * recorded as a memoturn generation (model, params, usage incl. cache tokens, latency, output).
 *
 *   const anthropic = wrapAnthropic(new Anthropic(), memoturn);
 *   await anthropic.messages.create({ model, max_tokens, messages });
 *
 * Pass `{ trace }` to nest generations under an existing trace; otherwise each call
 * gets its own trace.
 *
 * Limitation: streaming calls (`stream: true`) pass through unwrapped and are NOT recorded —
 * the SDK would have to consume the stream to observe usage/output.
 */
export function wrapAnthropic<T extends object>(
  client: T,
  memoturn: Memoturn,
  options: { trace?: MemoturnTrace; traceName?: string } = {},
): T {
  return new Proxy(client, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (prop === "messages") return wrapMessages(value, memoturn, options);
      return value;
    },
  });
}

function wrapMessages(messages: any, memoturn: Memoturn, options: { trace?: MemoturnTrace; traceName?: string }): any {
  return new Proxy(messages, {
    get(target, prop, receiver) {
      const original = Reflect.get(target, prop, receiver);
      if (prop !== "create" || typeof original !== "function") return original;

      return async function create(params: any, ...rest: any[]) {
        // Streaming responses can't be recorded without consuming the stream — pass through.
        if (params?.stream) return original.call(target, params, ...rest);

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

        try {
          const response = await original.call(target, params, ...rest);
          const usage = response?.usage;
          generation.end({
            output: response?.content ?? response,
            usage: usage
              ? {
                  promptTokens: usage.input_tokens,
                  completionTokens: usage.output_tokens,
                  totalTokens: (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0),
                  ...(usage.cache_read_input_tokens != null ? { cacheReadTokens: usage.cache_read_input_tokens } : {}),
                  ...(usage.cache_creation_input_tokens != null
                    ? { cacheCreationTokens: usage.cache_creation_input_tokens }
                    : {}),
                }
              : undefined,
          });
          return response;
        } catch (err) {
          generation.end({ level: "ERROR", statusMessage: String(err) });
          throw err;
        }
      };
    },
  });
}
