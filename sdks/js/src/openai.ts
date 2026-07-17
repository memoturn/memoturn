import type { Memoturn, MemoturnTrace } from "./client.js";
import { tapStream } from "./stream.js";

/**
 * Drop-in wrapper for the OpenAI SDK. Wraps both `client.chat.completions.create` and
 * `client.responses.create` so each call is recorded as a memoturn generation (model,
 * params, usage, latency, output) — including streaming calls (`stream: true`), which are
 * accumulated into the same output/usage shape as a non-streaming call while still being
 * yielded to the caller in real time (no buffering, no added latency).
 *
 *   const openai = wrapOpenAI(new OpenAI(), memoturn);
 *   await openai.chat.completions.create({ model, messages });
 *   await openai.responses.create({ model, input });
 *
 * Pass `{ trace }` to nest generations under an existing trace; otherwise each call
 * gets its own trace. Pass `{ streamTimeoutMs }` to override the idle-stream abandonment
 * backstop (default 120s).
 */
export function wrapOpenAI<T extends object>(
  client: T,
  memoturn: Memoturn,
  options: { trace?: MemoturnTrace; traceName?: string; streamTimeoutMs?: number } = {},
): T {
  return new Proxy(client, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (prop === "chat") return wrapChat(value, memoturn, options);
      if (prop === "responses") return wrapResponses(value, memoturn, options);
      return value;
    },
  });
}

type WrapOptions = { trace?: MemoturnTrace; traceName?: string; streamTimeoutMs?: number };

function wrapChat(chat: any, memoturn: Memoturn, options: WrapOptions): any {
  return new Proxy(chat, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (prop === "completions") return wrapCompletions(value, memoturn, options);
      return value;
    },
  });
}

/** Merge streamed chat-completion chunks into the same `{ output, usage }` shape the
 * non-streaming path records (`response.choices[0].message` + mapped usage). */
function createChatStreamAccumulator() {
  const choices = new Map<
    number,
    {
      role?: string;
      content: string;
      refusal: string;
      toolCalls: Map<number, { id?: string; type?: string; function: { name?: string; arguments: string } }>;
    }
  >();
  let usage: any;

  return {
    add(chunk: any) {
      if (chunk?.usage) usage = chunk.usage;
      for (const choice of chunk?.choices ?? []) {
        const index = choice.index ?? 0;
        let entry = choices.get(index);
        if (!entry) {
          entry = { content: "", refusal: "", toolCalls: new Map() };
          choices.set(index, entry);
        }
        const delta = choice.delta ?? {};
        if (delta.role) entry.role = delta.role;
        if (typeof delta.content === "string") entry.content += delta.content;
        if (typeof delta.refusal === "string") entry.refusal += delta.refusal;
        for (const toolCall of delta.tool_calls ?? []) {
          const tcIndex = toolCall.index ?? 0;
          let tc = entry.toolCalls.get(tcIndex);
          if (!tc) {
            tc = { function: { arguments: "" } };
            entry.toolCalls.set(tcIndex, tc);
          }
          if (toolCall.id) tc.id = toolCall.id;
          if (toolCall.type) tc.type = toolCall.type;
          if (toolCall.function?.name) tc.function.name = toolCall.function.name;
          if (typeof toolCall.function?.arguments === "string") tc.function.arguments += toolCall.function.arguments;
        }
      }
    },
    finalize() {
      const indexes = [...choices.keys()].sort((a, b) => a - b);
      const messages = indexes.map((i) => {
        const entry = choices.get(i)!;
        const message: any = { role: entry.role ?? "assistant", content: entry.content };
        if (entry.refusal) message.refusal = entry.refusal;
        if (entry.toolCalls.size > 0) {
          message.tool_calls = [...entry.toolCalls.keys()]
            .sort((a, b) => a - b)
            .map((idx) => {
              const tc = entry.toolCalls.get(idx)!;
              return {
                id: tc.id,
                type: tc.type,
                function: { name: tc.function.name, arguments: tc.function.arguments },
              };
            });
        }
        return message;
      });
      return {
        // Match the non-streaming shape: a single message object when there's one choice
        // (the common case), mirroring `response?.choices?.[0]?.message`.
        output: messages.length <= 1 ? messages[0] : messages,
        usage: usage
          ? {
              promptTokens: usage.prompt_tokens,
              completionTokens: usage.completion_tokens,
              totalTokens: usage.total_tokens,
            }
          : undefined,
      };
    },
  };
}

function wrapCompletions(completions: any, memoturn: Memoturn, options: WrapOptions): any {
  return new Proxy(completions, {
    get(target, prop, receiver) {
      const original = Reflect.get(target, prop, receiver);
      if (prop !== "create" || typeof original !== "function") return original;

      return async function create(params: any, ...rest: any[]) {
        const trace = options.trace ?? memoturn.trace({ name: options.traceName ?? "openai.chat" });
        const { model, messages, stream, stream_options, ...modelParameters } = params ?? {};
        const generation = trace.generation({
          name: "openai.chat.completions",
          model,
          provider: "openai",
          modelParameters,
          input: messages,
        });

        if (stream) {
          // Ask for a final usage-bearing chunk unless the caller already made an explicit
          // choice (including opting out with `include_usage: false`) — never override that.
          const streamParams =
            stream_options === undefined ? { ...params, stream_options: { include_usage: true } } : params;
          try {
            const response = await original.call(target, streamParams, ...rest);
            const accumulator = createChatStreamAccumulator();
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
        }

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

/** Extract the output from a (possibly streamed-to-completion) Responses API `Response`. */
function extractResponsesOutput(response: any): unknown {
  return response?.output_text ?? response?.output ?? response;
}

/** Map Responses API usage (`input_tokens`/`output_tokens`) to the recorded usage shape. */
function mapResponsesUsage(usage: any): Record<string, number> | undefined {
  return usage
    ? {
        promptTokens: usage.input_tokens,
        completionTokens: usage.output_tokens,
        totalTokens: usage.total_tokens,
      }
    : undefined;
}

/**
 * Wrap `responses.create` — OpenAI's Responses API. Request `input` (+ `instructions`)
 * becomes the generation input; the response's `output_text`/`output` items become the
 * output; `input_tokens`/`output_tokens` map to the usage fields. Without this, teams on
 * the Responses API get no generations recorded.
 *
 * Streaming (`stream: true`) is event-based: the terminal event (`response.completed` /
 * `response.failed` / `response.incomplete`) carries the full final `Response` object, which
 * is what gets recorded.
 */
function wrapResponses(responses: any, memoturn: Memoturn, options: WrapOptions): any {
  return new Proxy(responses, {
    get(target, prop, receiver) {
      const original = Reflect.get(target, prop, receiver);
      if (prop !== "create" || typeof original !== "function") return original;

      return async function create(params: any, ...rest: any[]) {
        const trace = options.trace ?? memoturn.trace({ name: options.traceName ?? "openai.responses" });
        const { model, input, instructions, stream, ...modelParameters } = params ?? {};
        const generation = trace.generation({
          name: "openai.responses",
          model,
          provider: "openai",
          modelParameters,
          // Keep `instructions` (system-equivalent) alongside the input when present.
          input: instructions != null ? { instructions, input } : input,
        });

        if (stream) {
          try {
            const response = await original.call(target, params, ...rest);
            let finalResponse: any;
            let sawTerminalEvent = false;
            let failed = false;
            return tapStream(
              response,
              {
                onChunk: (event: any) => {
                  if (event?.type === "response.completed" || event?.type === "response.incomplete") {
                    finalResponse = event.response;
                    sawTerminalEvent = true;
                  } else if (event?.type === "response.failed") {
                    finalResponse = event.response;
                    sawTerminalEvent = true;
                    failed = true;
                  }
                },
                onDone: (err, reason) => {
                  const output = extractResponsesOutput(finalResponse);
                  const usage = mapResponsesUsage(finalResponse?.usage);
                  if (reason === "abandoned") {
                    generation.end({
                      level: "WARNING",
                      statusMessage: "stream ended before completion",
                      output,
                      usage,
                    });
                  } else if (reason === "error" || failed || !sawTerminalEvent) {
                    generation.end({
                      level: "ERROR",
                      statusMessage: err
                        ? String(err)
                        : failed
                          ? "response.failed"
                          : "stream ended without a terminal event",
                      output,
                      usage,
                    });
                  } else {
                    generation.end({ output, usage });
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
          generation.end({ output: extractResponsesOutput(response), usage: mapResponsesUsage(response?.usage) });
          return response;
        } catch (err) {
          generation.end({ level: "ERROR", statusMessage: String(err) });
          throw err;
        }
      };
    },
  });
}
