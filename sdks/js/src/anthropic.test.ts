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

  it("passes streaming calls through unwrapped without recording", async () => {
    active = mockFetch(() => ({ status: 207 }));
    const memoturn = new Memoturn(creds);
    const stream = { [Symbol.asyncIterator]: () => ({ next: async () => ({ done: true, value: undefined }) }) };
    const anthropic = wrapAnthropic(
      fakeAnthropic(async () => stream),
      memoturn,
    );

    const res = await anthropic.messages.create({
      model: "claude-sonnet-4-5",
      max_tokens: 8,
      messages: [],
      stream: true,
    });
    expect(res).toBe(stream);
    await memoturn.flush();

    expect(active.calls).toHaveLength(0); // nothing buffered, nothing flushed
  });

  it("leaves non-messages properties on the client untouched", () => {
    const memoturn = new Memoturn(creds);
    const base = { ...fakeAnthropic(async () => message), apiKey: "sk-ant-real", models: { list: () => [] } };
    const anthropic = wrapAnthropic(base, memoturn);
    expect(anthropic.apiKey).toBe("sk-ant-real");
    expect(typeof anthropic.models.list).toBe("function");
  });
});
