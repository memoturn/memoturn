import { afterEach, describe, expect, it } from "vitest";
import { Memoturn } from "./client.js";
import { decodeBasic, mockFetch } from "./test-helpers.js";
import type { IngestEnvelope } from "./types.js";

const creds = { baseUrl: "http://api.test", publicKey: "pk-mt-x", secretKey: "sk-mt-y", flushAt: 1000 };

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
