import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { generateText, streamText } from "ai";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Provider gateway — one entrypoint for chat completions used by the playground and
 * LLM-as-judge evaluators. Real providers go through the Vercel AI SDK; the "mock"
 * provider returns a deterministic response so the platform is fully testable without
 * API keys.
 */
export type Provider = "mock" | "anthropic" | "openai";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface GenerateInput {
  provider: Provider;
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  apiKey?: string;
}

export interface GenerateResult {
  provider: Provider;
  model: string;
  content: string;
  usage: { promptTokens: number; completionTokens: number; totalTokens: number };
}

const approxTokens = (s: string) => Math.max(1, Math.ceil(s.length / 4));

export async function generate(input: GenerateInput): Promise<GenerateResult> {
  const { provider, model, messages, temperature, maxTokens, apiKey } = input;

  if (provider === "mock") {
    const lastUser = [...messages].reverse().find((m) => m.role === "user")?.content ?? "";
    const content = `[mock:${model}] ${lastUser.slice(0, 400)}`;
    const promptTokens = messages.reduce((n, m) => n + approxTokens(m.content), 0);
    const completionTokens = approxTokens(content);
    return { provider, model, content, usage: { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens } };
  }

  if (!apiKey) throw new Error(`no API key configured for provider '${provider}'`);

  const languageModel =
    provider === "anthropic"
      ? createAnthropic({ apiKey })(model)
      : createOpenAI({ apiKey })(model);

  const result = await generateText({
    model: languageModel,
    messages: messages.map((m) => ({ role: m.role, content: m.content })),
    temperature,
    maxOutputTokens: maxTokens,
  });

  const u = result.usage as unknown as Record<string, number | undefined>;
  const promptTokens = u.inputTokens ?? u.promptTokens ?? 0;
  const completionTokens = u.outputTokens ?? u.completionTokens ?? 0;
  return {
    provider,
    model,
    content: result.text,
    usage: { promptTokens, completionTokens, totalTokens: u.totalTokens ?? promptTokens + completionTokens },
  };
}

/** Streaming variant — yields text deltas. Mock streams the canned reply word by word. */
export async function* generateStream(input: GenerateInput): AsyncGenerator<string> {
  const { provider, model, messages, temperature, maxTokens, apiKey } = input;

  if (provider === "mock") {
    const lastUser = [...messages].reverse().find((m) => m.role === "user")?.content ?? "";
    const content = `[mock:${model}] ${lastUser.slice(0, 400)}`;
    for (const word of content.split(" ")) {
      yield word + " ";
      await sleep(15);
    }
    return;
  }

  if (!apiKey) throw new Error(`no API key configured for provider '${provider}'`);
  const languageModel = provider === "anthropic" ? createAnthropic({ apiKey })(model) : createOpenAI({ apiKey })(model);
  const result = streamText({
    model: languageModel,
    messages: messages.map((m) => ({ role: m.role, content: m.content })),
    temperature,
    maxOutputTokens: maxTokens,
  });
  for await (const delta of result.textStream) yield delta;
}
