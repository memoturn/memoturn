import { afterEach, describe, expect, it } from "vitest";
import { Memoturn } from "./client.js";
import { wrapMistral } from "./mistral.js";
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

/** Minimal stand-in for the Mistral SDK surface the wrapper touches (`chat.complete`/`chat.stream`). */
function fakeMistral(impl: {
  complete?: (params: unknown) => Promise<unknown>;
  stream?: (params: unknown) => Promise<unknown>;
}) {
  return { chat: { complete: impl.complete ?? (async () => ({})), stream: impl.stream ?? (async () => ({})) } };
}

// Mistral's Speakeasy SDK remaps wire snake_case to camelCase — usage/toolCalls are camelCase here.
const completion = {
  id: "cmpl-1",
  model: "mistral-large-latest",
  choices: [{ index: 0, message: { role: "assistant", content: "4" }, finishReason: "stop" }],
  usage: { promptTokens: 10, completionTokens: 1, totalTokens: 11 },
};

describe("wrapMistral", () => {
  it("records a generation with model, params (exclusion-list), input, output, and camelCase usage passthrough", async () => {
    active = mockFetch(() => ({ status: 207 }));
    const memoturn = new Memoturn(creds);
    const mistral = wrapMistral(fakeMistral({ complete: async () => completion }), memoturn);

    const res = await mistral.chat.complete({
      model: "mistral-large-latest",
      messages: [{ role: "user", content: "2+2?" }],
      temperature: 0.2,
      topP: 0.9,
    });
    expect(res).toBe(completion);
    await memoturn.flush();

    const batch = batchFrom(active);
    const create = batch.find((e) => e.type === "generation-create");
    const update = batch.find((e) => e.type === "generation-update");
    expect(create?.body).toMatchObject({
      name: "mistral.chat",
      model: "mistral-large-latest",
      provider: "mistral",
    });
    // Exclusion-list, not allowlist: an arbitrary extra param (topP) must appear.
    expect(create?.body.modelParameters).toEqual({ temperature: 0.2, topP: 0.9 });
    expect(create?.body.input).toEqual([{ role: "user", content: "2+2?" }]);
    expect(update?.body.output).toEqual({ role: "assistant", content: "4" });
    expect(update?.body.usage).toEqual({ promptTokens: 10, completionTokens: 1, totalTokens: 11 });
  });

  it("creates a default trace per call, or nests under a provided trace", async () => {
    active = mockFetch(() => ({ status: 207 }));
    const memoturn = new Memoturn(creds);
    const trace = memoturn.trace({ name: "outer" });
    const mistral = wrapMistral(fakeMistral({ complete: async () => completion }), memoturn, { trace });

    await mistral.chat.complete({ model: "mistral-large-latest", messages: [] });
    await memoturn.flush();

    const gen = batchFrom(active).find((e) => e.type === "generation-create");
    expect(gen?.body.traceId).toBe(trace.id);
  });

  it("marks the generation as ERROR and rethrows when the call fails", async () => {
    active = mockFetch(() => ({ status: 207 }));
    const memoturn = new Memoturn(creds);
    const mistral = wrapMistral(
      fakeMistral({
        complete: async () => {
          throw new Error("capacity exceeded");
        },
      }),
      memoturn,
    );

    await expect(mistral.chat.complete({ model: "mistral-large-latest", messages: [] })).rejects.toThrow(
      "capacity exceeded",
    );
    await memoturn.flush();

    const update = batchFrom(active).find((e) => e.type === "generation-update");
    expect(update?.body.level).toBe("ERROR");
    expect(String(update?.body.statusMessage)).toContain("capacity exceeded");
  });

  it("leaves non-chat properties on the client untouched", () => {
    const memoturn = new Memoturn(creds);
    const base = {
      ...fakeMistral({ complete: async () => completion }),
      apiKey: "sk-real",
      models: { list: () => [] },
    };
    const mistral = wrapMistral(base, memoturn);
    expect(mistral.apiKey).toBe("sk-real");
    expect(typeof mistral.models.list).toBe("function");
  });
});

/** Minimal fake event stream — Mistral's EventStream is async-iterable, each event wrapping the
 * chunk in `.data` (`CompletionEvent { data: CompletionChunk }`). */
async function* fakeMistralEvents(events: unknown[]) {
  for (const event of events) yield event;
}

async function drain(stream: unknown): Promise<void> {
  for await (const _ of stream as AsyncIterable<unknown>) {
    // just drain
  }
}

describe("wrapMistral streaming", () => {
  it("yields every event to the caller unchanged and in order (no buffering)", async () => {
    active = mockFetch(() => ({ status: 207 }));
    const memoturn = new Memoturn(creds);
    const events = [
      { data: { choices: [{ index: 0, delta: { role: "assistant", content: "Hel" } }] } },
      { data: { choices: [{ index: 0, delta: { content: "lo" } }] } },
    ];
    const mistral = wrapMistral(fakeMistral({ stream: async () => fakeMistralEvents(events) }), memoturn);

    const stream = await mistral.chat.stream({ model: "mistral-large-latest", messages: [] });
    const seen: unknown[] = [];
    for await (const event of stream as AsyncIterable<unknown>) seen.push(event);

    expect(seen).toEqual(events);
  });

  it("accumulates content deltas (under the .data wrapper) and toolCalls fragments by index", async () => {
    active = mockFetch(() => ({ status: 207 }));
    const memoturn = new Memoturn(creds);
    const events = [
      { data: { choices: [{ index: 0, delta: { role: "assistant", content: "Hel" } }] } },
      { data: { choices: [{ index: 0, delta: { content: "lo" } }] } },
      {
        data: {
          choices: [
            {
              index: 0,
              delta: {
                toolCalls: [
                  { index: 0, id: "call_1", type: "function", function: { name: "get_weather", arguments: "" } },
                ],
              },
            },
          ],
        },
      },
      { data: { choices: [{ index: 0, delta: { toolCalls: [{ index: 0, function: { arguments: '{"city":' } }] } }] } },
      { data: { choices: [{ index: 0, delta: { toolCalls: [{ index: 0, function: { arguments: '"nyc"}' } }] } }] } },
    ];
    const mistral = wrapMistral(fakeMistral({ stream: async () => fakeMistralEvents(events) }), memoturn);

    const stream = await mistral.chat.stream({ model: "mistral-large-latest", messages: [] });
    await drain(stream);
    await memoturn.flush();

    const update = batchFrom(active).find((e) => e.type === "generation-update");
    expect(update?.body.output).toMatchObject({
      role: "assistant",
      content: "Hello",
      toolCalls: [{ id: "call_1", type: "function", function: { name: "get_weather", arguments: '{"city":"nyc"}' } }],
    });
  });

  it("captures usage from the final chunk (camelCase, under .data)", async () => {
    active = mockFetch(() => ({ status: 207 }));
    const memoturn = new Memoturn(creds);
    const events = [
      { data: { choices: [{ index: 0, delta: { role: "assistant", content: "Hi" } }] } },
      {
        data: {
          choices: [{ index: 0, delta: {}, finishReason: "stop" }],
          usage: { promptTokens: 5, completionTokens: 2, totalTokens: 7 },
        },
      },
    ];
    const mistral = wrapMistral(fakeMistral({ stream: async () => fakeMistralEvents(events) }), memoturn);

    const stream = await mistral.chat.stream({ model: "mistral-large-latest", messages: [] });
    await drain(stream);
    await memoturn.flush();

    const update = batchFrom(active).find((e) => e.type === "generation-update");
    expect(update?.body.usage).toEqual({ promptTokens: 5, completionTokens: 2, totalTokens: 7 });
  });

  it("leaves usage undefined (no crash) when no chunk carries it", async () => {
    active = mockFetch(() => ({ status: 207 }));
    const memoturn = new Memoturn(creds);
    const events = [{ data: { choices: [{ index: 0, delta: { role: "assistant", content: "Hi" } }] } }];
    const mistral = wrapMistral(fakeMistral({ stream: async () => fakeMistralEvents(events) }), memoturn);

    const stream = await mistral.chat.stream({ model: "mistral-large-latest", messages: [] });
    await drain(stream);
    await memoturn.flush();

    const update = batchFrom(active).find((e) => e.type === "generation-update");
    expect(update?.body.usage).toBeUndefined();
  });

  it("marks the generation ERROR with partial output when the stream throws mid-iteration, and rethrows", async () => {
    active = mockFetch(() => ({ status: 207 }));
    const memoturn = new Memoturn(creds);
    async function* throwingEvents() {
      yield { data: { choices: [{ index: 0, delta: { role: "assistant", content: "Hel" } }] } };
      throw new Error("connection reset");
    }
    const mistral = wrapMistral(fakeMistral({ stream: async () => throwingEvents() }), memoturn);

    const stream = await mistral.chat.stream({ model: "mistral-large-latest", messages: [] });
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
    const events = [
      { data: { choices: [{ index: 0, delta: { role: "assistant", content: "Hel" } }] } },
      { data: { choices: [{ index: 0, delta: { content: "lo, world" } }] } },
    ];
    const mistral = wrapMistral(fakeMistral({ stream: async () => fakeMistralEvents(events) }), memoturn);

    const stream = await mistral.chat.stream({ model: "mistral-large-latest", messages: [] });
    for await (const _event of stream as AsyncIterable<unknown>) {
      break;
    }
    await memoturn.flush();

    const update = batchFrom(active).find((e) => e.type === "generation-update");
    expect(update?.body.level).toBe("WARNING");
    expect(update?.body.statusMessage).toBe("stream ended before completion");
    expect(update?.body.output).toEqual({ role: "assistant", content: "Hel" });
  });

  it("tolerates unwrapped chunks (no .data) and array-of-parts delta content on SDK drift", async () => {
    active = mockFetch(() => ({ status: 207 }));
    const memoturn = new Memoturn(creds);
    const events = [
      { choices: [{ index: 0, delta: { role: "assistant", content: "He" } }] },
      { choices: [{ index: 0, delta: { content: [{ type: "text", text: "llo" }] } }] },
    ];
    const mistral = wrapMistral(fakeMistral({ stream: async () => fakeMistralEvents(events) }), memoturn);

    const stream = await mistral.chat.stream({ model: "mistral-large-latest", messages: [] });
    await drain(stream);
    await memoturn.flush();

    const update = batchFrom(active).find((e) => e.type === "generation-update");
    expect(update?.body.output).toEqual({ role: "assistant", content: "Hello" });
  });
});
