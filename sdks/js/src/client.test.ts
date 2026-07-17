import { afterEach, describe, expect, it, vi } from "vitest";
import { Memoturn } from "./client.js";
import { decodeBasic, mockFetch } from "./test-helpers.js";
import type { IngestEnvelope } from "./types.js";

const creds = {
  baseUrl: "http://api.test",
  publicKey: "pk-mt-x",
  secretKey: "sk-mt-y",
  flushAt: 1000,
  allowInsecureHttp: true,
};

let active: ReturnType<typeof mockFetch> | undefined;
afterEach(() => {
  active?.restore();
  active = undefined;
});

function setup(responder?: Parameters<typeof mockFetch>[0]) {
  active = mockFetch(responder);
  return active;
}

/** Pull the flushed `batch` array out of the single captured ingest request. */
function batchFrom(m: ReturnType<typeof mockFetch>): IngestEnvelope[] {
  return (m.calls[0].body as { batch: IngestEnvelope[] }).batch;
}

describe("Memoturn.flush", () => {
  it("POSTs to /v1/ingest with Basic auth and a {batch} body", async () => {
    const m = setup();
    const client = new Memoturn(creds);
    client.trace({ name: "t" });
    await client.flush();

    expect(m.calls).toHaveLength(1);
    const req = m.calls[0];
    expect(req.method).toBe("POST");
    expect(req.url).toBe("http://api.test/v1/ingest");
    expect(req.headers["content-type"]).toBe("application/json");
    expect(decodeBasic(req.headers.authorization)).toBe("pk-mt-x:sk-mt-y");
    expect(Array.isArray((req.body as { batch: unknown[] }).batch)).toBe(true);
  });

  it("is a no-op with an empty buffer (no request)", async () => {
    const m = setup();
    await new Memoturn(creds).flush();
    expect(m.calls).toHaveLength(0);
  });

  it("treats 207 multi-status as success and does not re-buffer", async () => {
    const m = setup(() => ({ status: 207 }));
    const client = new Memoturn(creds);
    client.trace();
    await client.flush();
    await client.flush(); // buffer already drained -> no second request
    expect(m.calls).toHaveLength(1);
  });

  it("re-buffers the batch and throws on a hard transport failure", async () => {
    const m = setup(() => ({ status: 500, text: "boom" }));
    const client = new Memoturn(creds);
    client.trace();
    await expect(client.flush()).rejects.toThrow(/memoturn ingest failed: 500/);
    // batch was put back; a successful retry sends it again
    m.restore();
    const ok = setup(() => ({ status: 207 }));
    await client.flush();
    expect(ok.calls).toHaveLength(1);
  });

  it("auto-flushes once the buffer reaches flushAt", async () => {
    const m = setup(() => ({ status: 207 }));
    const client = new Memoturn({ ...creds, flushAt: 2 });
    client.trace(); // 1 event -> buffered
    expect(m.calls).toHaveLength(0);
    client.trace(); // 2nd event hits flushAt -> flush
    await Promise.resolve();
    await new Promise((r) => setImmediate(r));
    expect(m.calls).toHaveLength(1);
  });
});

describe("event shapes", () => {
  it("trace() enqueues a trace-create with id + environment", async () => {
    const m = setup();
    const client = new Memoturn({ ...creds, environment: "staging" });
    const trace = client.trace({ name: "chat", userId: "u1" });
    await client.flush();

    const [ev] = batchFrom(m);
    expect(ev.type).toBe("trace-create");
    expect(typeof ev.id).toBe("string");
    expect(typeof ev.timestamp).toBe("string");
    expect(ev.body).toMatchObject({ id: trace.id, name: "chat", userId: "u1", environment: "staging" });
  });

  it("span + generation carry traceId, startTime, and the generation kind on update", async () => {
    const m = setup();
    const client = new Memoturn(creds);
    const trace = client.trace();
    const gen = trace.generation({ name: "llm", model: "gpt-4o", provider: "openai" });
    gen.end({ output: { text: "hi" }, usage: { totalTokens: 5 } });
    await client.flush();

    const batch = batchFrom(m);
    const create = batch.find((e) => e.type === "generation-create");
    const update = batch.find((e) => e.type === "generation-update");
    expect(create?.body).toMatchObject({ id: gen.id, traceId: trace.id, model: "gpt-4o", provider: "openai" });
    expect(create?.body.startTime).toBeTypeOf("string");
    expect(update?.body).toMatchObject({ id: gen.id, traceId: trace.id });
    expect(update?.body.endTime).toBeTypeOf("string");
    expect(update?.body.usage).toEqual({ totalTokens: 5 });
  });

  it("carries retrievedDocuments on a span and an embedding on a generation", async () => {
    const m = setup();
    const client = new Memoturn(creds);
    const trace = client.trace();
    const retriever = trace.span({
      name: "retriever",
      retrievedDocuments: [
        { rank: 0, score: 0.9, content: "doc a", id: "a" },
        { rank: 1, score: 0.4, content: "doc b" },
      ],
    });
    retriever.end();
    trace.generation({ name: "embed", model: "text-embedding-3-small", embedding: [0.1, 0.2, 0.3] });
    await client.flush();

    const batch = batchFrom(m);
    const span = batch.find((e) => e.body.id === retriever.id && e.type === "span-create");
    expect(span?.body.retrievedDocuments).toHaveLength(2);
    expect((span?.body.retrievedDocuments as { rank: number }[])[0]).toMatchObject({ rank: 0, score: 0.9 });
    const gen = batch.find((e) => e.type === "generation-create" && Array.isArray(e.body.embedding));
    expect(gen?.body.embedding).toEqual([0.1, 0.2, 0.3]);
  });

  it("nested span sets parentObservationId to the parent span", async () => {
    const m = setup();
    const client = new Memoturn(creds);
    const trace = client.trace();
    const parent = trace.span({ name: "outer" });
    const child = parent.span({ name: "inner" });
    await client.flush();

    const inner = batchFrom(m).find((e) => e.body.id === child.id);
    expect(inner?.body).toMatchObject({ parentObservationId: parent.id, traceId: trace.id });
  });

  it("score() enqueues a score-create with the trace id", async () => {
    const m = setup();
    const client = new Memoturn(creds);
    const trace = client.trace();
    trace.score({ name: "quality", value: 0.9, dataType: "NUMERIC" });
    await client.flush();

    const score = batchFrom(m).find((e) => e.type === "score-create");
    expect(score?.body).toMatchObject({ name: "quality", value: 0.9, traceId: trace.id });
  });

  it("update() re-emits a trace-create keyed by the same trace id", async () => {
    const m = setup();
    const client = new Memoturn(creds);
    const trace = client.trace({ name: "a" });
    trace.update({ output: { done: true } });
    await client.flush();

    const updates = batchFrom(m).filter((e) => e.type === "trace-create");
    expect(updates).toHaveLength(2);
    expect(updates.every((e) => e.body.id === trace.id)).toBe(true);
  });
});

describe("shutdown", () => {
  it("flushes remaining events", async () => {
    const m = setup(() => ({ status: 207 }));
    const client = new Memoturn(creds);
    client.trace();
    await client.shutdown();
    expect(m.calls).toHaveLength(1);
  });
});

describe("transport hardening", () => {
  it("drops the batch and throws on a permanent 4xx instead of retrying forever", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    setup(() => ({ status: 401, text: "unauthorized" }));
    const client = new Memoturn(creds);
    client.trace();
    await expect(client.flush()).rejects.toThrow(/rejected: 401/);
    expect(err).toHaveBeenCalledWith(expect.stringContaining("dropping 1 event(s)"));
    active?.restore();
    const ok = setup(() => ({ status: 207 }));
    await client.flush(); // batch was dropped, not re-buffered -> no request
    expect(ok.calls).toHaveLength(0);
    err.mockRestore();
  });

  it("re-buffers on 429 backpressure and retries on the next flush", async () => {
    setup(() => ({ status: 429, text: "slow down" }));
    const client = new Memoturn(creds);
    client.trace();
    await expect(client.flush()).rejects.toThrow(/failed: 429/);
    active?.restore();
    const ok = setup(() => ({ status: 207 }));
    await client.flush();
    expect(ok.calls).toHaveLength(1);
    expect((ok.calls[0].body as { batch: unknown[] }).batch).toHaveLength(1);
  });

  it("re-buffers when fetch itself rejects (network error), losing nothing", async () => {
    const original = global.fetch;
    global.fetch = (() => Promise.reject(new Error("ECONNREFUSED"))) as unknown as typeof fetch;
    const client = new Memoturn(creds);
    client.trace();
    await expect(client.flush()).rejects.toThrow(/ECONNREFUSED/);
    global.fetch = original;
    const ok = setup(() => ({ status: 207 }));
    await client.flush();
    expect(ok.calls).toHaveLength(1);
  });

  it("truncates long server error bodies in thrown errors", async () => {
    setup(() => ({ status: 500, text: "x".repeat(1000) }));
    const client = new Memoturn(creds);
    client.trace();
    const err = await client.flush().then(
      () => null,
      (e: Error) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect(String(err?.message).length).toBeLessThan(300);
  });

  it("caps the buffer at maxBufferSize, dropping new events with a warning", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const m = setup(() => ({ status: 207 }));
    const client = new Memoturn({ ...creds, maxBufferSize: 2 });
    client.trace();
    client.trace();
    client.trace(); // third is dropped
    await client.flush();
    expect(batchFrom(m)).toHaveLength(2);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("buffer full"));
    warn.mockRestore();
  });
});

describe("mask hook", () => {
  it("applies the mask to input/output/metadata before buffering", async () => {
    const m = setup();
    const client = new Memoturn({
      ...creds,
      mask: (value, ctx) => (ctx.field === "input" ? "[masked]" : value),
    });
    client.trace({ input: { ssn: "123-45-6789" }, output: { ok: true } });
    await client.flush();
    const [ev] = batchFrom(m);
    expect(ev.body.input).toBe("[masked]");
    expect(ev.body.output).toEqual({ ok: true });
  });

  it("covers child observations created via trace handles", async () => {
    const m = setup();
    const client = new Memoturn({ ...creds, mask: () => "[masked]" });
    const trace = client.trace();
    trace.generation({ name: "llm", input: [{ role: "user", content: "secret" }] });
    await client.flush();
    const gen = batchFrom(m).find((e) => e.type === "generation-create");
    expect(gen?.body.input).toBe("[masked]");
  });

  it("replaces the value with a sentinel when the mask throws — never the raw value", async () => {
    const m = setup();
    const client = new Memoturn({
      ...creds,
      mask: () => {
        throw new Error("mask bug");
      },
    });
    client.trace({ input: "raw secret" });
    await client.flush();
    expect(batchFrom(m)[0].body.input).toBe("<memoturn: mask error>");
  });
});

describe("environment resolution", () => {
  it("child observations inherit the per-trace environment, not the client default", async () => {
    const m = setup();
    const client = new Memoturn({ ...creds, environment: "default" });
    const trace = client.trace({ environment: "prod" });
    trace.span({ name: "child" });
    trace.score({ name: "quality", value: 1 });
    await client.flush();
    const batch = batchFrom(m);
    const span = batch.find((e) => e.type === "span-create");
    const score = batch.find((e) => e.type === "score-create");
    expect(span?.body.environment).toBe("prod");
    expect(score?.body.environment).toBe("prod");
  });
});

describe("construction warnings", () => {
  it("warns once when API keys go to a non-local http host", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    new Memoturn({ ...creds, baseUrl: "http://prod-collector.example:9999", allowInsecureHttp: false });
    new Memoturn({ ...creds, baseUrl: "http://prod-collector.example:9999", allowInsecureHttp: false });
    const insecure = warn.mock.calls.filter(([msg]) => String(msg).includes("cleartext http"));
    expect(insecure).toHaveLength(1);
    warn.mockRestore();
  });

  it("does not warn for localhost or when allowInsecureHttp is set", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    new Memoturn({ ...creds, baseUrl: "http://localhost:3001" });
    new Memoturn({ ...creds, baseUrl: "http://another-host.example:9999" }); // allowInsecureHttp via creds
    expect(warn.mock.calls.filter(([msg]) => String(msg).includes("cleartext http"))).toHaveLength(0);
    warn.mockRestore();
  });

  it("warns when no API keys are configured", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const saved = { pk: process.env.MEMOTURN_PUBLIC_KEY, sk: process.env.MEMOTURN_SECRET_KEY };
    delete process.env.MEMOTURN_PUBLIC_KEY;
    delete process.env.MEMOTURN_SECRET_KEY;
    new Memoturn({ baseUrl: "http://localhost:3001" });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("no API keys"));
    if (saved.pk) process.env.MEMOTURN_PUBLIC_KEY = saved.pk;
    if (saved.sk) process.env.MEMOTURN_SECRET_KEY = saved.sk;
    warn.mockRestore();
  });
});
