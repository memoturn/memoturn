import { afterEach, describe, expect, it } from "vitest";
import { Memoturn } from "./client.js";
import { wrapGemini } from "./gemini.js";
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

/** Minimal stand-in for the Gemini SDK surface the wrapper touches. */
function fakeGemini(
  generateContent: (params: unknown) => Promise<unknown>,
  generateContentStream?: (params: unknown) => Promise<unknown>,
) {
  return { models: { generateContent, generateContentStream } };
}

const response = {
  text: "4",
  candidates: [{ content: { parts: [{ text: "4" }] } }],
  usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2 },
};

describe("wrapGemini", () => {
  it("records model/modelParameters/input incl. systemInstruction", async () => {
    active = mockFetch(() => ({ status: 207 }));
    const memoturn = new Memoturn(creds);
    const gemini = wrapGemini(
      fakeGemini(async () => response),
      memoturn,
    );

    const res = await gemini.models.generateContent({
      model: "gemini-2.5-flash",
      contents: [{ role: "user", parts: [{ text: "2+2?" }] }],
      config: { systemInstruction: "be terse", temperature: 0.2, maxOutputTokens: 64 },
    });
    expect(res).toBe(response);
    await memoturn.flush();

    const batch = batchFrom(active);
    const create = batch.find((e) => e.type === "generation-create");
    const update = batch.find((e) => e.type === "generation-update");
    expect(create?.body).toMatchObject({
      name: "gemini.generateContent",
      model: "gemini-2.5-flash",
      provider: "gemini",
    });
    expect(create?.body.modelParameters).toEqual({ temperature: 0.2, maxOutputTokens: 64 });
    expect(create?.body.input).toEqual({
      systemInstruction: "be terse",
      contents: [{ role: "user", parts: [{ text: "2+2?" }] }],
    });
    expect(update?.body.output).toBe("4");
  });

  it("uses bare contents as input when no systemInstruction is present", async () => {
    active = mockFetch(() => ({ status: 207 }));
    const memoturn = new Memoturn(creds);
    const contents = [{ role: "user", parts: [{ text: "hi" }] }];
    const gemini = wrapGemini(
      fakeGemini(async () => response),
      memoturn,
    );

    await gemini.models.generateContent({ model: "gemini-2.5-flash", contents, config: { temperature: 0.1 } });
    await memoturn.flush();

    const create = batchFrom(active).find((e) => e.type === "generation-create");
    expect(create?.body.input).toEqual(contents);
    expect(create?.body.modelParameters).toEqual({ temperature: 0.1 });
  });

  it("computes totalTokens when both prompt/candidates counts are present, and includes cacheReadTokens", async () => {
    active = mockFetch(() => ({ status: 207 }));
    const memoturn = new Memoturn(creds);
    const gemini = wrapGemini(
      fakeGemini(async () => ({
        text: "hi",
        usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 3, cachedContentTokenCount: 5 },
      })),
      memoturn,
    );

    await gemini.models.generateContent({ model: "gemini-2.5-flash", contents: [], config: {} });
    await memoturn.flush();

    const update = batchFrom(active).find((e) => e.type === "generation-update");
    expect(update?.body.usage).toEqual({
      promptTokens: 8,
      completionTokens: 3,
      totalTokens: 11,
      cacheReadTokens: 5,
    });
  });

  it("omits totalTokens and cacheReadTokens when the underlying fields are absent", async () => {
    active = mockFetch(() => ({ status: 207 }));
    const memoturn = new Memoturn(creds);
    const gemini = wrapGemini(
      fakeGemini(async () => ({ text: "hi", usageMetadata: { promptTokenCount: 8 } })),
      memoturn,
    );

    await gemini.models.generateContent({ model: "gemini-2.5-flash", contents: [], config: {} });
    await memoturn.flush();

    const update = batchFrom(active).find((e) => e.type === "generation-update");
    expect(update?.body.usage).toEqual({ promptTokens: 8, completionTokens: undefined });
  });

  it("creates a default trace per call, or nests under a provided trace", async () => {
    active = mockFetch(() => ({ status: 207 }));
    const memoturn = new Memoturn(creds);
    const trace = memoturn.trace({ name: "outer" });
    const gemini = wrapGemini(
      fakeGemini(async () => response),
      memoturn,
      { trace },
    );

    await gemini.models.generateContent({ model: "gemini-2.5-flash", contents: [], config: {} });
    await memoturn.flush();

    const gen = batchFrom(active).find((e) => e.type === "generation-create");
    expect(gen?.body.traceId).toBe(trace.id);
  });

  it("uses the default trace name gemini.generateContent when no trace is provided", async () => {
    active = mockFetch(() => ({ status: 207 }));
    const memoturn = new Memoturn(creds);
    const gemini = wrapGemini(
      fakeGemini(async () => response),
      memoturn,
    );

    await gemini.models.generateContent({ model: "gemini-2.5-flash", contents: [], config: {} });
    await memoturn.flush();

    const traceCreate = batchFrom(active).find((e) => e.type === "trace-create");
    expect(traceCreate?.body.name).toBe("gemini.generateContent");
  });

  it("marks the generation ERROR and rethrows when the call fails", async () => {
    active = mockFetch(() => ({ status: 207 }));
    const memoturn = new Memoturn(creds);
    const gemini = wrapGemini(
      fakeGemini(async () => {
        throw new Error("quota exceeded");
      }),
      memoturn,
    );

    await expect(
      gemini.models.generateContent({ model: "gemini-2.5-flash", contents: [], config: {} }),
    ).rejects.toThrow("quota exceeded");
    await memoturn.flush();

    const update = batchFrom(active).find((e) => e.type === "generation-update");
    expect(update?.body.level).toBe("ERROR");
    expect(String(update?.body.statusMessage)).toContain("quota exceeded");
  });

  it("leaves non-models properties on the client untouched", () => {
    const memoturn = new Memoturn(creds);
    const base = { ...fakeGemini(async () => response), apiKey: "gm-real", chats: { create: () => ({}) } };
    const gemini = wrapGemini(base, memoturn);
    expect(gemini.apiKey).toBe("gm-real");
    expect(typeof gemini.chats.create).toBe("function");
  });
});

/** Minimal fake Gemini streamed-response source — real async generators are already async-iterable. */
async function* fakeGeminiChunks(chunks: unknown[]) {
  for (const chunk of chunks) yield chunk;
}

async function drain(stream: unknown): Promise<void> {
  for await (const _chunk of stream as AsyncIterable<unknown>) {
    // just drain
  }
}

describe("wrapGemini streaming", () => {
  it("yields every chunk unchanged while concatenating text deltas and taking the latest usage", async () => {
    active = mockFetch(() => ({ status: 207 }));
    const memoturn = new Memoturn(creds);
    const chunks = [
      { text: "Hel", usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 1 } },
      { text: "lo", usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2 } },
    ];
    const gemini = wrapGemini(
      fakeGemini(
        async () => response,
        async () => fakeGeminiChunks(chunks),
      ),
      memoturn,
    );

    const stream = await gemini.models.generateContentStream({
      model: "gemini-2.5-flash",
      contents: [],
      config: {},
    });
    const seen: unknown[] = [];
    for await (const chunk of stream as AsyncIterable<unknown>) seen.push(chunk);
    expect(seen).toEqual(chunks);
    await memoturn.flush();

    const update = batchFrom(active).find((e) => e.type === "generation-update");
    expect(update?.body.output).toBe("Hello");
    expect(update?.body.usage).toEqual({ promptTokens: 10, completionTokens: 2, totalTokens: 12 });
  });

  it("uses the default trace name gemini.generateContentStream", async () => {
    active = mockFetch(() => ({ status: 207 }));
    const memoturn = new Memoturn(creds);
    const gemini = wrapGemini(
      fakeGemini(
        async () => response,
        async () => fakeGeminiChunks([]),
      ),
      memoturn,
    );

    const stream = await gemini.models.generateContentStream({
      model: "gemini-2.5-flash",
      contents: [],
      config: {},
    });
    await drain(stream);
    await memoturn.flush();

    const traceCreate = batchFrom(active).find((e) => e.type === "trace-create");
    expect(traceCreate?.body.name).toBe("gemini.generateContentStream");
  });

  it("marks the generation ERROR with partial accumulated output when the stream throws mid-iteration, and rethrows", async () => {
    active = mockFetch(() => ({ status: 207 }));
    const memoturn = new Memoturn(creds);
    async function* throwingChunks() {
      yield { text: "Hel" };
      throw new Error("connection reset");
    }
    const gemini = wrapGemini(
      fakeGemini(
        async () => response,
        async () => throwingChunks(),
      ),
      memoturn,
    );

    const stream = await gemini.models.generateContentStream({
      model: "gemini-2.5-flash",
      contents: [],
      config: {},
    });
    await expect(drain(stream)).rejects.toThrow("connection reset");
    await memoturn.flush();

    const update = batchFrom(active).find((e) => e.type === "generation-update");
    expect(update?.body.level).toBe("ERROR");
    expect(String(update?.body.statusMessage)).toContain("connection reset");
    expect(update?.body.output).toBe("Hel");
  });

  it("marks the generation WARNING with partial accumulated output when the caller breaks out of the loop early", async () => {
    active = mockFetch(() => ({ status: 207 }));
    const memoturn = new Memoturn(creds);
    const chunks = [{ text: "Hel" }, { text: "lo, world" }];
    const gemini = wrapGemini(
      fakeGemini(
        async () => response,
        async () => fakeGeminiChunks(chunks),
      ),
      memoturn,
    );

    const stream = await gemini.models.generateContentStream({
      model: "gemini-2.5-flash",
      contents: [],
      config: {},
    });
    let seen = 0;
    for await (const _chunk of stream as AsyncIterable<unknown>) {
      seen += 1;
      if (seen === 1) break; // stop right after "Hel", before "lo, world"
    }
    await memoturn.flush();

    const update = batchFrom(active).find((e) => e.type === "generation-update");
    expect(update?.body.level).toBe("WARNING");
    expect(update?.body.statusMessage).toBe("stream ended before completion");
    expect(update?.body.output).toBe("Hel");
  });

  it("passes through non-iteration properties (e.g. .controller) unchanged", async () => {
    active = mockFetch(() => ({ status: 207 }));
    const memoturn = new Memoturn(creds);
    const controller = { abort: () => {} };
    const rawStream = Object.assign(fakeGeminiChunks([]), { controller });
    const gemini = wrapGemini(
      fakeGemini(
        async () => response,
        async () => rawStream,
      ),
      memoturn,
    );

    const stream = await gemini.models.generateContentStream({
      model: "gemini-2.5-flash",
      contents: [],
      config: {},
    });
    expect((stream as any).controller).toBe(controller);
  });
});
