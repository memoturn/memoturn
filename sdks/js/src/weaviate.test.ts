import { afterEach, describe, expect, it } from "vitest";
import { Memoturn } from "./client.js";
import { mockFetch } from "./test-helpers.js";
import type { IngestEnvelope } from "./types.js";
import { wrapWeaviate } from "./weaviate.js";

const creds = { baseUrl: "http://api.test", publicKey: "pk-mt-x", secretKey: "sk-mt-y", flushAt: 1000 };

let active: ReturnType<typeof mockFetch> | undefined;
afterEach(() => {
  active?.restore();
  active = undefined;
});

function batchFrom(m: ReturnType<typeof mockFetch>): IngestEnvelope[] {
  return (m.calls[0].body as { batch: IngestEnvelope[] }).batch;
}

/** Minimal stand-in for a weaviate-client v3 collection handle. */
function fakeWeaviate(query: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return { query, ...extra };
}

describe("wrapWeaviate", () => {
  it("records a RETRIEVER span for nearVector with objects mapped to retrievedDocuments", async () => {
    active = mockFetch(() => ({ status: 207 }));
    const memoturn = new Memoturn(creds);
    const objects = [
      { uuid: "u-1", properties: { text: "the quick brown fox" }, metadata: { distance: 0.1 } },
      { uuid: "u-2", properties: { text: "jumps over the lazy dog" }, metadata: { distance: 0.4 } },
    ];
    const collection = wrapWeaviate(
      fakeWeaviate({ nearVector: async (_v: number[], _o?: unknown) => ({ objects }) }),
      memoturn,
    );

    const res = await collection.query.nearVector([0.1, 0.2, 0.3], { limit: 2 });
    expect(res).toEqual({ objects });
    await memoturn.flush();

    const batch = batchFrom(active);
    const create = batch.find((e) => e.type === "span-create");
    const update = batch.find((e) => e.type === "span-update");
    expect(create?.body).toMatchObject({ name: "weaviate.nearVector", observationType: "RETRIEVER" });
    expect(create?.body.embedding).toEqual([0.1, 0.2, 0.3]);
    expect((create?.body.metadata as any).limit).toBe(2);
    expect(update?.body.retrievedDocuments).toEqual([
      { rank: 0, id: "u-1", score: 0.9, content: "the quick brown fox", metadata: { text: "the quick brown fox" } },
      {
        rank: 1,
        id: "u-2",
        score: 0.6,
        content: "jumps over the lazy dog",
        metadata: { text: "jumps over the lazy dog" },
      },
    ]);
    expect(update?.body.output).toBe("2 document(s)");
  });

  it("records the query text as input for nearText/hybrid/bm25 and prefers metadata.score", async () => {
    active = mockFetch(() => ({ status: 207 }));
    const memoturn = new Memoturn(creds);
    const collection = wrapWeaviate(
      fakeWeaviate({
        hybrid: async (_q: string, _o?: unknown) => ({
          objects: [{ uuid: "u-1", properties: { content: "doc" }, metadata: { score: 0.87, distance: 0.9 } }],
        }),
      }),
      memoturn,
    );

    await collection.query.hybrid("brown fox", { limit: 1 });
    await memoturn.flush();

    const create = batchFrom(active).find((e) => e.type === "span-create");
    expect(create?.body).toMatchObject({ name: "weaviate.hybrid", input: "brown fox" });
    const docs = batchFrom(active).find((e) => e.type === "span-update")?.body.retrievedDocuments as any[];
    expect(docs[0].score).toBe(0.87);
  });

  it("wraps fetchObjects (single options arg) and falls back to certainty for the score", async () => {
    active = mockFetch(() => ({ status: 207 }));
    const memoturn = new Memoturn(creds);
    const collection = wrapWeaviate(
      fakeWeaviate({
        fetchObjects: async (_o?: unknown) => ({
          objects: [{ uuid: "u-9", properties: { title: "no text-ish key" }, metadata: { certainty: 0.95 } }],
        }),
      }),
      memoturn,
    );

    await collection.query.fetchObjects({ limit: 10 });
    await memoturn.flush();

    const create = batchFrom(active).find((e) => e.type === "span-create");
    expect(create?.body.name).toBe("weaviate.fetchObjects");
    expect((create?.body.metadata as any).limit).toBe(10);
    const docs = batchFrom(active).find((e) => e.type === "span-update")?.body.retrievedDocuments as any[];
    expect(docs[0].score).toBe(0.95);
    expect(docs[0].content).toBe(JSON.stringify({ title: "no text-ish key" }));
  });

  it("uses a caller-supplied getContent override instead of the default heuristic", async () => {
    active = mockFetch(() => ({ status: 207 }));
    const memoturn = new Memoturn(creds);
    const collection = wrapWeaviate(
      fakeWeaviate({
        bm25: async (_q: string) => ({
          objects: [{ uuid: "u-1", properties: { content: "ignored", chunk: "use this instead" } }],
        }),
      }),
      memoturn,
      { getContent: (object) => object?.properties?.chunk },
    );

    await collection.query.bm25("fox");
    await memoturn.flush();

    const docs = batchFrom(active).find((e) => e.type === "span-update")?.body.retrievedDocuments as any[];
    expect(docs[0].content).toBe("use this instead");
  });

  it("produces a valid zero-document span/end pair for an unexpected response shape", async () => {
    active = mockFetch(() => ({ status: 207 }));
    const memoturn = new Memoturn(creds);
    const collection = wrapWeaviate(
      fakeWeaviate({ nearText: async (_q: string) => ({ results: "not the shape we expect" }) }),
      memoturn,
    );

    await collection.query.nearText("fox");
    await memoturn.flush();

    const update = batchFrom(active).find((e) => e.type === "span-update");
    expect(update?.body.retrievedDocuments).toEqual([]);
    expect(update?.body.output).toBe("0 document(s)");
  });

  it("marks the span ERROR and rethrows when the search call fails", async () => {
    active = mockFetch(() => ({ status: 207 }));
    const memoturn = new Memoturn(creds);
    const collection = wrapWeaviate(
      fakeWeaviate({
        nearVector: async () => {
          throw new Error("collection unavailable");
        },
      }),
      memoturn,
    );

    await expect(collection.query.nearVector([0.1])).rejects.toThrow("collection unavailable");
    await memoturn.flush();

    const update = batchFrom(active).find((e) => e.type === "span-update");
    expect(update?.body.level).toBe("ERROR");
    expect(String(update?.body.statusMessage)).toContain("collection unavailable");
  });

  it("truncates the query vector at 4096 dims in the span's embedding field", async () => {
    active = mockFetch(() => ({ status: 207 }));
    const memoturn = new Memoturn(creds);
    const bigVector = Array.from({ length: 5000 }, (_, i) => i);
    const collection = wrapWeaviate(fakeWeaviate({ nearVector: async () => ({ objects: [] }) }), memoturn);

    await collection.query.nearVector(bigVector);
    await memoturn.flush();

    const create = batchFrom(active).find((e) => e.type === "span-create");
    expect((create?.body.embedding as number[]).length).toBe(4096);
  });

  it("leaves non-retrieval members (data, aggregate, unknown query methods) untouched", () => {
    const memoturn = new Memoturn(creds);
    const data = { insert: () => Promise.resolve("id") };
    const nearObject = async () => ({ objects: [] });
    const collection = wrapWeaviate(fakeWeaviate({ nearObject }, { data }), memoturn);
    expect(collection.data).toBe(data);
    expect(collection.query.nearObject).toBe(nearObject);
  });

  it("creates a default trace per call, or nests under a provided trace", async () => {
    active = mockFetch(() => ({ status: 207 }));
    const memoturn = new Memoturn(creds);
    const trace = memoturn.trace({ name: "outer" });
    const collection = wrapWeaviate(fakeWeaviate({ nearText: async (_q: string) => ({ objects: [] }) }), memoturn, {
      trace,
    });

    await collection.query.nearText("fox");
    await memoturn.flush();

    const span = batchFrom(active).find((e) => e.type === "span-create");
    expect(span?.body.traceId).toBe(trace.id);
  });

  it("uses the method-derived default trace name when no trace is provided", async () => {
    active = mockFetch(() => ({ status: 207 }));
    const memoturn = new Memoturn(creds);
    const collection = wrapWeaviate(fakeWeaviate({ bm25: async (_q: string) => ({ objects: [] }) }), memoturn);

    await collection.query.bm25("fox");
    await memoturn.flush();

    const traceCreate = batchFrom(active).find((e) => e.type === "trace-create");
    expect(traceCreate?.body.name).toBe("weaviate.bm25");
  });
});
