import { type ChatMessage, generate, type Provider } from "@memoturn/llm";
import { resolveProviderKey } from "./providers.js";

/**
 * Playground: resolve the project's provider key and run a one-shot chat completion
 * through the gateway. The "mock" provider works with no key for local testing.
 */
export interface PlaygroundInput {
  provider: Provider;
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
}

export async function runPlayground(projectId: string, input: PlaygroundInput) {
  const apiKey = await resolveProviderKey(projectId, input.provider);
  return generate({ ...input, apiKey });
}
