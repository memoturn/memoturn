import { afterEach, describe, expect, it } from "vitest";
import { Memoturn } from "./client.js";
import { MemoturnCallback } from "./langchain.js";
import { mockFetch } from "./test-helpers.js";
import type { IngestEnvelope } from "./types.js";

const creds = { baseUrl: "http://api.test", publicKey: "pk-mt-x", secretKey: "sk-mt-y", flushAt: 1000 };

let active: ReturnType<typeof mockFetch> | undefined;
afterEach(() => {
  active?.restore();
  active = undefined;
});

function batchFrom(m: ReturnType<typeof mockFetch>): IngestEnvelope[] {
  return (m.calls[0].body as { batch: IngestEnvelope[] }).batch;
}

describe("MemoturnCallback", () => {
  it("opens a single trace lazily and builds a chain + llm + tool tree", async () => {
    active = mockFetch(() => ({ status: 207 }));
    const memoturn = new Memoturn(creds);
    const cb = new MemoturnCallback(memoturn, { traceName: "agent-run" });

    cb.handleChainStart({}, { question: "hi" }, "chain-1");
    cb.handleLLMStart({ id: ["openai", "gpt-4o"] }, ["prompt text"], "llm-1");
    cb.handleLLMEnd(
      {
        generations: [[{ text: "answer" }]],
        llmOutput: { tokenUsage: { promptTokens: 3, completionTokens: 4, totalTokens: 7 } },
      },
      "llm-1",
    );
    cb.handleToolStart({ name: "search" }, "query", "tool-1");
    cb.handleToolEnd("results", "tool-1");
    cb.handleChainEnd({ answer: "answer" }, "chain-1");
    await cb.flush();

    const batch = batchFrom(active);
    const traces = batch.filter((e) => e.type === "trace-create");
    expect(traces).toHaveLength(1); // single lazily-created trace shared by all observations
    const traceId = traces[0].body.id;
    expect(traces[0].body.name).toBe("agent-run");

    const llmCreate = batch.find((e) => e.type === "generation-create");
    expect(llmCreate?.body).toMatchObject({ name: "llm", model: "gpt-4o", traceId });
    const llmEnd = batch.find((e) => e.type === "generation-update");
    expect(llmEnd?.body.usage).toEqual({ promptTokens: 3, completionTokens: 4, totalTokens: 7 });

    const toolCreate = batch.find((e) => e.type === "span-create" && e.body.name === "search");
    expect(toolCreate?.body).toMatchObject({ input: "query", traceId });
    const spanEnds = batch.filter((e) => e.type === "span-update");
    expect(spanEnds.length).toBeGreaterThanOrEqual(2); // chain + tool both closed
  });

  it("handles an LLM end with no token usage", async () => {
    active = mockFetch(() => ({ status: 207 }));
    const memoturn = new Memoturn(creds);
    const cb = new MemoturnCallback(memoturn);

    cb.handleLLMStart({ name: "anthropic" }, ["p"], "llm-x");
    cb.handleLLMEnd({ generations: [[{ text: "ok" }]] }, "llm-x");
    await cb.flush();

    const end = batchFrom(active).find((e) => e.type === "generation-update");
    expect(end?.body.usage).toBeUndefined();
    expect(end?.body.output).toEqual([[{ text: "ok" }]]);
  });
});
