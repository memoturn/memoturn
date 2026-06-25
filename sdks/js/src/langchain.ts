import type { Memoturn, MemoturnSpan, MemoturnTrace } from "./client.js";

/**
 * LangChain.js callback handler. Pass an instance in `callbacks` to record chains,
 * LLM calls, and tools as a memoturn trace tree. Implemented structurally (no
 * langchain import) so the SDK stays dependency-free; it satisfies the
 * BaseCallbackHandler contract LangChain invokes at runtime.
 *
 *   const handler = new MemoturnCallback(memoturn);
 *   await chain.invoke(input, { callbacks: [handler] });
 */
export class MemoturnCallback {
  name = "MemoturnCallback";
  awaitHandlers = true;

  private trace: MemoturnTrace | undefined;
  private readonly spans = new Map<string, MemoturnSpan>();

  constructor(
    private readonly client: Memoturn,
    private readonly options: { traceName?: string } = {},
  ) {}

  private ensureTrace(): MemoturnTrace {
    if (!this.trace) this.trace = this.client.trace({ name: this.options.traceName ?? "langchain" });
    return this.trace;
  }

  handleChainStart(_chain: unknown, inputs: unknown, runId: string): void {
    const span = this.ensureTrace().span({ name: "chain", input: inputs });
    this.spans.set(runId, span);
  }

  handleChainEnd(outputs: unknown, runId: string): void {
    this.spans.get(runId)?.end({ output: outputs });
    this.spans.delete(runId);
  }

  handleLLMStart(llm: any, prompts: string[], runId: string): void {
    const gen = this.ensureTrace().generation({
      name: "llm",
      model: llm?.id?.at?.(-1) ?? llm?.name,
      input: prompts,
    });
    this.spans.set(runId, gen);
  }

  handleLLMEnd(output: any, runId: string): void {
    const usage = output?.llmOutput?.tokenUsage;
    this.spans.get(runId)?.end({
      output: output?.generations,
      usage: usage
        ? {
            promptTokens: usage.promptTokens,
            completionTokens: usage.completionTokens,
            totalTokens: usage.totalTokens,
          }
        : undefined,
    });
    this.spans.delete(runId);
  }

  handleToolStart(tool: any, input: string, runId: string): void {
    const span = this.ensureTrace().span({ name: tool?.name ?? "tool", input });
    this.spans.set(runId, span);
  }

  handleToolEnd(output: unknown, runId: string): void {
    this.spans.get(runId)?.end({ output });
    this.spans.delete(runId);
  }

  /** Flush remaining events; call when the run is done. */
  async flush(): Promise<void> {
    await this.client.flush();
  }
}
