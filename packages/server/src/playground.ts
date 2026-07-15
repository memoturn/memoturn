import { isoNow, newId } from "@memoturn/core";
import { type ChatMessage, generate, generateStream, type Provider, type ToolDef } from "@memoturn/llm";
import { submitBatch } from "./ingest.js";
import { resolveProviderConfig } from "./providers.js";
import { getTrace } from "./traces.js";

/**
 * Playground: resolve the project's provider key and run a one-shot chat completion
 * through the gateway. By default the run is also recorded as a trace (environment
 * "playground") so it shows up in observability; pass trace:false to skip.
 */
export interface PlaygroundInput {
  provider: Provider;
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  tools?: ToolDef[];
  responseFormat?: { type: "json_schema"; schema: Record<string, unknown> };
}

export async function runPlayground(projectId: string, input: PlaygroundInput, opts: { trace?: boolean } = {}) {
  const config = await resolveProviderConfig(projectId, input.provider);
  const result = await generate({ ...input, ...config });

  if (opts.trace === false) return result;

  const traceId = newId();
  const obsId = newId();
  const start = isoNow();
  await submitBatch(projectId, {
    batch: [
      {
        id: newId(),
        type: "trace-create",
        timestamp: start,
        body: { id: traceId, name: "playground", environment: "playground", input: input.messages },
      },
      {
        id: newId(),
        type: "generation-create",
        timestamp: start,
        body: {
          id: obsId,
          traceId,
          name: "playground.chat",
          model: input.model,
          provider: input.provider,
          environment: "playground",
          startTime: start,
          input: input.messages,
          modelParameters: { temperature: input.temperature, maxTokens: input.maxTokens },
        },
      },
      {
        id: newId(),
        type: "generation-update",
        timestamp: isoNow(),
        body: {
          id: obsId,
          traceId,
          environment: "playground",
          endTime: isoNow(),
          output: result.content,
          usage: result.usage,
        },
      },
    ],
  });

  return { ...result, traceId };
}

/**
 * Replay a stored trace through the LLM gateway and record the result as a new trace
 * (environment "playground"). Input messages are derived from the stored trace input:
 * - JSON array of {role, content} → used directly
 * - JSON object with a .messages array → that array is used
 * - Anything else → wrapped as a single user message
 * Provider/model fall back to "mock" / "mock-gpt-4o" when no overrides are given so the
 * replay always works without needing provider keys configured.
 * Returns null when the trace doesn't exist.
 */
/**
 * Derive chat messages from an arbitrary stored trace input / dataset item input:
 * - JSON array of {role, content} → used directly
 * - JSON object with a .messages array → that array is used
 * - a JSON string, or any other value → wrapped as a single user message
 * Shared by trace replay and the experiment runner so both interpret item/trace input
 * identically. Accepts a string (raw JSON) or an already-parsed value.
 */
export function messagesFromInput(input: unknown): ChatMessage[] {
  const wrap = (v: unknown): ChatMessage[] => {
    const content = typeof v === "string" ? v : JSON.stringify(v);
    return [{ role: "user", content: content || "(empty input)" }];
  };

  let value: unknown = input;
  if (typeof input === "string") {
    try {
      value = JSON.parse(input);
    } catch {
      return wrap(input);
    }
  }

  if (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((m) => m !== null && typeof m === "object" && "role" in m && "content" in m)
  ) {
    return value as ChatMessage[];
  }
  if (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Array.isArray((value as Record<string, unknown>).messages)
  ) {
    return (value as { messages: ChatMessage[] }).messages;
  }
  return wrap(value);
}

export async function replayTrace(
  projectId: string,
  traceId: string,
  overrides: { provider?: string; model?: string } = {},
) {
  const trace = await getTrace(projectId, traceId);
  if (!trace) return null;

  const messages = messagesFromInput(trace.input ?? "");
  const provider = (overrides.provider ?? "mock") as Provider;
  const model = overrides.model ?? "mock-gpt-4o";

  return runPlayground(projectId, { provider, model, messages });
}

/** Streaming playground — yields text deltas (no trace recording). */
export async function* streamPlayground(projectId: string, input: PlaygroundInput): AsyncGenerator<string> {
  const config = await resolveProviderConfig(projectId, input.provider);
  yield* generateStream({ ...input, ...config });
}
