import { afterEach, describe, expect, it } from "vitest";
import { Memoturn } from "./client.js";
import { wrapQdrant } from "./qdrant.js";
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

describe("wrapQdrant", () => {
  it("records a RETRIEVER span for search with scored points mapped to retrievedDocuments", async () => {
    active = mockFetch(() => ({ status: 207 }));
    const memoturn = new Memoturn(creds);
    const points = [
      { id: 1, score: 0.91, payload: { text: "the quick brown fox" } },
      { id: "p-2", score: 0.75, payload: { text: "jumps over the lazy dog" } },
    ];
    const qdrant = wrapQdrant({ search: async (_c: string, _p: unknown) => points }, memoturn);

    const res = await qdrant.search("my-collection", { vector: [0.1, 0.2, 0.3], limit: 2 });
    expect(res).toEqual(points);
    await memoturn.flush();

    const batch = batchFrom(active);
    const create = batch.find((e) => e.type === "span-create");
    const update = batch.find((e) => e.type === "span-update");
    expect(create?.body).toMatchObject({ name: "qdrant.search", observationType: "RETRIEVER" });
    expect(create?.body.embedding).toEqual([0.1, 0.2, 0.3]);
    expect(create?.body.metadata as any).toMatchObject({ collection: "my-collection", limit: 2 });
    expect(update?.body.retrievedDocuments).toEqual([
      { rank: 0, id: "1", score: 0.91, content: "the quick brown fox", metadata: { text: "the quick brown fox" } },
      {
        rank: 1,
        id: "p-2",
        score: 0.75,
        content: "jumps over the lazy dog",
        metadata: { text: "jumps over the lazy dog" },
      },
    ]);
    expect(update?.body.output).toBe("2 document(s)");
  });

  it("wraps query (Query Points API): { points } response, vector query as embedding", async () => {
    active = mockFetch(() => ({ status: 207 }));
    const memoturn = new Memoturn(creds);
    const qdrant = wrapQdrant(
      {
        query: async (_c: string, _p: unknown) => ({
          points: [{ id: 7, score: 0.5, payload: { content: "doc" } }],
        }),
      },
      memoturn,
    );

    await qdrant.query("my-collection", { query: [0.4, 0.5], limit: 1 });
    await memoturn.flush();

    const create = batchFrom(active).find((e) => e.type === "span-create");
    expect(create?.body).toMatchObject({ name: "qdrant.query", observationType: "RETRIEVER" });
    expect(create?.body.embedding).toEqual([0.4, 0.5]);
    const docs = batchFrom(active).find((e) => e.type === "span-update")?.body.retrievedDocuments as any[];
    expect(docs).toEqual([{ rank: 0, id: "7", score: 0.5, content: "doc", metadata: { content: "doc" } }]);
  });

  it("records a non-vector query (point id) in metadata instead of embedding", async () => {
    active = mockFetch(() => ({ status: 207 }));
    const memoturn = new Memoturn(creds);
    const qdrant = wrapQdrant({ query: async (_c: string, _p: unknown) => ({ points: [] }) }, memoturn);

    await qdrant.query("my-collection", { query: "point-id-123", limit: 3 });
    await memoturn.flush();

    const create = batchFrom(active).find((e) => e.type === "span-create");
    expect(create?.body.embedding).toBeUndefined();
    expect((create?.body.metadata as any).query).toBe("point-id-123");
  });

  it("unwraps a { nearest } query object into the embedding field", async () => {
    active = mockFetch(() => ({ status: 207 }));
    const memoturn = new Memoturn(creds);
    const qdrant = wrapQdrant({ queryPoints: async (_c: string, _p: unknown) => ({ points: [] }) }, memoturn);

    await qdrant.queryPoints("my-collection", { query: { nearest: [0.7, 0.8] } });
    await memoturn.flush();

    const create = batchFrom(active).find((e) => e.type === "span-create");
    expect(create?.body.name).toBe("qdrant.queryPoints");
    expect(create?.body.embedding).toEqual([0.7, 0.8]);
  });

  it("falls back to stringified payload when no recognized text key is present", async () => {
    active = mockFetch(() => ({ status: 207 }));
    const memoturn = new Memoturn(creds);
    const payload = { category: "fruit", color: "red" };
    const qdrant = wrapQdrant({ search: async () => [{ id: "a", score: 0.5, payload }] }, memoturn);

    await qdrant.search("c", { vector: [0.1] });
    await memoturn.flush();

    const docs = batchFrom(active).find((e) => e.type === "span-update")?.body.retrievedDocuments as any[];
    expect(docs[0].content).toBe(JSON.stringify(payload));
  });

  it("uses a caller-supplied getContent override instead of the default heuristic", async () => {
    active = mockFetch(() => ({ status: 207 }));
    const memoturn = new Memoturn(creds);
    const qdrant = wrapQdrant(
      { search: async () => [{ id: "a", score: 0.5, payload: { text: "ignored", chunk: "use this instead" } }] },
      memoturn,
      { getContent: (point) => point?.payload?.chunk },
    );

    await qdrant.search("c", { vector: [0.1] });
    await memoturn.flush();

    const docs = batchFrom(active).find((e) => e.type === "span-update")?.body.retrievedDocuments as any[];
    expect(docs[0].content).toBe("use this instead");
  });

  it("produces a valid zero-document span/end pair for an unexpected response shape", async () => {
    active = mockFetch(() => ({ status: 207 }));
    const memoturn = new Memoturn(creds);
    const qdrant = wrapQdrant({ search: async () => ({ result: "not the shape we expect" }) }, memoturn);

    await qdrant.search("c", { vector: [0.1] });
    await memoturn.flush();

    const update = batchFrom(active).find((e) => e.type === "span-update");
    expect(update?.body.retrievedDocuments).toEqual([]);
    expect(update?.body.output).toBe("0 document(s)");
  });

  it("marks the span ERROR and rethrows when the search call fails", async () => {
    active = mockFetch(() => ({ status: 207 }));
    const memoturn = new Memoturn(creds);
    const qdrant = wrapQdrant(
      {
        search: async () => {
          throw new Error("collection unavailable");
        },
      },
      memoturn,
    );

    await expect(qdrant.search("c", { vector: [0.1] })).rejects.toThrow("collection unavailable");
    await memoturn.flush();

    const update = batchFrom(active).find((e) => e.type === "span-update");
    expect(update?.body.level).toBe("ERROR");
    expect(String(update?.body.statusMessage)).toContain("collection unavailable");
  });

  it("truncates the query vector at 4096 dims in the span's embedding field", async () => {
    active = mockFetch(() => ({ status: 207 }));
    const memoturn = new Memoturn(creds);
    const bigVector = Array.from({ length: 5000 }, (_, i) => i);
    const qdrant = wrapQdrant({ search: async () => [] }, memoturn);

    await qdrant.search("c", { vector: bigVector });
    await memoturn.flush();

    const create = batchFrom(active).find((e) => e.type === "span-create");
    expect((create?.body.embedding as number[]).length).toBe(4096);
  });

  it("leaves non-wrapped properties/methods (upsert, getCollections) untouched", () => {
    const memoturn = new Memoturn(creds);
    const upsert = () => Promise.resolve({ status: "ok" });
    const getCollections = () => Promise.resolve({ collections: [] });
    const qdrant = wrapQdrant({ search: async () => [], upsert, getCollections }, memoturn);
    expect(qdrant.upsert).toBe(upsert);
    expect(qdrant.getCollections).toBe(getCollections);
  });

  it("creates a default trace per call, or nests under a provided trace", async () => {
    active = mockFetch(() => ({ status: 207 }));
    const memoturn = new Memoturn(creds);
    const trace = memoturn.trace({ name: "outer" });
    const qdrant = wrapQdrant({ search: async () => [] }, memoturn, { trace });

    await qdrant.search("c", { vector: [0.1] });
    await memoturn.flush();

    const span = batchFrom(active).find((e) => e.type === "span-create");
    expect(span?.body.traceId).toBe(trace.id);
  });

  it("uses the method-derived default trace name when no trace is provided", async () => {
    active = mockFetch(() => ({ status: 207 }));
    const memoturn = new Memoturn(creds);
    const qdrant = wrapQdrant({ search: async () => [] }, memoturn);

    await qdrant.search("c", { vector: [0.1] });
    await memoturn.flush();

    const traceCreate = batchFrom(active).find((e) => e.type === "trace-create");
    expect(traceCreate?.body.name).toBe("qdrant.search");
  });
});
