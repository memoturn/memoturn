import type { Memoturn, MemoturnTrace } from "./client.js";

const MAX_CONTENT_LEN = 16 * 1024; // matches packages/core/src/events.ts MAX_MESSAGE_LEN
const MAX_EMBEDDING_DIM = 4096; // matches packages/core/src/events.ts MAX_EMBEDDING_DIM

type GetContent = (point: any) => string | undefined;
type WrapOptions = {
  trace?: MemoturnTrace;
  traceName?: string;
  getContent?: GetContent;
};

function defaultGetContent(point: any): string | undefined {
  const payload = point?.payload;
  if (payload && typeof payload === "object") {
    for (const key of ["text", "content", "page_content", "body"]) {
      const value = payload[key];
      if (typeof value === "string" && value.length > 0) return value;
    }
    try {
      return JSON.stringify(payload);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function isNumericVector(value: unknown): value is number[] {
  return Array.isArray(value) && value.length > 0 && typeof value[0] === "number";
}

/** `search` takes `number[]` or a named `{ name, vector }`; `query` takes `number[]` or `{ nearest: number[] }`. */
function extractVector(value: any): number[] | undefined {
  if (isNumericVector(value)) return value.slice(0, MAX_EMBEDDING_DIM);
  if (isNumericVector(value?.vector)) return value.vector.slice(0, MAX_EMBEDDING_DIM);
  if (isNumericVector(value?.nearest)) return value.nearest.slice(0, MAX_EMBEDDING_DIM);
  return undefined;
}

/** `search` resolves to `ScoredPoint[]`; `query`/`queryPoints` resolve to `{ points: ScoredPoint[] }`. */
function pointsFrom(response: any): any[] {
  if (Array.isArray(response)) return response;
  if (Array.isArray(response?.points)) return response.points;
  return [];
}

function toRetrievedDocuments(points: any[], getContent: GetContent) {
  return points.map((point, rank) => ({
    rank,
    id: point?.id !== undefined ? String(point.id) : undefined,
    score: typeof point?.score === "number" ? point.score : undefined,
    content: (getContent(point) ?? defaultGetContent(point) ?? "").slice(0, MAX_CONTENT_LEN),
    metadata: point?.payload,
  }));
}

/**
 * Drop-in wrapper for a `@qdrant/js-client-rest` `QdrantClient`. Wraps `.search(collection,
 * { vector, … })` and the universal `.query()`/`.queryPoints()` (whichever exist) as
 * `RETRIEVER` spans: the query vector as `embedding` (also unwrapped from a named
 * `{ name, vector }` or `{ nearest }` form) and the scored points as `retrievedDocuments`.
 *
 * Qdrant points carry no document text field — `content` is extracted best-effort from
 * `payload` (`text`/`content`/`page_content`/`body`, else stringified payload), overridable
 * via `{ getContent }`. All other client methods (`upsert`, `getCollections`, …) pass
 * through untouched.
 */
export function wrapQdrant<T extends object>(client: T, memoturn: Memoturn, options: WrapOptions = {}): T {
  const getContent = options.getContent ?? defaultGetContent;

  const wrapMethod = (method: string, fn: (...args: any[]) => any, target: object) =>
    async function wrapped(collectionName: any, params: any, ...rest: any[]) {
      const trace = options.trace ?? memoturn.trace({ name: options.traceName ?? `qdrant.${method}` });
      const { vector, query, prefetch, ...rest2 } = params ?? {};
      const embedding = extractVector(vector) ?? extractVector(query);
      const span = trace.span({
        name: `qdrant.${method}`,
        observationType: "RETRIEVER",
        metadata: {
          collection: typeof collectionName === "string" ? collectionName : undefined,
          ...(embedding === undefined && query !== undefined ? { query } : {}),
          ...rest2,
        },
        embedding,
      });
      try {
        const response = await fn.call(target, collectionName, params, ...rest);
        const points = pointsFrom(response);
        span.end({
          retrievedDocuments: toRetrievedDocuments(points, getContent),
          output: `${points.length} document(s)`,
        });
        return response;
      } catch (err) {
        span.end({ level: "ERROR", statusMessage: String(err) });
        throw err;
      }
    };

  return new Proxy(client, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);

      if ((prop === "search" || prop === "query" || prop === "queryPoints") && typeof value === "function") {
        return wrapMethod(prop, value as (...args: any[]) => any, target);
      }

      return value;
    },
  });
}
