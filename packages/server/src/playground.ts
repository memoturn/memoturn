import { isoNow, newId } from "@memoturn/core";
import { type ChatMessage, generate, generateStream, type Provider, type ToolDef } from "@memoturn/llm";
import { submitBatch } from "./ingest.js";
import { resolveProviderKey } from "./providers.js";
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
  const apiKey = await resolveProviderKey(projectId, input.provider);
  const result = await generate({ ...input, apiKey });

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
export async function replayTrace(
  projectId: string,
  traceId: string,
  overrides: { provider?: string; model?: string } = {},
) {
  const trace = await getTrace(projectId, traceId);
  if (!trace) return null;

  let messages: ChatMessage[] = [];
  const raw = trace.input ?? "";

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (
      Array.isArray(parsed) &&
      parsed.every((m) => m !== null && typeof m === "object" && "role" in m && "content" in m)
    ) {
      // [{role, content}, ...]
      messages = parsed as ChatMessage[];
    } else if (
      parsed !== null &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      Array.isArray((parsed as Record<string, unknown>).messages)
    ) {
      // {messages: [{role, content}, ...], ...}
      messages = (parsed as { messages: ChatMessage[] }).messages;
    } else {
      messages = [{ role: "user", content: raw || "(empty input)" }];
    }
  } catch {
    messages = [{ role: "user", content: raw || "(empty input)" }];
  }

  const provider = (overrides.provider ?? "mock") as Provider;
  const model = overrides.model ?? "mock-gpt-4o";

  return runPlayground(projectId, { provider, model, messages });
}

/** Streaming playground — yields text deltas (no trace recording). */
export async function* streamPlayground(projectId: string, input: PlaygroundInput): AsyncGenerator<string> {
  const apiKey = await resolveProviderKey(projectId, input.provider);
  yield* generateStream({ ...input, apiKey });
}
