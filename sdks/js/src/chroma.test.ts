import { afterEach, describe, expect, it } from "vitest";
import { wrapChroma } from "./chroma.js";
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

/** Minimal stand-in for a chromadb Collection. */
function fakeChroma(query: (params: unknown) => Promise<unknown>, extra: Record<string, unknown> = {}) {
  return { query, ...extra };
}

describe("wrapChroma", () => {
  it("records a RETRIEVER span mapping the first query's column-major arrays to retrievedDocuments", async () => {
    active = mockFetch(() => ({ status: 207 }));
    const memoturn = new Memoturn(creds);
    const response = {
      ids: [["doc-1", "doc-2"]],
      distances: [[0.1, 0.4]],
      documents: [["the quick brown fox", "jumps over the lazy dog"]],
      metadatas: [[{ source: "a" }, { source: "b" }]],
    };
    const chroma = wrapChroma(
      fakeChroma(async () => response),
      memoturn,
    );

    const res = await chroma.query({ queryEmbeddings: [[0.1, 0.2, 0.3]], nResults: 2 });
    expect(res).toEqual(response);
    await memoturn.flush();

    const batch = batchFrom(active);
    const create = batch.find((e) => e.type === "span-create");
    const update = batch.find((e) => e.type === "span-update");
    expect(create?.body).toMatchObject({ name: "chroma.query", observationType: "RETRIEVER" });
    expect(create?.body.embedding).toEqual([0.1, 0.2, 0.3]);
    expect(update?.body.retrievedDocuments).toEqual([
      { rank: 0, id: "doc-1", score: 0.9, content: "the quick brown fox", metadata: { source: "a" } },
      { rank: 1, id: "doc-2", score: 0.6, content: "jumps over the lazy dog", metadata: { source: "b" } },
    ]);
    expect(update?.body.output).toBe("2 document(s)");
  });

  it("records queryTexts as the span input and a flat queryEmbeddings vector as embedding", async () => {
    active = mockFetch(() => ({ status: 207 }));
    const memoturn = new Memoturn(creds);
    const chroma = wrapChroma(
      fakeChroma(async () => ({ ids: [[]] })),
      memoturn,
    );

    await chroma.query({ queryTexts: ["what is a fox?"], queryEmbeddings: [0.5, 0.6], nResults: 5 });
    await memoturn.flush();

    const create = batchFrom(active).find((e) => e.type === "span-create");
    expect(create?.body.input).toEqual(["what is a fox?"]);
    expect(create?.body.embedding).toEqual([0.5, 0.6]);
    expect((create?.body.metadata as any).nResults).toBe(5);
  });

  it("falls back to metadata content, then stringified metadata, when documents are missing", async () => {
    active = mockFetch(() => ({ status: 207 }));
    const memoturn = new Memoturn(creds);
    const chroma = wrapChroma(
      fakeChroma(async () => ({
        ids: [["a", "b"]],
        distances: [[0.2, 0.3]],
        documents: [[null, null]],
        metadatas: [[{ text: "from metadata text" }, { category: "fruit" }]],
      })),
      memoturn,
    );

    await chroma.query({ queryEmbeddings: [[0.1]] });
    await memoturn.flush();

    const docs = batchFrom(active).find((e) => e.type === "span-update")?.body.retrievedDocuments as any[];
    expect(docs[0].content).toBe("from metadata text");
    expect(docs[1].content).toBe(JSON.stringify({ category: "fruit" }));
  });

  it("uses a caller-supplied getContent override instead of the default heuristic", async () => {
    active = mockFetch(() => ({ status: 207 }));
    const memoturn = new Memoturn(creds);
    const chroma = wrapChroma(
      fakeChroma(async () => ({
        ids: [["a"]],
        documents: [["ignored"]],
        metadatas: [[{ body: "use this instead" }]],
      })),
      memoturn,
      { getContent: (row) => (row.metadata as any)?.body },
    );

    await chroma.query({ queryEmbeddings: [[0.1]] });
    await memoturn.flush();

    const docs = batchFrom(active).find((e) => e.type === "span-update")?.body.retrievedDocuments as any[];
    expect(docs[0].content).toBe("use this instead");
  });

  it("produces a valid zero-document span/end pair for an unexpected response shape", async () => {
    active = mockFetch(() => ({ status: 207 }));
    const memoturn = new Memoturn(creds);
    const chroma = wrapChroma(
      fakeChroma(async () => ({ rows: "not the shape we expect" })),
      memoturn,
    );

    await chroma.query({ queryEmbeddings: [[0.1]] });
    await memoturn.flush();

    const update = batchFrom(active).find((e) => e.type === "span-update");
    expect(update?.body.retrievedDocuments).toEqual([]);
    expect(update?.body.output).toBe("0 document(s)");
  });

  it("marks the span ERROR and rethrows when the query call fails", async () => {
    active = mockFetch(() => ({ status: 207 }));
    const memoturn = new Memoturn(creds);
    const chroma = wrapChroma(
      fakeChroma(async () => {
        throw new Error("collection unavailable");
      }),
      memoturn,
    );

    await expect(chroma.query({ queryTexts: ["x"] })).rejects.toThrow("collection unavailable");
    await memoturn.flush();

    const update = batchFrom(active).find((e) => e.type === "span-update");
    expect(update?.body.level).toBe("ERROR");
    expect(String(update?.body.statusMessage)).toContain("collection unavailable");
  });

  it("truncates the query embedding at 4096 dims in the span's embedding field", async () => {
    active = mockFetch(() => ({ status: 207 }));
    const memoturn = new Memoturn(creds);
    const bigVector = Array.from({ length: 5000 }, (_, i) => i);
    const chroma = wrapChroma(
      fakeChroma(async () => ({ ids: [[]] })),
      memoturn,
    );

    await chroma.query({ queryEmbeddings: [bigVector] });
    await memoturn.flush();

    const create = batchFrom(active).find((e) => e.type === "span-create");
    expect((create?.body.embedding as number[]).length).toBe(4096);
  });

  it("leaves non-wrapped properties/methods (add, peek) untouched", () => {
    const memoturn = new Memoturn(creds);
    const add = () => Promise.resolve({ success: true });
    const peek = () => Promise.resolve({ ids: [] });
    const chroma = wrapChroma(
      fakeChroma(async () => ({ ids: [[]] }), { add, peek }),
      memoturn,
    );
    expect(chroma.add).toBe(add);
    expect(chroma.peek).toBe(peek);
  });

  it("creates a default trace per call, or nests under a provided trace", async () => {
    active = mockFetch(() => ({ status: 207 }));
    const memoturn = new Memoturn(creds);
    const trace = memoturn.trace({ name: "outer" });
    const chroma = wrapChroma(
      fakeChroma(async () => ({ ids: [[]] })),
      memoturn,
      { trace },
    );

    await chroma.query({ queryTexts: ["x"] });
    await memoturn.flush();

    const span = batchFrom(active).find((e) => e.type === "span-create");
    expect(span?.body.traceId).toBe(trace.id);
  });

  it("uses the default trace name chroma.query when no trace is provided", async () => {
    active = mockFetch(() => ({ status: 207 }));
    const memoturn = new Memoturn(creds);
    const chroma = wrapChroma(
      fakeChroma(async () => ({ ids: [[]] })),
      memoturn,
    );

    await chroma.query({ queryTexts: ["x"] });
    await memoturn.flush();

    const traceCreate = batchFrom(active).find((e) => e.type === "trace-create");
    expect(traceCreate?.body.name).toBe("chroma.query");
  });
});
