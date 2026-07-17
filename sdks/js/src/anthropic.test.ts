import { afterEach, describe, expect, it } from "vitest";
import { wrapAnthropic } from "./anthropic.js";
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

/** Minimal stand-in for the Anthropic SDK surface the wrapper touches. */
function fakeAnthropic(impl: (params: unknown) => Promise<unknown>) {
  return { messages: { create: impl } };
}

const message = {
  content: [{ type: "text", text: "4" }],
  usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 7, cache_creation_input_tokens: 3 },
};

describe("wrapAnthropic", () => {
  it("records a generation with model, allowlisted params, input incl. system, output, and mapped usage", async () => {
    active = mockFetch(() => ({ status: 207 }));
    const memoturn = new Memoturn(creds);
    const anthropic = wrapAnthropic(
      fakeAnthropic(async () => message),
      memoturn,
    );

    const res = await anthropic.messages.create({
      model: "claude-sonnet-4-5",
      max_tokens: 64,
      temperature: 0.2,
      system: "be terse",
      messages: [{ role: "user", content: "2+2?" }],
      metadata: { user_id: "u1" }, // not in the allowlist — must not be recorded as a param
    });
    expect(res).toBe(message);
    await memoturn.flush();

    const batch = batchFrom(active);
    const create = batch.find((e) => e.type === "generation-create");
    const update = batch.find((e) => e.type === "generation-update");
    expect(create?.body).toMatchObject({
      name: "anthropic.messages",
      model: "claude-sonnet-4-5",
      provider: "anthropic",
    });
    expect(create?.body.modelParameters).toEqual({ max_tokens: 64, temperature: 0.2 });
    expect(create?.body.input).toEqual({ system: "be terse", messages: [{ role: "user", content: "2+2?" }] });
    expect(update?.body.output).toEqual(message.content);
    expect(update?.body.usage).toEqual({
      promptTokens: 10,
      completionTokens: 2,
      totalTokens: 12,
      cacheReadTokens: 7,
      cacheCreationTokens: 3,
    });
  });

  it("omits cache token fields when the provider does not report them", async () => {
    active = mockFetch(() => ({ status: 207 }));
    const memoturn = new Memoturn(creds);
    const anthropic = wrapAnthropic(
      fakeAnthropic(async () => ({ content: [], usage: { input_tokens: 5, output_tokens: 1 } })),
      memoturn,
    );

    await anthropic.messages.create({ model: "claude-haiku-4-5", max_tokens: 8, messages: [] });
    await memoturn.flush();

    const update = batchFrom(active).find((e) => e.type === "generation-update");
    expect(update?.body.usage).toEqual({ promptTokens: 5, completionTokens: 1, totalTokens: 6 });
  });

  it("creates a default trace per call, or nests under a provided trace", async () => {
    active = mockFetch(() => ({ status: 207 }));
    const memoturn = new Memoturn(creds);
    const trace = memoturn.trace({ name: "outer" });
    const anthropic = wrapAnthropic(
      fakeAnthropic(async () => message),
      memoturn,
      { trace },
    );

    await anthropic.messages.create({ model: "claude-sonnet-4-5", max_tokens: 8, messages: [] });
    await memoturn.flush();

    const gen = batchFrom(active).find((e) => e.type === "generation-create");
    expect(gen?.body.traceId).toBe(trace.id);
  });

  it("marks the generation as ERROR and rethrows when the call fails", async () => {
    active = mockFetch(() => ({ status: 207 }));
    const memoturn = new Memoturn(creds);
    const anthropic = wrapAnthropic(
      fakeAnthropic(async () => {
        throw new Error("overloaded");
      }),
      memoturn,
    );

    await expect(
      anthropic.messages.create({ model: "claude-sonnet-4-5", max_tokens: 8, messages: [] }),
    ).rejects.toThrow("overloaded");
    await memoturn.flush();

    const update = batchFrom(active).find((e) => e.type === "generation-update");
    expect(update?.body.level).toBe("ERROR");
    expect(String(update?.body.statusMessage)).toContain("overloaded");
  });

  it("leaves non-messages properties on the client untouched", () => {
    const memoturn = new Memoturn(creds);
    const base = { ...fakeAnthropic(async () => message), apiKey: "sk-ant-real", models: { list: () => [] } };
    const anthropic = wrapAnthropic(base, memoturn);
    expect(anthropic.apiKey).toBe("sk-ant-real");
    expect(typeof anthropic.models.list).toBe("function");
  });
});

/** Minimal fake Anthropic streaming-events source — real async generators are already async-iterable. */
async function* fakeAnthropicStream(events: unknown[]) {
  for (const event of events) yield event;
}

async function drain(stream: unknown): Promise<void> {
  for await (const _event of stream as AsyncIterable<unknown>) {
    // just drain
  }
}

describe("wrapAnthropic streaming", () => {
  it("accumulates text deltas and captures usage incl. cache tokens", async () => {
    active = mockFetch(() => ({ status: 207 }));
    const memoturn = new Memoturn(creds);
    const events = [
      {
        type: "message_start",
        message: { usage: { input_tokens: 10, cache_read_input_tokens: 7, cache_creation_input_tokens: 3 } },
      },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hel" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "lo" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } },
      { type: "message_stop" },
    ];
    const anthropic = wrapAnthropic(
      fakeAnthropic(async () => fakeAnthropicStream(events)),
      memoturn,
    );

    const stream = await anthropic.messages.create({
      model: "claude-sonnet-4-5",
      max_tokens: 8,
      messages: [],
      stream: true,
    });
    await drain(stream);
    await memoturn.flush();

    const update = batchFrom(active).find((e) => e.type === "generation-update");
    expect(update?.body.output).toEqual([{ type: "text", text: "Hello" }]);
    expect(update?.body.usage).toEqual({
      promptTokens: 10,
      completionTokens: 2,
      totalTokens: 12,
      cacheReadTokens: 7,
      cacheCreationTokens: 3,
    });
  });

  it("accumulates tool_use input_json_delta fragments and JSON-parses the final input", async () => {
    active = mockFetch(() => ({ status: 207 }));
    const memoturn = new Memoturn(creds);
    const events = [
      { type: "message_start", message: { usage: { input_tokens: 4 } } },
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "toolu_1", name: "get_weather", input: {} },
      },
      { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"city":' } },
      { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '"nyc"}' } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 3 } },
      { type: "message_stop" },
    ];
    const anthropic = wrapAnthropic(
      fakeAnthropic(async () => fakeAnthropicStream(events)),
      memoturn,
    );

    const stream = await anthropic.messages.create({
      model: "claude-sonnet-4-5",
      max_tokens: 8,
      messages: [],
      stream: true,
    });
    await drain(stream);
    await memoturn.flush();

    const update = batchFrom(active).find((e) => e.type === "generation-update");
    expect(update?.body.output).toEqual([
      { type: "tool_use", id: "toolu_1", name: "get_weather", input: { city: "nyc" } },
    ]);
  });

  it("marks the generation ERROR with partial output when the stream throws mid-iteration, and rethrows", async () => {
    active = mockFetch(() => ({ status: 207 }));
    const memoturn = new Memoturn(creds);
    async function* throwingEvents() {
      yield { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } };
      yield { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hel" } };
      throw new Error("connection reset");
    }
    const anthropic = wrapAnthropic(
      fakeAnthropic(async () => throwingEvents()),
      memoturn,
    );

    const stream = await anthropic.messages.create({
      model: "claude-sonnet-4-5",
      max_tokens: 8,
      messages: [],
      stream: true,
    });
    await expect(drain(stream)).rejects.toThrow("connection reset");
    await memoturn.flush();

    const update = batchFrom(active).find((e) => e.type === "generation-update");
    expect(update?.body.level).toBe("ERROR");
    expect(String(update?.body.statusMessage)).toContain("connection reset");
    expect(update?.body.output).toEqual([{ type: "text", text: "Hel" }]);
  });

  it("marks the generation WARNING with partial output when the caller breaks out of the loop early", async () => {
    active = mockFetch(() => ({ status: 207 }));
    const memoturn = new Memoturn(creds);
    const events = [
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hel" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "lo, world" } },
    ];
    const anthropic = wrapAnthropic(
      fakeAnthropic(async () => fakeAnthropicStream(events)),
      memoturn,
    );

    const stream = await anthropic.messages.create({
      model: "claude-sonnet-4-5",
      max_tokens: 8,
      messages: [],
      stream: true,
    });
    let seen = 0;
    for await (const _event of stream as AsyncIterable<unknown>) {
      seen += 1;
      if (seen === 2) break; // stop right after the "Hel" text_delta, before "lo, world"
    }
    await memoturn.flush();

    const update = batchFrom(active).find((e) => e.type === "generation-update");
    expect(update?.body.level).toBe("WARNING");
    expect(update?.body.statusMessage).toBe("stream ended before completion");
    expect(update?.body.output).toEqual([{ type: "text", text: "Hel" }]);
  });

  it("passes through non-iteration properties (e.g. .controller) unchanged", async () => {
    active = mockFetch(() => ({ status: 207 }));
    const memoturn = new Memoturn(creds);
    const controller = { abort: () => {} };
    const rawStream = Object.assign(fakeAnthropicStream([]), { controller });
    const anthropic = wrapAnthropic(
      fakeAnthropic(async () => rawStream),
      memoturn,
    );

    const stream = await anthropic.messages.create({
      model: "claude-sonnet-4-5",
      max_tokens: 8,
      messages: [],
      stream: true,
    });
    expect((stream as any).controller).toBe(controller);
  });
});
