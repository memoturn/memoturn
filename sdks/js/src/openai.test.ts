import { afterEach, describe, expect, it } from "vitest";
import { Memoturn } from "./client.js";
import { wrapOpenAI } from "./openai.js";
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

/** Minimal stand-in for the OpenAI SDK surface the wrapper touches. */
function fakeOpenAI(impl: (params: unknown) => Promise<unknown>) {
  return { chat: { completions: { create: impl } } };
}

const completion = {
  choices: [{ message: { role: "assistant", content: "4" } }],
  usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 },
};

describe("wrapOpenAI", () => {
  it("records a generation with model, params, input, output, and mapped usage", async () => {
    active = mockFetch(() => ({ status: 207 }));
    const memoturn = new Memoturn(creds);
    const openai = wrapOpenAI(
      fakeOpenAI(async () => completion),
      memoturn,
    );

    const res = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [{ role: "user", content: "2+2?" }],
      temperature: 0.2,
    });
    expect(res).toBe(completion);
    await memoturn.flush();

    const batch = batchFrom(active);
    const create = batch.find((e) => e.type === "generation-create");
    const update = batch.find((e) => e.type === "generation-update");
    expect(create?.body).toMatchObject({
      name: "openai.chat.completions",
      model: "gpt-4o",
      provider: "openai",
      modelParameters: { temperature: 0.2 },
    });
    expect(create?.body.input).toEqual([{ role: "user", content: "2+2?" }]);
    expect(update?.body.output).toEqual({ role: "assistant", content: "4" });
    expect(update?.body.usage).toEqual({ promptTokens: 10, completionTokens: 1, totalTokens: 11 });
  });

  it("creates a default trace per call, or nests under a provided trace", async () => {
    active = mockFetch(() => ({ status: 207 }));
    const memoturn = new Memoturn(creds);
    const trace = memoturn.trace({ name: "outer" });
    const openai = wrapOpenAI(
      fakeOpenAI(async () => completion),
      memoturn,
      { trace },
    );

    await openai.chat.completions.create({ model: "gpt-4o", messages: [] });
    await memoturn.flush();

    const gen = batchFrom(active).find((e) => e.type === "generation-create");
    expect(gen?.body.traceId).toBe(trace.id);
  });

  it("marks the generation as ERROR and rethrows when the call fails", async () => {
    active = mockFetch(() => ({ status: 207 }));
    const memoturn = new Memoturn(creds);
    const openai = wrapOpenAI(
      fakeOpenAI(async () => {
        throw new Error("rate limited");
      }),
      memoturn,
    );

    await expect(openai.chat.completions.create({ model: "gpt-4o", messages: [] })).rejects.toThrow("rate limited");
    await memoturn.flush();

    const update = batchFrom(active).find((e) => e.type === "generation-update");
    expect(update?.body.level).toBe("ERROR");
    expect(String(update?.body.statusMessage)).toContain("rate limited");
  });

  it("leaves non-chat properties on the client untouched", () => {
    const memoturn = new Memoturn(creds);
    const base = { ...fakeOpenAI(async () => completion), apiKey: "sk-real", models: { list: () => [] } };
    const openai = wrapOpenAI(base, memoturn);
    expect(openai.apiKey).toBe("sk-real");
    expect(typeof openai.models.list).toBe("function");
  });

  it("records a generation for responses.create (input/instructions, output_text, mapped usage)", async () => {
    active = mockFetch(() => ({ status: 207 }));
    const memoturn = new Memoturn(creds);
    const response = {
      output_text: "it works",
      output: [{ type: "message", content: [{ type: "output_text", text: "it works" }] }],
      usage: { input_tokens: 12, output_tokens: 7, total_tokens: 19 },
    };
    const openai = wrapOpenAI({ responses: { create: async () => response } }, memoturn);

    const res = await openai.responses.create({ model: "gpt-4o", input: "hi", instructions: "be terse", top_p: 0.9 });
    expect(res).toBe(response);
    await memoturn.flush();

    const batch = batchFrom(active);
    const create = batch.find((e) => e.type === "generation-create");
    const update = batch.find((e) => e.type === "generation-update");
    expect(create?.body).toMatchObject({ name: "openai.responses", model: "gpt-4o", provider: "openai" });
    expect(create?.body.modelParameters).toEqual({ top_p: 0.9 });
    expect(create?.body.input).toEqual({ instructions: "be terse", input: "hi" });
    expect(update?.body.output).toBe("it works");
    expect(update?.body.usage).toEqual({ promptTokens: 12, completionTokens: 7, totalTokens: 19 });
  });

  it("falls back to output items when responses has no output_text", async () => {
    active = mockFetch(() => ({ status: 207 }));
    const memoturn = new Memoturn(creds);
    const output = [{ type: "function_call", name: "get_weather", arguments: "{}" }];
    const openai = wrapOpenAI({ responses: { create: async () => ({ output }) } }, memoturn);

    await openai.responses.create({ model: "gpt-4o", input: "weather?" });
    await memoturn.flush();

    const update = batchFrom(active).find((e) => e.type === "generation-update");
    expect(update?.body.output).toEqual(output);
  });
});

/** Minimal fake chat-completion chunk stream — real async generators are already async-iterable. */
async function* fakeChunks(chunks: unknown[]) {
  for (const chunk of chunks) yield chunk;
}

async function drain(stream: unknown): Promise<void> {
  for await (const _ of stream as AsyncIterable<unknown>) {
    // just drain
  }
}

describe("wrapOpenAI streaming", () => {
  it("yields every chunk to the caller unchanged and in order (no buffering)", async () => {
    active = mockFetch(() => ({ status: 207 }));
    const memoturn = new Memoturn(creds);
    const chunks = [
      { choices: [{ index: 0, delta: { role: "assistant", content: "Hel" } }] },
      { choices: [{ index: 0, delta: { content: "lo" } }] },
    ];
    const openai = wrapOpenAI(
      fakeOpenAI(async () => fakeChunks(chunks)),
      memoturn,
    );

    const stream = await openai.chat.completions.create({ model: "gpt-4o", messages: [], stream: true });
    const seen: unknown[] = [];
    for await (const chunk of stream as AsyncIterable<unknown>) seen.push(chunk);

    expect(seen).toEqual(chunks);
  });

  it("accumulates content deltas and captures usage from the final chunk", async () => {
    active = mockFetch(() => ({ status: 207 }));
    const memoturn = new Memoturn(creds);
    const chunks = [
      { choices: [{ index: 0, delta: { role: "assistant", content: "Hel" } }] },
      { choices: [{ index: 0, delta: { content: "lo" } }] },
      {
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
      },
    ];
    const openai = wrapOpenAI(
      fakeOpenAI(async () => fakeChunks(chunks)),
      memoturn,
    );

    const stream = await openai.chat.completions.create({ model: "gpt-4o", messages: [], stream: true });
    await drain(stream);
    await memoturn.flush();

    const update = batchFrom(active).find((e) => e.type === "generation-update");
    expect(update?.body.output).toEqual({ role: "assistant", content: "Hello" });
    expect(update?.body.usage).toEqual({ promptTokens: 5, completionTokens: 2, totalTokens: 7 });
  });

  it("accumulates tool-call argument fragments by index", async () => {
    active = mockFetch(() => ({ status: 207 }));
    const memoturn = new Memoturn(creds);
    const chunks = [
      {
        choices: [
          {
            index: 0,
            delta: {
              role: "assistant",
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
    const openai = wrapOpenAI(
      fakeOpenAI(async () => fakeChunks(chunks)),
      memoturn,
    );

    const stream = await openai.chat.completions.create({ model: "gpt-4o", messages: [], stream: true });
    await drain(stream);
    await memoturn.flush();

    const update = batchFrom(active).find((e) => e.type === "generation-update");
    expect(update?.body.output).toMatchObject({
      role: "assistant",
      tool_calls: [{ id: "call_1", type: "function", function: { name: "get_weather", arguments: '{"city":"nyc"}' } }],
    });
  });

  it("auto-injects stream_options.include_usage when the caller didn't set one", async () => {
    active = mockFetch(() => ({ status: 207 }));
    const memoturn = new Memoturn(creds);
    let receivedParams: any;
    const openai = wrapOpenAI(
      fakeOpenAI(async (params) => {
        receivedParams = params;
        return fakeChunks([]);
      }),
      memoturn,
    );

    const stream = await openai.chat.completions.create({ model: "gpt-4o", messages: [], stream: true });
    await drain(stream);

    expect(receivedParams.stream_options).toEqual({ include_usage: true });
  });

  it("respects an explicit caller stream_options value, including include_usage: false", async () => {
    active = mockFetch(() => ({ status: 207 }));
    const memoturn = new Memoturn(creds);
    let receivedParams: any;
    const openai = wrapOpenAI(
      fakeOpenAI(async (params) => {
        receivedParams = params;
        return fakeChunks([]);
      }),
      memoturn,
    );

    const stream = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [],
      stream: true,
      stream_options: { include_usage: false },
    });
    await drain(stream);

    expect(receivedParams.stream_options).toEqual({ include_usage: false });
  });

  it("marks the generation ERROR with partial output when the stream throws mid-iteration, and rethrows", async () => {
    active = mockFetch(() => ({ status: 207 }));
    const memoturn = new Memoturn(creds);
    async function* throwingChunks() {
      yield { choices: [{ index: 0, delta: { role: "assistant", content: "Hel" } }] };
      throw new Error("connection reset");
    }
    const openai = wrapOpenAI(
      fakeOpenAI(async () => throwingChunks()),
      memoturn,
    );

    const stream = await openai.chat.completions.create({ model: "gpt-4o", messages: [], stream: true });
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
    const openai = wrapOpenAI(
      fakeOpenAI(async () => fakeChunks(chunks)),
      memoturn,
    );

    const stream = await openai.chat.completions.create({ model: "gpt-4o", messages: [], stream: true });
    for await (const _chunk of stream as AsyncIterable<unknown>) {
      break;
    }
    await memoturn.flush();

    const update = batchFrom(active).find((e) => e.type === "generation-update");
    expect(update?.body.level).toBe("WARNING");
    expect(update?.body.statusMessage).toBe("stream ended before completion");
    expect(update?.body.output).toEqual({ role: "assistant", content: "Hel" });
  });

  it("passes through non-iteration properties (e.g. .controller) unchanged", async () => {
    active = mockFetch(() => ({ status: 207 }));
    const memoturn = new Memoturn(creds);
    const controller = { abort: () => {} };
    const rawStream = Object.assign(fakeChunks([]), { controller });
    const openai = wrapOpenAI(
      fakeOpenAI(async () => rawStream),
      memoturn,
    );

    const stream = await openai.chat.completions.create({ model: "gpt-4o", messages: [], stream: true });
    expect((stream as any).controller).toBe(controller);
  });
});

describe("wrapOpenAI responses streaming", () => {
  it("captures the final Response from the response.completed terminal event", async () => {
    active = mockFetch(() => ({ status: 207 }));
    const memoturn = new Memoturn(creds);
    const finalResponse = {
      output_text: "it works",
      output: [{ type: "message", content: [{ type: "output_text", text: "it works" }] }],
      usage: { input_tokens: 12, output_tokens: 7, total_tokens: 19 },
    };
    async function* events() {
      yield { type: "response.output_text.delta", delta: "it " };
      yield { type: "response.completed", response: finalResponse };
    }
    const openai = wrapOpenAI({ responses: { create: async () => events() } }, memoturn);

    const stream = await openai.responses.create({ model: "gpt-4o", input: "hi", stream: true });
    await drain(stream);
    await memoturn.flush();

    const update = batchFrom(active).find((e) => e.type === "generation-update");
    expect(update?.body.output).toBe("it works");
    expect(update?.body.usage).toEqual({ promptTokens: 12, completionTokens: 7, totalTokens: 19 });
    expect(update?.body.level).toBeUndefined();
  });

  it("marks ERROR when the stream ends with no terminal event ever seen", async () => {
    active = mockFetch(() => ({ status: 207 }));
    const memoturn = new Memoturn(creds);
    async function* events() {
      yield { type: "response.output_text.delta", delta: "partial" };
    }
    const openai = wrapOpenAI({ responses: { create: async () => events() } }, memoturn);

    const stream = await openai.responses.create({ model: "gpt-4o", input: "hi", stream: true });
    await drain(stream);
    await memoturn.flush();

    const update = batchFrom(active).find((e) => e.type === "generation-update");
    expect(update?.body.level).toBe("ERROR");
  });
});
