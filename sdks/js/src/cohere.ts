import type { Memoturn, MemoturnTrace } from "./client.js";
import { tapStream } from "./stream.js";

/**
 * Drop-in wrapper for a Cohere client (`cohere-ai` v7+) — records the chat surface as memoturn
 * generations (model, params, usage, latency, output), across both API generations:
 *
 * - **v1** (`CohereClient`): `client.chat(...)` / `client.chatStream(...)` — response is
 *   `{ text, meta: { tokens } }`, streamed events carry `eventType` (`"text-generation"` deltas,
 *   final `"stream-end"` with the full response).
 * - **v2** (`CohereClientV2`, or the `client.v2` namespace on a v1 client): `chat(...)` /
 *   `chatStream(...)` — response is `{ message: { content: [...] }, usage: { tokens } }`,
 *   streamed events carry `type` (`"content-delta"` deltas, final `"message-end"` with usage).
 *
 * Because `CohereClientV2` serves v2 shapes from the same top-level `chat`/`chatStream` method
 * names, the wrapper sniffs the response/event shape rather than assuming one per method — both
 * client classes and the `client.v2` namespace are covered by the same interception. Cohere
 * reports `inputTokens`/`outputTokens` with no total; `totalTokens` is computed as their sum
 * when both are present.
 *
 *   const cohere = wrapCohere(new CohereClientV2({ token }), memoturn);
 *   await cohere.chat({ model: "command-a-03-2025", messages });
 *
 * Pass `{ trace }` to nest generations under an existing trace; otherwise each call gets its
 * own trace. Pass `{ streamTimeoutMs }` to override the idle-stream abandonment backstop
 * (default 120s).
 */

type WrapOptions = { trace?: MemoturnTrace; traceName?: string; streamTimeoutMs?: number };

/** Cohere reports `inputTokens`/`outputTokens` (no total) — map and sum when both present. */
function mapUsage(tokens: any): Record<string, number> | undefined {
  if (!tokens) return undefined;
  const usage: Record<string, number> = {};
  if (typeof tokens.inputTokens === "number") usage.promptTokens = tokens.inputTokens;
  if (typeof tokens.outputTokens === "number") usage.completionTokens = tokens.outputTokens;
  if (typeof tokens.inputTokens === "number" && typeof tokens.outputTokens === "number") {
    usage.totalTokens = tokens.inputTokens + tokens.outputTokens;
  }
  return Object.keys(usage).length > 0 ? usage : undefined;
}

/** v2 requests carry `messages`; v1 carries `message` (+ optional `chatHistory`, folded in). */
function extractInput(params: any): unknown {
  if (params?.messages) return params.messages;
  if (Array.isArray(params?.chatHistory) && params.chatHistory.length > 0) {
    return [...params.chatHistory, { role: "USER", message: params?.message }];
  }
  return params?.message;
}

/** Exclusion-list model parameters — everything except the model/input fields of either shape. */
function extractModelParameters(params: any): Record<string, unknown> {
  const { model, message, messages, chatHistory, ...modelParameters } = params ?? {};
  return modelParameters;
}

/** v2 responses carry `message` + `usage.tokens`; v1 carry `text` + `meta.tokens`. */
function extractOutput(response: any): unknown {
  return response?.message ?? response?.text ?? response;
}

function extractUsage(response: any): Record<string, number> | undefined {
  return mapUsage(response?.usage?.tokens ?? response?.meta?.tokens);
}

/** Merge streamed events of either API generation into `{ output, usage }`. v1 events are
 * `eventType`-discriminated (`text-generation` text deltas, `stream-end` with the full response);
 * v2 events are `type`-discriminated (`content-delta` at `delta.message.content.text`,
 * `message-end` with `delta.usage`). The output mirrors the matching non-streaming shape. */
function createCohereStreamAccumulator() {
  let text = "";
  let v1Final: any;
  let v2Usage: any;
  let sawV2 = false;
  return {
    add(event: any) {
      const kind = event?.eventType ?? event?.type;
      if (kind === "text-generation" && typeof event?.text === "string") {
        text += event.text;
      } else if (kind === "stream-end") {
        v1Final = event?.response;
      } else if (kind === "content-delta") {
        sawV2 = true;
        const t = event?.delta?.message?.content?.text;
        if (typeof t === "string") text += t;
      } else if (kind === "message-end") {
        sawV2 = true;
        if (event?.delta?.usage) v2Usage = event.delta.usage;
      }
    },
    finalize() {
      if (sawV2) {
        return {
          output: { role: "assistant", content: [{ type: "text", text }] },
          usage: mapUsage(v2Usage?.tokens),
        };
      }
      return { output: v1Final?.text ?? text, usage: mapUsage(v1Final?.meta?.tokens) };
    },
  };
}

function instrument(
  target: any,
  original: (...args: any[]) => any,
  memoturn: Memoturn,
  options: WrapOptions,
  name: string,
  streaming: boolean,
) {
  return async function call(params: any, ...rest: any[]) {
    const trace = options.trace ?? memoturn.trace({ name: options.traceName ?? "cohere.chat" });
    const generation = trace.generation({
      name,
      model: params?.model,
      provider: "cohere",
      modelParameters: extractModelParameters(params),
      input: extractInput(params),
    });
    try {
      const response = await original.call(target, params, ...rest);
      if (!streaming) {
        generation.end({ output: extractOutput(response), usage: extractUsage(response) });
        return response;
      }
      const accumulator = createCohereStreamAccumulator();
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
}

function wrapChatSurface(target: any, memoturn: Memoturn, options: WrapOptions, namePrefix: string): any {
  return new Proxy(target, {
    get(t, prop, receiver) {
      const value = Reflect.get(t, prop, receiver);
      if (prop === "chat" && typeof value === "function") {
        return instrument(t, value, memoturn, options, `${namePrefix}.chat`, false);
      }
      if (prop === "chatStream" && typeof value === "function") {
        return instrument(t, value, memoturn, options, `${namePrefix}.chat`, true);
      }
      if (prop === "v2" && namePrefix === "cohere" && value && typeof value === "object") {
        return wrapChatSurface(value, memoturn, options, "cohere.v2");
      }
      return value;
    },
  });
}

export function wrapCohere<T extends object>(client: T, memoturn: Memoturn, options: WrapOptions = {}): T {
  return wrapChatSurface(client, memoturn, options, "cohere");
}
