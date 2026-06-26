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
});
