import { afterEach, describe, expect, it } from "vitest";
import { Memoturn } from "./client.js";
import { wrapPinecone } from "./pinecone.js";
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

/** Minimal stand-in for a Pinecone data-plane index handle. */
function fakePinecone(query: (params: unknown) => Promise<unknown>, extra: Record<string, unknown> = {}) {
  return { query, ...extra };
}

describe("wrapPinecone", () => {
  it("records a RETRIEVER span with matches mapped to retrievedDocuments (recognized metadata key)", async () => {
    active = mockFetch(() => ({ status: 207 }));
    const memoturn = new Memoturn(creds);
    const matches = [
      { id: "doc-1", score: 0.91, metadata: { content: "the quick brown fox" } },
      { id: "doc-2", score: 0.75, metadata: { content: "jumps over the lazy dog" } },
    ];
    const pinecone = wrapPinecone(
      fakePinecone(async () => ({ matches })),
      memoturn,
    );

    const res = await pinecone.query({ vector: [0.1, 0.2, 0.3], topK: 2 });
    expect(res).toEqual({ matches });
    await memoturn.flush();

    const batch = batchFrom(active);
    const create = batch.find((e) => e.type === "span-create");
    const update = batch.find((e) => e.type === "span-update");
    expect(create?.body).toMatchObject({ name: "pinecone.query", observationType: "RETRIEVER" });
    expect(update?.body.retrievedDocuments).toEqual([
      {
        rank: 0,
        id: "doc-1",
        score: 0.91,
        content: "the quick brown fox",
        metadata: { content: "the quick brown fox" },
      },
      {
        rank: 1,
        id: "doc-2",
        score: 0.75,
        content: "jumps over the lazy dog",
        metadata: { content: "jumps over the lazy dog" },
      },
    ]);
    expect(update?.body.output).toBe("2 document(s)");
  });

  it("falls back to stringified metadata when no recognized key is present", async () => {
    active = mockFetch(() => ({ status: 207 }));
    const memoturn = new Memoturn(creds);
    const metadata = { category: "fruit", color: "red" };
    const pinecone = wrapPinecone(
      fakePinecone(async () => ({ matches: [{ id: "a", score: 0.5, metadata }] })),
      memoturn,
    );

    await pinecone.query({ vector: [0.1] });
    await memoturn.flush();

    const update = batchFrom(active).find((e) => e.type === "span-update");
    expect((update?.body.retrievedDocuments as any[])[0].content).toBe(JSON.stringify(metadata));
  });

  it("uses a caller-supplied getContent override instead of the default heuristic", async () => {
    active = mockFetch(() => ({ status: 207 }));
    const memoturn = new Memoturn(creds);
    const pinecone = wrapPinecone(
      fakePinecone(async () => ({
        matches: [{ id: "a", score: 0.5, metadata: { content: "ignored", body: "use this instead" } }],
      })),
      memoturn,
      { getContent: (match) => match?.metadata?.body },
    );

    await pinecone.query({ vector: [0.1] });
    await memoturn.flush();

    const update = batchFrom(active).find((e) => e.type === "span-update");
    expect((update?.body.retrievedDocuments as any[])[0].content).toBe("use this instead");
  });

  it("instruments index.namespace(ns).query(...) and records the namespace on the span", async () => {
    active = mockFetch(() => ({ status: 207 }));
    const memoturn = new Memoturn(creds);
    const pinecone = wrapPinecone(
      fakePinecone(async () => ({ matches: [] }), {
        namespace: (_ns: string) => fakePinecone(async () => ({ matches: [{ id: "n1", metadata: { text: "x" } }] })),
      }),
      memoturn,
    );

    const scoped = pinecone.namespace("ns");
    await scoped.query({ vector: [0.1] });
    await memoturn.flush();

    const create = batchFrom(active).find((e) => e.type === "span-create");
    expect((create?.body.metadata as any).namespace).toBe("ns");
  });

  it("produces a valid zero-document span/end pair for an empty matches array", async () => {
    active = mockFetch(() => ({ status: 207 }));
    const memoturn = new Memoturn(creds);
    const pinecone = wrapPinecone(
      fakePinecone(async () => ({ matches: [] })),
      memoturn,
    );

    await expect(pinecone.query({ vector: [0.1] })).resolves.toEqual({ matches: [] });
    await memoturn.flush();

    const update = batchFrom(active).find((e) => e.type === "span-update");
    expect(update?.body.retrievedDocuments).toEqual([]);
    expect(update?.body.output).toBe("0 document(s)");
  });

  it("marks the span ERROR and rethrows when the query call fails", async () => {
    active = mockFetch(() => ({ status: 207 }));
    const memoturn = new Memoturn(creds);
    const pinecone = wrapPinecone(
      fakePinecone(async () => {
        throw new Error("index unavailable");
      }),
      memoturn,
    );

    await expect(pinecone.query({ vector: [0.1] })).rejects.toThrow("index unavailable");
    await memoturn.flush();

    const update = batchFrom(active).find((e) => e.type === "span-update");
    expect(update?.body.level).toBe("ERROR");
    expect(String(update?.body.statusMessage)).toContain("index unavailable");
  });

  it("truncates the query vector at 4096 dims in the span's embedding field", async () => {
    active = mockFetch(() => ({ status: 207 }));
    const memoturn = new Memoturn(creds);
    const bigVector = Array.from({ length: 5000 }, (_, i) => i);
    const pinecone = wrapPinecone(
      fakePinecone(async () => ({ matches: [] })),
      memoturn,
    );

    await pinecone.query({ vector: bigVector });
    await memoturn.flush();

    const create = batchFrom(active).find((e) => e.type === "span-create");
    expect((create?.body.embedding as number[]).length).toBe(4096);
  });

  it("leaves non-wrapped properties/methods (upsert, describeIndexStats) untouched", () => {
    const memoturn = new Memoturn(creds);
    const upsert = () => Promise.resolve({ upsertedCount: 1 });
    const describeIndexStats = () => Promise.resolve({ totalRecordCount: 10 });
    const base = fakePinecone(async () => ({ matches: [] }), { upsert, describeIndexStats });
    const pinecone = wrapPinecone(base, memoturn);
    expect(pinecone.upsert).toBe(upsert);
    expect(pinecone.describeIndexStats).toBe(describeIndexStats);
  });

  it("creates a default trace per call, or nests under a provided trace", async () => {
    active = mockFetch(() => ({ status: 207 }));
    const memoturn = new Memoturn(creds);
    const trace = memoturn.trace({ name: "outer" });
    const pinecone = wrapPinecone(
      fakePinecone(async () => ({ matches: [] })),
      memoturn,
      { trace },
    );

    await pinecone.query({ vector: [0.1] });
    await memoturn.flush();

    const span = batchFrom(active).find((e) => e.type === "span-create");
    expect(span?.body.traceId).toBe(trace.id);
  });

  it("uses the default trace name pinecone.query when no trace is provided", async () => {
    active = mockFetch(() => ({ status: 207 }));
    const memoturn = new Memoturn(creds);
    const pinecone = wrapPinecone(
      fakePinecone(async () => ({ matches: [] })),
      memoturn,
    );

    await pinecone.query({ vector: [0.1] });
    await memoturn.flush();

    const traceCreate = batchFrom(active).find((e) => e.type === "trace-create");
    expect(traceCreate?.body.name).toBe("pinecone.query");
  });
});
