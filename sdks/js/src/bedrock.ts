import type { Memoturn, MemoturnTrace } from "./client.js";
import { tapStream } from "./stream.js";

/** Model parameters worth recording — Bedrock's Converse API has a small, stable
 * `inferenceConfig` shape (unlike Gemini's large/evolving `config` bag), so this uses
 * the same allowlist philosophy as the Anthropic wrapper. */
const MODEL_PARAMETER_ALLOWLIST = ["maxTokens", "temperature", "topP", "stopSequences"] as const;

type WrapOptions = { trace?: MemoturnTrace; traceName?: string; streamTimeoutMs?: number };

/** Map Bedrock Converse usage (incl. prompt-cache tokens) to the recorded usage shape —
 * shared by the non-streaming path and the stream accumulator's `.finalize()`. */
function mapUsage(usage: any): Record<string, number> | undefined {
  if (!usage) return undefined;
  return {
    promptTokens: usage.inputTokens,
    completionTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
    ...(usage.cacheReadInputTokens != null ? { cacheReadTokens: usage.cacheReadInputTokens } : {}),
    ...(usage.cacheWriteInputTokens != null ? { cacheCreationTokens: usage.cacheWriteInputTokens } : {}),
  };
}

/** Build the recorded `input` (system + messages, mirroring Anthropic's own system+messages
 * shape, or bare messages when there's no system prompt) and the allowlisted `modelParameters`
 * extracted from `inferenceConfig`. */
function buildInput(input: any): { input: unknown; modelParameters: Record<string, unknown> } {
  const modelParameters: Record<string, unknown> = {};
  for (const key of MODEL_PARAMETER_ALLOWLIST) {
    const value = input?.inferenceConfig?.[key];
    if (value !== undefined) modelParameters[key] = value;
  }
  return {
    input: input?.system != null ? { system: input.system, messages: input?.messages } : input?.messages,
    modelParameters,
  };
}

/** Merge Bedrock ConverseStream events (`contentBlockStart`/`contentBlockDelta`/`metadata`)
 * into the same `{ output, usage }` shape the non-streaming path records — structurally
 * almost identical to `createAnthropicStreamAccumulator` in ./anthropic.ts. */
function createBedrockStreamAccumulator() {
  const blocks: Record<number, any> = {};
  let usage: any;

  return {
    add(event: any) {
      if (event?.contentBlockStart) {
        const { contentBlockIndex, start } = event.contentBlockStart;
        blocks[contentBlockIndex] = { ...start };
      }
      if (event?.contentBlockDelta) {
        const { contentBlockIndex, delta } = event.contentBlockDelta;
        const block = (blocks[contentBlockIndex] ??= {});
        if (delta?.text != null) {
          block.text = (block.text ?? "") + delta.text;
        } else if (delta) {
          // Non-text delta (e.g. toolUse, reasoningContent) — merge whatever fields it
          // carries as a best effort, same fallback the Anthropic accumulator uses.
          Object.assign(block, delta);
        }
      }
      if (event?.metadata?.usage) usage = event.metadata.usage;
    },
    finalize() {
      const output = Object.keys(blocks)
        .map(Number)
        .sort((a, b) => a - b)
        .map((i) => blocks[i])
        .filter(Boolean);
      return { output, usage: mapUsage(usage) };
    },
  };
}

/**
 * Drop-in wrapper for an AWS SDK v3 `BedrockRuntimeClient` — records `Converse`/
 * `ConverseStream` calls as memoturn generations (model, allowlisted `inferenceConfig`
 * params, usage incl. cache tokens, latency, output). **Only the standardized Converse
 * API is covered** — `InvokeModel`/`InvokeModelWithResponseStream` (raw, per-model-family
 * request/response bodies) are out of scope and pass through completely untouched; see
 * the README for details.
 *
 * Unlike every other wrapper in this package, AWS SDK v3 routes every operation through a
 * single `client.send(command)` call — there's no `client.converse(...)` method to
 * intercept. This wrapper proxies `.send` and inspects `command?.constructor?.name` (a
 * plain string comparison, not `instanceof` — this file never imports
 * `@aws-sdk/client-bedrock-runtime`) to decide whether to instrument the call.
 *
 *   const bedrock = wrapBedrock(new BedrockRuntimeClient({}), memoturn);
 *   await bedrock.send(new ConverseCommand({ modelId, messages }));
 *
 * Pass `{ trace }` to nest generations under an existing trace; otherwise each call gets
 * its own trace. Pass `{ streamTimeoutMs }` to override the idle-stream abandonment
 * backstop (default 120s).
 */
export function wrapBedrock<T extends object>(client: T, memoturn: Memoturn, options: WrapOptions = {}): T {
  return new Proxy(client, {
    get(target, prop, receiver) {
      const original = Reflect.get(target, prop, receiver);
      if (prop !== "send" || typeof original !== "function") return original;

      return async function send(command: any, ...rest: any[]) {
        const name = command?.constructor?.name;
        if (name !== "ConverseCommand" && name !== "ConverseStreamCommand") {
          return (original as (...args: any[]) => any).call(target, command, ...rest);
        }

        const input = command.input ?? {};
        const trace = options.trace ?? memoturn.trace({ name: options.traceName ?? "bedrock.converse" });
        const { input: recordedInput, modelParameters } = buildInput(input);
        const generation = trace.generation({
          name: name === "ConverseStreamCommand" ? "bedrock.converseStream" : "bedrock.converse",
          model: input.modelId,
          provider: "bedrock",
          modelParameters,
          input: recordedInput,
        });

        try {
          const response = await (original as (...args: any[]) => Promise<any>).call(target, command, ...rest);

          if (name === "ConverseCommand") {
            generation.end({ output: response?.output?.message, usage: mapUsage(response?.usage) });
            return response;
          }

          const accumulator = createBedrockStreamAccumulator();
          return {
            ...response,
            stream: tapStream(
              response.stream,
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
            ),
          };
        } catch (err) {
          generation.end({ level: "ERROR", statusMessage: String(err) });
          throw err;
        }
      };
    },
  });
}
