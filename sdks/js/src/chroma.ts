import type { Memoturn, MemoturnTrace } from "./client.js";

const MAX_CONTENT_LEN = 16 * 1024; // matches packages/core/src/events.ts MAX_MESSAGE_LEN
const MAX_EMBEDDING_DIM = 4096; // matches packages/core/src/events.ts MAX_EMBEDDING_DIM

/** One result of the first query, re-assembled row-wise from Chroma's column-major response. */
type ChromaRow = { id: unknown; distance?: number; document?: string; metadata?: unknown };
type GetContent = (row: ChromaRow) => string | undefined;
type WrapOptions = {
  trace?: MemoturnTrace;
  traceName?: string;
  getContent?: GetContent;
};

function metadataContent(metadata: unknown): string | undefined {
  if (metadata && typeof metadata === "object") {
    for (const key of ["text", "content", "page_content"]) {
      const value = (metadata as Record<string, unknown>)[key];
      if (typeof value === "string" && value.length > 0) return value;
    }
    try {
      return JSON.stringify(metadata);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function defaultGetContent(row: ChromaRow): string | undefined {
  if (typeof row.document === "string" && row.document.length > 0) return row.document;
  return metadataContent(row.metadata);
}

function firstQueryRows(response: unknown): ChromaRow[] {
  const r = response as Record<string, unknown> | null | undefined;
  const ids = Array.isArray(r?.ids) && Array.isArray(r.ids[0]) ? (r.ids[0] as unknown[]) : [];
  const distances = Array.isArray(r?.distances) && Array.isArray(r.distances[0]) ? (r.distances[0] as unknown[]) : [];
  const documents = Array.isArray(r?.documents) && Array.isArray(r.documents[0]) ? (r.documents[0] as unknown[]) : [];
  const metadatas = Array.isArray(r?.metadatas) && Array.isArray(r.metadatas[0]) ? (r.metadatas[0] as unknown[]) : [];
  return ids.map((id, i) => ({
    id,
    distance: typeof distances[i] === "number" ? (distances[i] as number) : undefined,
    document: typeof documents[i] === "string" ? (documents[i] as string) : undefined,
    metadata: metadatas[i],
  }));
}

/** Chroma accepts a single embedding (`number[]`) or a batch (`number[][]`) — record the first. */
function firstEmbedding(queryEmbeddings: unknown): number[] | undefined {
  if (!Array.isArray(queryEmbeddings) || queryEmbeddings.length === 0) return undefined;
  if (typeof queryEmbeddings[0] === "number") return (queryEmbeddings as number[]).slice(0, MAX_EMBEDDING_DIM);
  if (Array.isArray(queryEmbeddings[0])) return (queryEmbeddings[0] as number[]).slice(0, MAX_EMBEDDING_DIM);
  return undefined;
}

/**
 * Drop-in wrapper for a Chroma `Collection` handle (`client.getCollection(...)` /
 * `client.createCollection(...)`). Wraps `.query()` as a `RETRIEVER` span: `queryTexts` as
 * `input`, the first query embedding as `embedding`, and the first query's column-major
 * results (`ids`/`distances`/`documents`/`metadatas`) re-assembled row-wise into
 * `retrievedDocuments` (`score = 1 - distance`).
 *
 * `content` comes from the `documents` entry when present, else best-effort from the row's
 * metadata (`text`/`content`/`page_content`, else stringified metadata). Pass `{ getContent }`
 * to override for a non-standard schema. Everything else (`add`, `get`, `peek`, …) passes
 * through untouched.
 */
export function wrapChroma<T extends object>(collection: T, memoturn: Memoturn, options: WrapOptions = {}): T {
  const getContent = options.getContent ?? defaultGetContent;

  return new Proxy(collection, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);

      if (prop === "query" && typeof value === "function") {
        return async function query(params: any, ...rest: any[]) {
          const trace = options.trace ?? memoturn.trace({ name: options.traceName ?? "chroma.query" });
          const { queryEmbeddings, queryTexts, nResults, ...rest2 } = params ?? {};
          const span = trace.span({
            name: "chroma.query",
            observationType: "RETRIEVER",
            input: queryTexts,
            metadata: { nResults, ...rest2 },
            embedding: firstEmbedding(queryEmbeddings),
          });
          try {
            const response = await (value as (...args: any[]) => Promise<any>).call(target, params, ...rest);
            const rows = firstQueryRows(response);
            span.end({
              retrievedDocuments: rows.map((row, rank) => ({
                rank,
                id: row.id !== undefined && row.id !== null ? String(row.id) : undefined,
                score: typeof row.distance === "number" ? 1 - row.distance : undefined,
                content: (getContent(row) ?? defaultGetContent(row) ?? "").slice(0, MAX_CONTENT_LEN),
                metadata: row.metadata as never,
              })),
              output: `${rows.length} document(s)`,
            });
            return response;
          } catch (err) {
            span.end({ level: "ERROR", statusMessage: String(err) });
            throw err;
          }
        };
      }

      return value;
    },
  });
}
