import type { Memoturn, MemoturnTrace } from "./client.js";

/**
 * Drop-in wrapper for the OpenAI SDK. Wraps `client.chat.completions.create` so each
 * call is recorded as a memoturn generation (model, params, usage, latency, output).
 *
 *   const openai = wrapOpenAI(new OpenAI(), memoturn);
 *   await openai.chat.completions.create({ model, messages });
 *
 * Pass `{ trace }` to nest generations under an existing trace; otherwise each call
 * gets its own trace.
 */
export function wrapOpenAI<T extends object>(
  client: T,
  memoturn: Memoturn,
  options: { trace?: MemoturnTrace; traceName?: string } = {},
): T {
  return new Proxy(client, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (prop === "chat") return wrapChat(value, memoturn, options);
      return value;
    },
  });
}

function wrapChat(chat: any, memoturn: Memoturn, options: { trace?: MemoturnTrace; traceName?: string }): any {
  return new Proxy(chat, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (prop === "completions") return wrapCompletions(value, memoturn, options);
      return value;
    },
  });
}

function wrapCompletions(
  completions: any,
  memoturn: Memoturn,
  options: { trace?: MemoturnTrace; traceName?: string },
): any {
  return new Proxy(completions, {
    get(target, prop, receiver) {
      const original = Reflect.get(target, prop, receiver);
      if (prop !== "create" || typeof original !== "function") return original;

      return async function create(params: any, ...rest: any[]) {
        const trace = options.trace ?? memoturn.trace({ name: options.traceName ?? "openai.chat" });
        const { model, messages, ...modelParameters } = params ?? {};
        const generation = trace.generation({
          name: "openai.chat.completions",
          model,
          provider: "openai",
          modelParameters,
          input: messages,
        });

        try {
          const response = await original.call(target, params, ...rest);
          generation.end({
            output: response?.choices?.[0]?.message ?? response,
            usage: response?.usage
              ? {
                  promptTokens: response.usage.prompt_tokens,
                  completionTokens: response.usage.completion_tokens,
                  totalTokens: response.usage.total_tokens,
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
