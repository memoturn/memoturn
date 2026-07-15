import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createAzure } from "@ai-sdk/azure";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { generateObject, generateText, jsonSchema, type LanguageModel, streamText, tool } from "ai";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Provider gateway — one entrypoint for chat completions used by the playground and
 * LLM-as-judge evaluators. Real providers go through the Vercel AI SDK; the "mock"
 * provider returns a deterministic response so the platform is fully testable without
 * API keys.
 *
 * `openai_compatible` covers any OpenAI-shaped endpoint (vLLM / Ollama / OpenRouter)
 * via a custom baseUrl; `bedrock` uses a bearer apiKey + region; `azure` uses an apiKey
 * + resource baseUrl.
 */
export type Provider = "mock" | "anthropic" | "openai" | "gemini" | "bedrock" | "azure" | "openai_compatible";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ToolDef {
  name: string;
  description?: string;
  parameters: Record<string, unknown>; // JSON Schema for the tool arguments
}

export interface GenerateInput {
  provider: Provider;
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  apiKey?: string;
  /** Custom endpoint (openai_compatible, azure) or provider host override. */
  baseUrl?: string;
  /** AWS region (bedrock). */
  region?: string;
  tools?: ToolDef[];
  /** When set, the model returns an object matching this JSON Schema (structured output). */
  responseFormat?: { type: "json_schema"; schema: Record<string, unknown> };
}

/** Provider-specific connection config resolved from a stored connection or env. */
export interface ProviderConfig {
  apiKey?: string;
  baseUrl?: string;
  region?: string;
}

/**
 * Build a Vercel AI SDK language model for a real (non-mock) provider. Throws if the
 * required credential is missing. Kept in one place so `generate` and `generateStream`
 * dispatch identically.
 */
function languageModelFor(provider: Provider, model: string, config: ProviderConfig): LanguageModel {
  const { apiKey, baseUrl, region } = config;
  switch (provider) {
    case "anthropic":
      if (!apiKey) throw new Error("no API key configured for provider 'anthropic'");
      return createAnthropic({ apiKey })(model);
    case "openai":
      if (!apiKey) throw new Error("no API key configured for provider 'openai'");
      return createOpenAI({ apiKey })(model);
    case "gemini":
      if (!apiKey) throw new Error("no API key configured for provider 'gemini'");
      return createGoogleGenerativeAI({ apiKey })(model);
    case "bedrock":
      if (!apiKey) throw new Error("no API key configured for provider 'bedrock'");
      return createAmazonBedrock({ apiKey, region: region ?? "us-east-1" })(model);
    case "azure":
      if (!apiKey) throw new Error("no API key configured for provider 'azure'");
      return createAzure({ apiKey, ...(baseUrl ? { baseURL: baseUrl } : {}) })(model);
    case "openai_compatible":
      if (!baseUrl) throw new Error("no baseUrl configured for provider 'openai_compatible'");
      // Many self-hosted OpenAI-compatible servers (vLLM/Ollama) accept any/empty key.
      return createOpenAI({ apiKey: apiKey ?? "not-needed", baseURL: baseUrl })(model);
    default:
      throw new Error(`unsupported provider '${provider}'`);
  }
}

export interface GenerateResult {
  provider: Provider;
  model: string;
  content: string;
  usage: { promptTokens: number; completionTokens: number; totalTokens: number };
}

const approxTokens = (s: string) => Math.max(1, Math.ceil(s.length / 4));

function usageOf(usage: unknown, prompt: string, completion: string) {
  const u = usage as Record<string, number | undefined>;
  const promptTokens = u?.inputTokens ?? u?.promptTokens ?? approxTokens(prompt);
  const completionTokens = u?.outputTokens ?? u?.completionTokens ?? approxTokens(completion);
  return { promptTokens, completionTokens, totalTokens: u?.totalTokens ?? promptTokens + completionTokens };
}

export async function generate(input: GenerateInput): Promise<GenerateResult> {
  const { provider, model, messages, temperature, maxTokens, apiKey, baseUrl, region, tools, responseFormat } = input;
  const promptText = messages.map((m) => m.content).join("\n");

  if (provider === "mock") {
    const lastUser = [...messages].reverse().find((m) => m.role === "user")?.content ?? "";
    let content: string;
    if (responseFormat) content = JSON.stringify({ note: "mock structured output", echo: lastUser }, null, 2);
    else if (tools && tools.length > 0)
      content = JSON.stringify([{ tool: tools[0]?.name, arguments: { query: lastUser.slice(0, 80) } }], null, 2);
    else content = `[mock:${model}] ${lastUser.slice(0, 400)}`;
    return { provider, model, content, usage: usageOf(undefined, promptText, content) };
  }

  const languageModel = languageModelFor(provider, model, { apiKey, baseUrl, region });
  const sdkMessages = messages.map((m) => ({ role: m.role, content: m.content }));

  // Structured output: the model returns an object matching the JSON Schema.
  if (responseFormat) {
    const result = await generateObject({
      model: languageModel,
      messages: sdkMessages,
      schema: jsonSchema(responseFormat.schema),
      temperature,
    });
    const content = JSON.stringify(result.object, null, 2);
    return { provider, model, content, usage: usageOf(result.usage, promptText, content) };
  }

  // Tool calling: expose tools (no executors) and surface the model's tool calls.
  if (tools && tools.length > 0) {
    const toolMap = Object.fromEntries(
      tools.map((t) => [t.name, tool({ description: t.description, inputSchema: jsonSchema(t.parameters) })]),
    );
    const result = await generateText({
      model: languageModel,
      messages: sdkMessages,
      tools: toolMap,
      temperature,
      maxOutputTokens: maxTokens,
    });
    const calls = result.toolCalls as unknown as { toolName: string; input?: unknown; args?: unknown }[];
    const content =
      calls.length > 0
        ? JSON.stringify(
            calls.map((c) => ({ tool: c.toolName, arguments: c.input ?? c.args ?? {} })),
            null,
            2,
          )
        : result.text;
    return { provider, model, content, usage: usageOf(result.usage, promptText, content) };
  }

  const result = await generateText({
    model: languageModel,
    messages: sdkMessages,
    temperature,
    maxOutputTokens: maxTokens,
  });
  return { provider, model, content: result.text, usage: usageOf(result.usage, promptText, result.text) };
}

/** Streaming variant — yields text deltas. Mock streams the canned reply word by word. */
export async function* generateStream(input: GenerateInput): AsyncGenerator<string> {
  const { provider, model, messages, temperature, maxTokens, apiKey, baseUrl, region } = input;

  if (provider === "mock") {
    const lastUser = [...messages].reverse().find((m) => m.role === "user")?.content ?? "";
    const content = `[mock:${model}] ${lastUser.slice(0, 400)}`;
    for (const word of content.split(" ")) {
      yield `${word} `;
      await sleep(15);
    }
    return;
  }

  const languageModel = languageModelFor(provider, model, { apiKey, baseUrl, region });
  const result = streamText({
    model: languageModel,
    messages: messages.map((m) => ({ role: m.role, content: m.content })),
    temperature,
    maxOutputTokens: maxTokens,
  });
  for await (const delta of result.textStream) yield delta;
}
