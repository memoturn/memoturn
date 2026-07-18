import { afterEach, describe, expect, it } from "vitest";
import { Memoturn } from "./client.js";
import { wrapGroq } from "./groq.js";
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

/** Minimal stand-in for the Groq SDK surface the wrapper touches. */
function fakeGroq(impl: (params: unknown) => Promise<unknown>) {
  return { chat: { completions: { create: impl } } };
}

const completion = {
  choices: [{ message: { role: "assistant", content: "4" } }],
  usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 },
};

describe("wrapGroq", () => {
  it("records a generation with model, params (exclusion-list), input, output, and mapped usage", async () => {
    active = mockFetch(() => ({ status: 207 }));
    const memoturn = new Memoturn(creds);
    const groq = wrapGroq(
      fakeGroq(async () => completion),
      memoturn,
    );

    const res = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [{ role: "user", content: "2+2?" }],
      temperature: 0.2,
      top_p: 0.9,
    });
    expect(res).toBe(completion);
    await memoturn.flush();

    const batch = batchFrom(active);
    const create = batch.find((e) => e.type === "generation-create");
    const update = batch.find((e) => e.type === "generation-update");
    expect(create?.body).toMatchObject({
      name: "groq.chat",
      model: "llama-3.3-70b-versatile",
      provider: "groq",
    });
    // Exclusion-list, not allowlist: an arbitrary extra param (top_p) must appear.
    expect(create?.body.modelParameters).toEqual({ temperature: 0.2, top_p: 0.9 });
    expect(create?.body.input).toEqual([{ role: "user", content: "2+2?" }]);
    expect(update?.body.output).toEqual({ role: "assistant", content: "4" });
    expect(update?.body.usage).toEqual({ promptTokens: 10, completionTokens: 1, totalTokens: 11 });
  });

  it("creates a default trace per call, or nests under a provided trace", async () => {
    active = mockFetch(() => ({ status: 207 }));
    const memoturn = new Memoturn(creds);
    const trace = memoturn.trace({ name: "outer" });
    const groq = wrapGroq(
      fakeGroq(async () => completion),
      memoturn,
      { trace },
    );

    await groq.chat.completions.create({ model: "llama-3.3-70b-versatile", messages: [] });
    await memoturn.flush();

    const gen = batchFrom(active).find((e) => e.type === "generation-create");
    expect(gen?.body.traceId).toBe(trace.id);
  });

  it("marks the generation as ERROR and rethrows when the call fails", async () => {
    active = mockFetch(() => ({ status: 207 }));
    const memoturn = new Memoturn(creds);
    const groq = wrapGroq(
      fakeGroq(async () => {
        throw new Error("rate limited");
      }),
      memoturn,
    );

    await expect(groq.chat.completions.create({ model: "llama-3.3-70b-versatile", messages: [] })).rejects.toThrow(
      "rate limited",
    );
    await memoturn.flush();

    const update = batchFrom(active).find((e) => e.type === "generation-update");
    expect(update?.body.level).toBe("ERROR");
    expect(String(update?.body.statusMessage)).toContain("rate limited");
  });

  it("leaves non-chat properties on the client untouched", () => {
    const memoturn = new Memoturn(creds);
    const base = { ...fakeGroq(async () => completion), apiKey: "sk-real", models: { list: () => [] } };
    const groq = wrapGroq(base, memoturn);
    expect(groq.apiKey).toBe("sk-real");
    expect(typeof groq.models.list).toBe("function");
  });
});

/** Minimal fake chat-completion chunk stream — real async generators are already async-iterable. */
async function* fakeGroqChunks(chunks: unknown[]) {
  for (const chunk of chunks) yield chunk;
}

async function drain(stream: unknown): Promise<void> {
  for await (const _ of stream as AsyncIterable<unknown>) {
    // just drain
  }
}

describe("wrapGroq streaming", () => {
  it("yields every chunk to the caller unchanged and in order (no buffering)", async () => {
    active = mockFetch(() => ({ status: 207 }));
    const memoturn = new Memoturn(creds);
    const chunks = [
      { choices: [{ index: 0, delta: { role: "assistant", content: "Hel" } }] },
      { choices: [{ index: 0, delta: { content: "lo" } }] },
    ];
    const groq = wrapGroq(
      fakeGroq(async () => fakeGroqChunks(chunks)),
      memoturn,
    );

    const stream = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [],
      stream: true,
    });
    const seen: unknown[] = [];
    for await (const chunk of stream as AsyncIterable<unknown>) seen.push(chunk);

    expect(seen).toEqual(chunks);
  });

  it("accumulates content deltas and tool-call argument fragments by index", async () => {
    active = mockFetch(() => ({ status: 207 }));
    const memoturn = new Memoturn(creds);
    const chunks = [
      { choices: [{ index: 0, delta: { role: "assistant", content: "Hel" } }] },
      { choices: [{ index: 0, delta: { content: "lo" } }] },
      {
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                { index: 0, id: "call_1", type: "function", function: { name: "get_weather", arguments: "" } },
              ],
            },
          },
        ],
      },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"city":' } }] } }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"nyc"}' } }] } }] },
    ];
    const groq = wrapGroq(
      fakeGroq(async () => fakeGroqChunks(chunks)),
      memoturn,
    );

    const stream = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [],
      stream: true,
    });
    await drain(stream);
    await memoturn.flush();

    const update = batchFrom(active).find((e) => e.type === "generation-update");
    expect(update?.body.output).toMatchObject({
      role: "assistant",
      content: "Hello",
      tool_calls: [{ id: "call_1", type: "function", function: { name: "get_weather", arguments: '{"city":"nyc"}' } }],
    });
  });

  it("captures usage opportunistically if a chunk carries it", async () => {
    active = mockFetch(() => ({ status: 207 }));
    const memoturn = new Memoturn(creds);
    const chunks = [
      { choices: [{ index: 0, delta: { role: "assistant", content: "Hi" } }] },
      {
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
      },
    ];
    const groq = wrapGroq(
      fakeGroq(async () => fakeGroqChunks(chunks)),
      memoturn,
    );

    const stream = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [],
      stream: true,
    });
    await drain(stream);
    await memoturn.flush();

    const update = batchFrom(active).find((e) => e.type === "generation-update");
    expect(update?.body.usage).toEqual({ promptTokens: 5, completionTokens: 2, totalTokens: 7 });
  });

  it("leaves usage undefined (no crash) when no chunk carries it", async () => {
    active = mockFetch(() => ({ status: 207 }));
    const memoturn = new Memoturn(creds);
    const chunks = [
      { choices: [{ index: 0, delta: { role: "assistant", content: "Hi" } }] },
      { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
    ];
    const groq = wrapGroq(
      fakeGroq(async () => fakeGroqChunks(chunks)),
      memoturn,
    );

    const stream = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [],
      stream: true,
    });
    await drain(stream);
    await memoturn.flush();

    const update = batchFrom(active).find((e) => e.type === "generation-update");
    expect(update?.body.usage).toBeUndefined();
  });

  it("marks the generation ERROR with partial output when the stream throws mid-iteration, and rethrows", async () => {
    active = mockFetch(() => ({ status: 207 }));
    const memoturn = new Memoturn(creds);
    async function* throwingChunks() {
      yield { choices: [{ index: 0, delta: { role: "assistant", content: "Hel" } }] };
      throw new Error("connection reset");
    }
    const groq = wrapGroq(
      fakeGroq(async () => throwingChunks()),
      memoturn,
    );

    const stream = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [],
      stream: true,
    });
    await expect(drain(stream)).rejects.toThrow("connection reset");
    await memoturn.flush();

    const update = batchFrom(active).find((e) => e.type === "generation-update");
    expect(update?.body.level).toBe("ERROR");
    expect(String(update?.body.statusMessage)).toContain("connection reset");
    expect(update?.body.output).toEqual({ role: "assistant", content: "Hel" });
  });

  it("marks the generation WARNING with partial output when the caller breaks out of the loop early", async () => {
    active = mockFetch(() => ({ status: 207 }));
    const memoturn = new Memoturn(creds);
    const chunks = [
      { choices: [{ index: 0, delta: { role: "assistant", content: "Hel" } }] },
      { choices: [{ index: 0, delta: { content: "lo, world" } }] },
    ];
    const groq = wrapGroq(
      fakeGroq(async () => fakeGroqChunks(chunks)),
      memoturn,
    );

    const stream = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [],
      stream: true,
    });
    for await (const _chunk of stream as AsyncIterable<unknown>) {
      break;
    }
    await memoturn.flush();

    const update = batchFrom(active).find((e) => e.type === "generation-update");
    expect(update?.body.level).toBe("WARNING");
    expect(update?.body.statusMessage).toBe("stream ended before completion");
    expect(update?.body.output).toEqual({ role: "assistant", content: "Hel" });
  });

  it("regression: never sends stream_options to create() — Groq's create() has no such param", async () => {
    active = mockFetch(() => ({ status: 207 }));
    const memoturn = new Memoturn(creds);
    let receivedParams: any;
    const groq = wrapGroq(
      fakeGroq(async (params) => {
        receivedParams = params;
        return fakeGroqChunks([]);
      }),
      memoturn,
    );

    const stream = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [],
      stream: true,
    });
    await drain(stream);

    expect("stream_options" in receivedParams).toBe(false);
    expect(receivedParams.stream_options).toBeUndefined();
  });
});
