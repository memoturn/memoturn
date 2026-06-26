import { isoNow, newId } from "@memoturn/core";
import { type ChatMessage, generate, generateStream, type Provider } from "@memoturn/llm";
import { submitBatch } from "./ingest.js";
import { resolveProviderKey } from "./providers.js";

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

/** Streaming playground — yields text deltas (no trace recording). */
export async function* streamPlayground(projectId: string, input: PlaygroundInput): AsyncGenerator<string> {
  const apiKey = await resolveProviderKey(projectId, input.provider);
  yield* generateStream({ ...input, apiKey });
}
