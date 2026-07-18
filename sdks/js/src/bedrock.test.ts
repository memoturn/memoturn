import { afterEach, describe, expect, it, vi } from "vitest";
import { wrapBedrock } from "./bedrock.js";
import { Memoturn } from "./client.js";
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

/** Fake command classes shaped like the real AWS SDK v3 command objects the wrapper
 * duck-types against — only `constructor.name` and `.input` are inspected. */
class ConverseCommand {
  constructor(public input: any) {}
}
class ConverseStreamCommand {
  constructor(public input: any) {}
}
class InvokeModelCommand {
  constructor(public input: any) {}
}
class ListFoundationModelsCommand {
  constructor(public input: any) {}
}

/** Minimal stand-in for a `BedrockRuntimeClient` — only `.send` is touched by the wrapper. */
function fakeBedrockClient(sendImpl: (command: any, ...rest: any[]) => Promise<any>) {
  return { send: sendImpl };
}

const converseResponse = {
  output: { message: { role: "assistant", content: [{ text: "4" }] } },
  stopReason: "end_turn",
  usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12, cacheReadInputTokens: 7, cacheWriteInputTokens: 3 },
};

describe("wrapBedrock", () => {
  it("records a generation with model, allowlisted inferenceConfig, input incl. system, output, and mapped usage", async () => {
    active = mockFetch(() => ({ status: 207 }));
    const memoturn = new Memoturn(creds);
    const bedrock = wrapBedrock(
      fakeBedrockClient(async () => converseResponse),
      memoturn,
    );

    const command = new ConverseCommand({
      modelId: "anthropic.claude-3-5-sonnet-20241022-v2:0",
      system: [{ text: "be terse" }],
      messages: [{ role: "user", content: [{ text: "2+2?" }] }],
      inferenceConfig: { maxTokens: 64, temperature: 0.2, topP: 0.9, stopSequences: ["\n"] },
      additionalModelRequestFields: { foo: "bar" }, // not in the allowlist — must not leak
    });
    const res = await bedrock.send(command);
    expect(res).toBe(converseResponse);
    await memoturn.flush();

    const batch = batchFrom(active);
    const create = batch.find((e) => e.type === "generation-create");
    const update = batch.find((e) => e.type === "generation-update");
    expect(create?.body).toMatchObject({
      name: "bedrock.converse",
      model: "anthropic.claude-3-5-sonnet-20241022-v2:0",
      provider: "bedrock",
    });
    expect(create?.body.modelParameters).toEqual({
      maxTokens: 64,
      temperature: 0.2,
      topP: 0.9,
      stopSequences: ["\n"],
    });
    expect(create?.body.input).toEqual({
      system: [{ text: "be terse" }],
      messages: [{ role: "user", content: [{ text: "2+2?" }] }],
    });
    expect(update?.body.output).toEqual(converseResponse.output.message);
    expect(update?.body.usage).toEqual({
      promptTokens: 10,
      completionTokens: 2,
      totalTokens: 12,
      cacheReadTokens: 7,
      cacheCreationTokens: 3,
    });
  });

  it("records bare messages as input when there is no system prompt", async () => {
    active = mockFetch(() => ({ status: 207 }));
    const memoturn = new Memoturn(creds);
    const bedrock = wrapBedrock(
      fakeBedrockClient(async () => converseResponse),
      memoturn,
    );

    await bedrock.send(
      new ConverseCommand({ modelId: "amazon.titan-text-express-v1", messages: [{ role: "user", content: [] }] }),
    );
    await memoturn.flush();

    const create = batchFrom(active).find((e) => e.type === "generation-create");
    expect(create?.body.input).toEqual([{ role: "user", content: [] }]);
  });

  it("omits cache token fields when the provider does not report them", async () => {
    active = mockFetch(() => ({ status: 207 }));
    const memoturn = new Memoturn(creds);
    const bedrock = wrapBedrock(
      fakeBedrockClient(async () => ({
        output: { message: { role: "assistant", content: [] } },
        usage: { inputTokens: 5, outputTokens: 1, totalTokens: 6 },
      })),
      memoturn,
    );

    await bedrock.send(new ConverseCommand({ modelId: "amazon.titan-text-express-v1", messages: [] }));
    await memoturn.flush();

    const update = batchFrom(active).find((e) => e.type === "generation-update");
    expect(update?.body.usage).toEqual({ promptTokens: 5, completionTokens: 1, totalTokens: 6 });
  });

  it("creates a default trace per call, or nests under a provided trace", async () => {
    active = mockFetch(() => ({ status: 207 }));
    const memoturn = new Memoturn(creds);
    const trace = memoturn.trace({ name: "outer" });
    const bedrock = wrapBedrock(
      fakeBedrockClient(async () => converseResponse),
      memoturn,
      { trace },
    );

    await bedrock.send(new ConverseCommand({ modelId: "amazon.titan-text-express-v1", messages: [] }));
    await memoturn.flush();

    const gen = batchFrom(active).find((e) => e.type === "generation-create");
    expect(gen?.body.traceId).toBe(trace.id);
  });

  it("marks the generation ERROR and rethrows when the send() call fails", async () => {
    active = mockFetch(() => ({ status: 207 }));
    const memoturn = new Memoturn(creds);
    const bedrock = wrapBedrock(
      fakeBedrockClient(async () => {
        throw new Error("throttled");
      }),
      memoturn,
    );

    await expect(
      bedrock.send(new ConverseCommand({ modelId: "amazon.titan-text-express-v1", messages: [] })),
    ).rejects.toThrow("throttled");
    await memoturn.flush();

    const update = batchFrom(active).find((e) => e.type === "generation-update");
    expect(update?.body.level).toBe("ERROR");
    expect(String(update?.body.statusMessage)).toContain("throttled");
  });

  it("passes non-Converse commands straight through untouched, with no generation/trace created", async () => {
    active = mockFetch(() => ({ status: 207 }));
    const memoturn = new Memoturn(creds);
    const rawResponse = { body: new Uint8Array([1, 2, 3]), contentType: "application/json" };
    const sendImpl = vi.fn(async () => rawResponse);
    const bedrock = wrapBedrock(fakeBedrockClient(sendImpl), memoturn);

    const command = new InvokeModelCommand({ modelId: "amazon.titan-text-express-v1", body: "{}" });
    const res = await bedrock.send(command, { extra: "opt" });
    expect(res).toBe(rawResponse);
    expect(sendImpl).toHaveBeenCalledWith(command, { extra: "opt" });

    const command2 = new ListFoundationModelsCommand({});
    await bedrock.send(command2);

    await memoturn.flush(); // no-op: nothing was ever enqueued
    expect(active.calls.length).toBe(0);
  });

  it("leaves non-send properties on the client untouched", () => {
    const memoturn = new Memoturn(creds);
    const base = { ...fakeBedrockClient(async () => converseResponse), region: "us-east-1", config: { retries: 3 } };
    const bedrock = wrapBedrock(base, memoturn);
    expect(bedrock.region).toBe("us-east-1");
    expect(bedrock.config).toEqual({ retries: 3 });
  });
});

/** Minimal fake Bedrock ConverseStream events source — real async generators are already async-iterable. */
async function* fakeBedrockStream(events: unknown[]) {
  for (const event of events) yield event;
}

async function drain(stream: unknown): Promise<void> {
  for await (const _event of stream as AsyncIterable<unknown>) {
    // just drain
  }
}

describe("wrapBedrock streaming", () => {
  it("yields events unchanged while accumulating text deltas and merging non-text deltas by index", async () => {
    active = mockFetch(() => ({ status: 207 }));
    const memoturn = new Memoturn(creds);
    const events = [
      { messageStart: { role: "assistant" } },
      { contentBlockStart: { contentBlockIndex: 0, start: {} } },
      { contentBlockDelta: { contentBlockIndex: 0, delta: { text: "Hel" } } },
      { contentBlockDelta: { contentBlockIndex: 0, delta: { text: "lo" } } },
      { contentBlockStop: { contentBlockIndex: 0 } },
      { contentBlockStart: { contentBlockIndex: 1, start: { toolUse: { toolUseId: "t1", name: "get_weather" } } } },
      { contentBlockDelta: { contentBlockIndex: 1, delta: { toolUse: { input: '{"city":"nyc"}' } } } },
      { contentBlockStop: { contentBlockIndex: 1 } },
      { messageStop: { stopReason: "tool_use" } },
      { metadata: { usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 } } },
    ];
    const bedrock = wrapBedrock(
      fakeBedrockClient(async () => ({ stream: fakeBedrockStream(events), $metadata: { requestId: "req-1" } })),
      memoturn,
    );

    const response = await bedrock.send(
      new ConverseStreamCommand({ modelId: "anthropic.claude-3-5-sonnet-20241022-v2:0", messages: [] }),
    );
    const seen: unknown[] = [];
    for await (const event of response.stream as AsyncIterable<unknown>) seen.push(event);
    expect(seen).toEqual(events);
    await memoturn.flush();

    const update = batchFrom(active).find((e) => e.type === "generation-update");
    // Non-text delta merge is a shallow `Object.assign` (mirrors the Anthropic accumulator's
    // own generic-merge fallback) — the top-level `toolUse` key from the delta replaces the
    // one set by `contentBlockStart`, it isn't deep-merged with it.
    expect(update?.body.output).toEqual([{ text: "Hello" }, { toolUse: { input: '{"city":"nyc"}' } }]);
  });

  it("takes the final usage from the metadata event", async () => {
    active = mockFetch(() => ({ status: 207 }));
    const memoturn = new Memoturn(creds);
    const events = [
      { contentBlockStart: { contentBlockIndex: 0, start: {} } },
      { contentBlockDelta: { contentBlockIndex: 0, delta: { text: "hi" } } },
      {
        metadata: {
          usage: { inputTokens: 4, outputTokens: 1, totalTokens: 5, cacheReadInputTokens: 2, cacheWriteInputTokens: 1 },
        },
      },
    ];
    const bedrock = wrapBedrock(
      fakeBedrockClient(async () => ({ stream: fakeBedrockStream(events) })),
      memoturn,
    );

    const response = await bedrock.send(
      new ConverseStreamCommand({ modelId: "amazon.titan-text-express-v1", messages: [] }),
    );
    await drain(response.stream);
    await memoturn.flush();

    const update = batchFrom(active).find((e) => e.type === "generation-update");
    expect(update?.body.usage).toEqual({
      promptTokens: 4,
      completionTokens: 1,
      totalTokens: 5,
      cacheReadTokens: 2,
      cacheCreationTokens: 1,
    });
  });

  it("marks the generation ERROR with partial output when the stream throws mid-iteration, and rethrows", async () => {
    active = mockFetch(() => ({ status: 207 }));
    const memoturn = new Memoturn(creds);
    async function* throwingEvents() {
      yield { contentBlockStart: { contentBlockIndex: 0, start: {} } };
      yield { contentBlockDelta: { contentBlockIndex: 0, delta: { text: "Hel" } } };
      throw new Error("connection reset");
    }
    const bedrock = wrapBedrock(
      fakeBedrockClient(async () => ({ stream: throwingEvents() })),
      memoturn,
    );

    const response = await bedrock.send(
      new ConverseStreamCommand({ modelId: "amazon.titan-text-express-v1", messages: [] }),
    );
    await expect(drain(response.stream)).rejects.toThrow("connection reset");
    await memoturn.flush();

    const update = batchFrom(active).find((e) => e.type === "generation-update");
    expect(update?.body.level).toBe("ERROR");
    expect(String(update?.body.statusMessage)).toContain("connection reset");
    expect(update?.body.output).toEqual([{ text: "Hel" }]);
  });

  it("marks the generation WARNING with partial output when the caller breaks out of the loop early", async () => {
    active = mockFetch(() => ({ status: 207 }));
    const memoturn = new Memoturn(creds);
    const events = [
      { contentBlockStart: { contentBlockIndex: 0, start: {} } },
      { contentBlockDelta: { contentBlockIndex: 0, delta: { text: "Hel" } } },
      { contentBlockDelta: { contentBlockIndex: 0, delta: { text: "lo, world" } } },
    ];
    const bedrock = wrapBedrock(
      fakeBedrockClient(async () => ({ stream: fakeBedrockStream(events) })),
      memoturn,
    );

    const response = await bedrock.send(
      new ConverseStreamCommand({ modelId: "amazon.titan-text-express-v1", messages: [] }),
    );
    let seen = 0;
    for await (const _event of response.stream as AsyncIterable<unknown>) {
      seen += 1;
      if (seen === 2) break; // stop right after the "Hel" text delta, before "lo, world"
    }
    await memoturn.flush();

    const update = batchFrom(active).find((e) => e.type === "generation-update");
    expect(update?.body.level).toBe("WARNING");
    expect(update?.body.statusMessage).toBe("stream ended before completion");
    expect(update?.body.output).toEqual([{ text: "Hel" }]);
  });

  it("passes through non-stream response properties (e.g. $metadata) unchanged", async () => {
    active = mockFetch(() => ({ status: 207 }));
    const memoturn = new Memoturn(creds);
    const metadata = { requestId: "req-1", httpStatusCode: 200 };
    const bedrock = wrapBedrock(
      fakeBedrockClient(async () => ({ stream: fakeBedrockStream([]), $metadata: metadata })),
      memoturn,
    );

    const response = await bedrock.send(
      new ConverseStreamCommand({ modelId: "amazon.titan-text-express-v1", messages: [] }),
    );
    expect((response as any).$metadata).toBe(metadata);
  });
});
