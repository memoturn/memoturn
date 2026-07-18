import { afterEach, describe, expect, it } from "vitest";
import { Memoturn } from "./client.js";
import { wrapCohere } from "./cohere.js";
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

// v1 (CohereClient) response shape: text + meta.tokens.
const v1Response = {
  text: "4",
  generationId: "gen-1",
  meta: { tokens: { inputTokens: 10, outputTokens: 1 } },
};

// v2 (CohereClientV2 / client.v2) response shape: message.content[] + usage.tokens.
const v2Response = {
  id: "chat-1",
  finishReason: "COMPLETE",
  message: { role: "assistant", content: [{ type: "text", text: "4" }] },
  usage: { tokens: { inputTokens: 10, outputTokens: 1 } },
};

async function* fakeEvents(events: unknown[]) {
  for (const event of events) yield event;
}

async function drain(stream: unknown): Promise<void> {
  for await (const _ of stream as AsyncIterable<unknown>) {
    // just drain
  }
}

describe("wrapCohere (v1 chat)", () => {
  it("records a generation with model, params (exclusion-list), input, text output, and summed usage", async () => {
    active = mockFetch(() => ({ status: 207 }));
    const memoturn = new Memoturn(creds);
    const cohere = wrapCohere({ chat: async (_params: unknown) => v1Response }, memoturn);

    const res = await cohere.chat({
      model: "command-r-plus",
      message: "2+2?",
      temperature: 0.2,
      k: 40,
    });
    expect(res).toBe(v1Response);
    await memoturn.flush();

    const batch = batchFrom(active);
    const create = batch.find((e) => e.type === "generation-create");
    const update = batch.find((e) => e.type === "generation-update");
    expect(create?.body).toMatchObject({ name: "cohere.chat", model: "command-r-plus", provider: "cohere" });
    // Exclusion-list, not allowlist: an arbitrary extra param (k) must appear.
    expect(create?.body.modelParameters).toEqual({ temperature: 0.2, k: 40 });
    expect(create?.body.input).toBe("2+2?");
    expect(update?.body.output).toBe("4");
    // Cohere reports no total — the wrapper sums inputTokens + outputTokens.
    expect(update?.body.usage).toEqual({ promptTokens: 10, completionTokens: 1, totalTokens: 11 });
  });

  it("folds chatHistory + message into the recorded input", async () => {
    active = mockFetch(() => ({ status: 207 }));
    const memoturn = new Memoturn(creds);
    const cohere = wrapCohere({ chat: async (_params: unknown) => v1Response }, memoturn);

    await cohere.chat({
      model: "command-r-plus",
      message: "and 3+3?",
      chatHistory: [
        { role: "USER", message: "2+2?" },
        { role: "CHATBOT", message: "4" },
      ],
    });
    await memoturn.flush();

    const create = batchFrom(active).find((e) => e.type === "generation-create");
    expect(create?.body.input).toEqual([
      { role: "USER", message: "2+2?" },
      { role: "CHATBOT", message: "4" },
      { role: "USER", message: "and 3+3?" },
    ]);
    // chatHistory is input, not a model parameter.
    expect(create?.body.modelParameters).toEqual({});
  });

  it("creates a default trace per call, or nests under a provided trace", async () => {
    active = mockFetch(() => ({ status: 207 }));
    const memoturn = new Memoturn(creds);
    const trace = memoturn.trace({ name: "outer" });
    const cohere = wrapCohere({ chat: async (_params: unknown) => v1Response }, memoturn, { trace });

    await cohere.chat({ model: "command-r-plus", message: "hi" });
    await memoturn.flush();

    const gen = batchFrom(active).find((e) => e.type === "generation-create");
    expect(gen?.body.traceId).toBe(trace.id);
  });

  it("marks the generation as ERROR and rethrows when the call fails", async () => {
    active = mockFetch(() => ({ status: 207 }));
    const memoturn = new Memoturn(creds);
    const cohere = wrapCohere(
      {
        chat: async (_params: unknown) => {
          throw new Error("rate limited");
        },
      },
      memoturn,
    );

    await expect(cohere.chat({ model: "command-r-plus", message: "hi" })).rejects.toThrow("rate limited");
    await memoturn.flush();

    const update = batchFrom(active).find((e) => e.type === "generation-update");
    expect(update?.body.level).toBe("ERROR");
    expect(String(update?.body.statusMessage)).toContain("rate limited");
  });

  it("leaves non-chat properties on the client untouched", () => {
    const memoturn = new Memoturn(creds);
    const base = { chat: async (_params: unknown) => v1Response, token: "co-real", embed: async () => ({}) };
    const cohere = wrapCohere(base, memoturn);
    expect(cohere.token).toBe("co-real");
    expect(typeof cohere.embed).toBe("function");
  });
});

describe("wrapCohere (v1 chatStream)", () => {
  const streamEvents = [
    { eventType: "stream-start", generationId: "gen-1" },
    { eventType: "text-generation", text: "Hel" },
    { eventType: "text-generation", text: "lo" },
    {
      eventType: "stream-end",
      finishReason: "COMPLETE",
      response: { text: "Hello", meta: { tokens: { inputTokens: 5, outputTokens: 2 } } },
    },
  ];

  it("yields every event to the caller unchanged and in order (no buffering)", async () => {
    active = mockFetch(() => ({ status: 207 }));
    const memoturn = new Memoturn(creds);
    const cohere = wrapCohere({ chatStream: async (_params: unknown) => fakeEvents(streamEvents) }, memoturn);

    const stream = await cohere.chatStream({ model: "command-r-plus", message: "hi" });
    const seen: unknown[] = [];
    for await (const event of stream as AsyncIterable<unknown>) seen.push(event);

    expect(seen).toEqual(streamEvents);
  });

  it("records the stream-end response text and meta.tokens usage", async () => {
    active = mockFetch(() => ({ status: 207 }));
    const memoturn = new Memoturn(creds);
    const cohere = wrapCohere({ chatStream: async (_params: unknown) => fakeEvents(streamEvents) }, memoturn);

    const stream = await cohere.chatStream({ model: "command-r-plus", message: "hi" });
    await drain(stream);
    await memoturn.flush();

    const update = batchFrom(active).find((e) => e.type === "generation-update");
    expect(update?.body.output).toBe("Hello");
    expect(update?.body.usage).toEqual({ promptTokens: 5, completionTokens: 2, totalTokens: 7 });
  });

  it("falls back to accumulated text (usage undefined) when the stream ends without a stream-end event", async () => {
    active = mockFetch(() => ({ status: 207 }));
    const memoturn = new Memoturn(creds);
    const cohere = wrapCohere(
      { chatStream: async (_params: unknown) => fakeEvents(streamEvents.slice(0, 3)) },
      memoturn,
    );

    const stream = await cohere.chatStream({ model: "command-r-plus", message: "hi" });
    await drain(stream);
    await memoturn.flush();

    const update = batchFrom(active).find((e) => e.type === "generation-update");
    expect(update?.body.output).toBe("Hello");
    expect(update?.body.usage).toBeUndefined();
  });

  it("marks the generation ERROR with partial output when the stream throws mid-iteration, and rethrows", async () => {
    active = mockFetch(() => ({ status: 207 }));
    const memoturn = new Memoturn(creds);
    async function* throwingEvents() {
      yield { eventType: "text-generation", text: "Hel" };
      throw new Error("connection reset");
    }
    const cohere = wrapCohere({ chatStream: async (_params: unknown) => throwingEvents() }, memoturn);

    const stream = await cohere.chatStream({ model: "command-r-plus", message: "hi" });
    await expect(drain(stream)).rejects.toThrow("connection reset");
    await memoturn.flush();

    const update = batchFrom(active).find((e) => e.type === "generation-update");
    expect(update?.body.level).toBe("ERROR");
    expect(String(update?.body.statusMessage)).toContain("connection reset");
    expect(update?.body.output).toBe("Hel");
  });

  it("marks the generation WARNING with partial output when the caller breaks out of the loop early", async () => {
    active = mockFetch(() => ({ status: 207 }));
    const memoturn = new Memoturn(creds);
    const cohere = wrapCohere({ chatStream: async (_params: unknown) => fakeEvents(streamEvents) }, memoturn);

    const stream = await cohere.chatStream({ model: "command-r-plus", message: "hi" });
    for await (const _event of stream as AsyncIterable<unknown>) {
      break;
    }
    await memoturn.flush();

    const update = batchFrom(active).find((e) => e.type === "generation-update");
    expect(update?.body.level).toBe("WARNING");
    expect(update?.body.statusMessage).toBe("stream ended before completion");
  });
});

describe("wrapCohere (v2 surface)", () => {
  it("records client.v2.chat with messages input, message output, and usage.tokens", async () => {
    active = mockFetch(() => ({ status: 207 }));
    const memoturn = new Memoturn(creds);
    const cohere = wrapCohere({ v2: { chat: async (_params: unknown) => v2Response } }, memoturn);

    const messages = [{ role: "user", content: "2+2?" }];
    const res = await cohere.v2.chat({ model: "command-a-03-2025", messages, temperature: 0.2 });
    expect(res).toBe(v2Response);
    await memoturn.flush();

    const batch = batchFrom(active);
    const create = batch.find((e) => e.type === "generation-create");
    const update = batch.find((e) => e.type === "generation-update");
    expect(create?.body).toMatchObject({ name: "cohere.v2.chat", model: "command-a-03-2025", provider: "cohere" });
    expect(create?.body.modelParameters).toEqual({ temperature: 0.2 });
    expect(create?.body.input).toEqual(messages);
    expect(update?.body.output).toEqual(v2Response.message);
    expect(update?.body.usage).toEqual({ promptTokens: 10, completionTokens: 1, totalTokens: 11 });
  });

  it("records a v2-shaped response served from the top-level chat (CohereClientV2) via shape sniffing", async () => {
    active = mockFetch(() => ({ status: 207 }));
    const memoturn = new Memoturn(creds);
    const cohere = wrapCohere({ chat: async (_params: unknown) => v2Response }, memoturn);

    await cohere.chat({ model: "command-a-03-2025", messages: [{ role: "user", content: "2+2?" }] });
    await memoturn.flush();

    const batch = batchFrom(active);
    const create = batch.find((e) => e.type === "generation-create");
    const update = batch.find((e) => e.type === "generation-update");
    expect(create?.body.input).toEqual([{ role: "user", content: "2+2?" }]);
    expect(update?.body.output).toEqual(v2Response.message);
    expect(update?.body.usage).toEqual({ promptTokens: 10, completionTokens: 1, totalTokens: 11 });
  });

  it("accumulates v2 content-delta events and captures message-end usage on chatStream", async () => {
    active = mockFetch(() => ({ status: 207 }));
    const memoturn = new Memoturn(creds);
    const events = [
      { type: "message-start", id: "chat-1" },
      { type: "content-start", index: 0 },
      { type: "content-delta", index: 0, delta: { message: { content: { text: "Hel" } } } },
      { type: "content-delta", index: 0, delta: { message: { content: { text: "lo" } } } },
      { type: "content-end", index: 0 },
      {
        type: "message-end",
        delta: { finishReason: "COMPLETE", usage: { tokens: { inputTokens: 5, outputTokens: 2 } } },
      },
    ];
    const cohere = wrapCohere({ v2: { chatStream: async (_params: unknown) => fakeEvents(events) } }, memoturn);

    const stream = await cohere.v2.chatStream({ model: "command-a-03-2025", messages: [] });
    const seen: unknown[] = [];
    for await (const event of stream as AsyncIterable<unknown>) seen.push(event);
    await memoturn.flush();

    expect(seen).toEqual(events); // passthrough, unchanged and in order

    const update = batchFrom(active).find((e) => e.type === "generation-update");
    expect(update?.body.output).toEqual({ role: "assistant", content: [{ type: "text", text: "Hello" }] });
    expect(update?.body.usage).toEqual({ promptTokens: 5, completionTokens: 2, totalTokens: 7 });
  });

  it("nests v2 generations under a provided trace and marks errors", async () => {
    active = mockFetch(() => ({ status: 207 }));
    const memoturn = new Memoturn(creds);
    const trace = memoturn.trace({ name: "outer" });
    const cohere = wrapCohere(
      {
        v2: {
          chat: async (_params: unknown) => {
            throw new Error("quota exceeded");
          },
        },
      },
      memoturn,
      { trace },
    );

    await expect(cohere.v2.chat({ model: "command-a-03-2025", messages: [] })).rejects.toThrow("quota exceeded");
    await memoturn.flush();

    const batch = batchFrom(active);
    const create = batch.find((e) => e.type === "generation-create");
    const update = batch.find((e) => e.type === "generation-update");
    expect(create?.body.traceId).toBe(trace.id);
    expect(update?.body.level).toBe("ERROR");
    expect(String(update?.body.statusMessage)).toContain("quota exceeded");
  });
});
