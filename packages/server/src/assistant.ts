import {
  type ChatMessage,
  generate,
  generateStream,
  generateStreamWithTools,
  type ToolDef as LlmToolDef,
  type Provider,
} from "@memoturn/llm";
import { tools as mcpTools } from "./mcp-tools.js";
import { resolveProviderConfig } from "./providers.js";

/**
 * In-app assistant: a read-only copilot over the current project's telemetry. It runs a bounded
 * agentic loop where the LLM gateway can call memoturn's own READ MCP tools (query traces, get a
 * trace, metrics, scores, prompts, datasets) — the same registry the remote MCP server exposes —
 * scoped to the project. Only non-`write` tools are exposed, so the assistant can inspect but never
 * mutate: safe to run for any role.
 *
 * The gateway surfaces tool calls as a JSON `[{tool, arguments}]` array in the message content (see
 * packages/llm/gateway.ts); anything else is the final answer. We execute the calls, feed results
 * back as a message, and repeat until the model answers or we hit the iteration cap.
 */

const READ_TOOLS = mcpTools.filter((t) => !t.write);

const SYSTEM_PROMPT = `You are memoturn's in-app assistant. You help an engineer understand and debug their LLM application's telemetry for the CURRENT project. Use the provided tools to fetch real data (traces, metrics, scores, prompts, datasets) before answering — never invent trace ids, numbers, or errors. Prefer specific, concise answers that cite trace ids and concrete figures. If a tool returns nothing or errors, say so plainly. When asked to find or summarize, call the relevant tool(s) first, then synthesize.`;

const MAX_ITERATIONS = 6;
const MAX_RESULT_CHARS = 4000; // cap each tool result fed back into the context

/** Where the user currently is in the console — sent by the client, woven into the system prompt. */
export interface AssistantContext {
  organization?: string;
  project?: string;
  /** Console route the user is looking at, e.g. "/traces/tr_abc123". */
  page?: string;
  /** The console's global time-range selector, in days. */
  rangeDays?: number;
}

export function buildContextBlock(ctx?: AssistantContext): string {
  const parts = [`Current UTC time: ${new Date().toISOString()}.`];
  if (ctx?.organization) parts.push(`Organization (workspace): ${JSON.stringify(ctx.organization)}.`);
  if (ctx?.project)
    parts.push(`Project: ${JSON.stringify(ctx.project)} — every tool is already scoped to this project.`);
  if (ctx?.page)
    parts.push(
      `The user is currently viewing the console page "${ctx.page}". If that path embeds an entity id (e.g. /traces/<traceId>), questions like "this trace" refer to it — fetch it with the matching tool.`,
    );
  if (ctx?.rangeDays)
    parts.push(
      `The console's selected time range is the last ${ctx.rangeDays} day(s) — default to that window unless the user asks for another.`,
    );
  return `\n\nContext:\n${parts.map((p) => `- ${p}`).join("\n")}`;
}

export interface AssistantInput {
  provider: Provider;
  model: string;
  /** Conversation so far (user/assistant turns); the system prompt is prepended here. */
  messages: ChatMessage[];
  context?: AssistantContext;
}
export interface AssistantStep {
  tool: string;
  args: unknown;
  result: unknown;
}
export interface AssistantResult {
  content: string;
  steps: AssistantStep[];
}

interface ToolCall {
  tool: string;
  arguments?: Record<string, unknown>;
}

/** The gateway returns tool calls as a JSON array of {tool, arguments}; null when it's a final answer. */
export function parseToolCalls(content: string): ToolCall[] | null {
  try {
    const parsed = JSON.parse(content) as unknown;
    if (
      Array.isArray(parsed) &&
      parsed.length > 0 &&
      parsed.every((c) => c && typeof (c as ToolCall).tool === "string")
    ) {
      return parsed as ToolCall[];
    }
  } catch {
    // Not JSON → a plain-text final answer.
  }
  return null;
}

const truncate = (s: string, n = MAX_RESULT_CHARS): string => (s.length > n ? `${s.slice(0, n)}… [truncated]` : s);

export async function runAssistant(projectId: string, input: AssistantInput): Promise<AssistantResult> {
  const config = await resolveProviderConfig(projectId, input.provider);
  const llmTools: LlmToolDef[] = READ_TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    parameters: t.inputSchema,
  }));
  const messages: ChatMessage[] = [
    { role: "system", content: SYSTEM_PROMPT + buildContextBlock(input.context) },
    ...input.messages,
  ];
  const steps: AssistantStep[] = [];

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const result = await generate({
      provider: input.provider,
      model: input.model,
      messages,
      tools: llmTools,
      ...config,
    });
    const calls = parseToolCalls(result.content);
    if (!calls) return { content: result.content, steps }; // final answer

    const summaries: string[] = [];
    for (const call of calls) {
      const tool = READ_TOOLS.find((t) => t.name === call.tool);
      let out: unknown;
      if (!tool) {
        out = { error: `unknown or non-readable tool: ${call.tool}` };
      } else {
        try {
          out = await tool.handler(projectId, call.arguments ?? {});
        } catch (e) {
          out = { error: e instanceof Error ? e.message : String(e) };
        }
      }
      steps.push({ tool: call.tool, args: call.arguments ?? {}, result: out });
      summaries.push(`Tool ${call.tool} returned:\n${truncate(JSON.stringify(out))}`);
    }
    // No dedicated tool-result role in the gateway's message shape, so thread the model's tool-call
    // turn + the results back as plain messages for the next iteration.
    messages.push({ role: "assistant", content: result.content });
    messages.push({
      role: "user",
      content: `${summaries.join("\n\n")}\n\nUse these results to answer the question, or call more tools if needed.`,
    });
  }

  // Iteration cap hit — one final call WITHOUT tools to force a synthesized answer.
  const final = await generate({ provider: input.provider, model: input.model, messages, ...config });
  return { content: final.content, steps };
}

export type AssistantStreamEvent = { type: "delta"; delta: string } | { type: "step"; step: AssistantStep };

/**
 * Streaming variant of `runAssistant`: the same bounded agentic loop, but each executed tool
 * call is emitted as a `step` event the moment it finishes, and answer text streams out as
 * `delta` events (including any narration the model produces before calling tools). The
 * event stream ends when the final answer is fully streamed.
 */
export async function* runAssistantStream(
  projectId: string,
  input: AssistantInput,
): AsyncGenerator<AssistantStreamEvent> {
  const config = await resolveProviderConfig(projectId, input.provider);
  const llmTools: LlmToolDef[] = READ_TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    parameters: t.inputSchema,
  }));
  const messages: ChatMessage[] = [
    { role: "system", content: SYSTEM_PROMPT + buildContextBlock(input.context) },
    ...input.messages,
  ];

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    let calls: ToolCall[] | null = null;
    for await (const ev of generateStreamWithTools({
      provider: input.provider,
      model: input.model,
      messages,
      tools: llmTools,
      ...config,
    })) {
      if (ev.type === "delta") yield { type: "delta", delta: ev.text };
      else calls = ev.calls;
    }
    if (!calls || calls.length === 0) return; // final answer — fully streamed above

    const summaries: string[] = [];
    for (const call of calls) {
      const tool = READ_TOOLS.find((t) => t.name === call.tool);
      let out: unknown;
      if (!tool) {
        out = { error: `unknown or non-readable tool: ${call.tool}` };
      } else {
        try {
          out = await tool.handler(projectId, call.arguments ?? {});
        } catch (e) {
          out = { error: e instanceof Error ? e.message : String(e) };
        }
      }
      yield { type: "step", step: { tool: call.tool, args: call.arguments ?? {}, result: out } };
      summaries.push(`Tool ${call.tool} returned:\n${truncate(JSON.stringify(out))}`);
    }
    // Thread the tool-call turn + results back exactly like the non-streaming loop.
    messages.push({ role: "assistant", content: JSON.stringify(calls) });
    messages.push({
      role: "user",
      content: `${summaries.join("\n\n")}\n\nUse these results to answer the question, or call more tools if needed.`,
    });
  }

  // Iteration cap hit — one final streamed call WITHOUT tools to force a synthesized answer.
  for await (const delta of generateStream({ provider: input.provider, model: input.model, messages, ...config })) {
    yield { type: "delta", delta };
  }
}
