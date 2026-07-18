import type { Memoturn, MemoturnTrace } from "./client.js";

const MAX_CONTENT_LEN = 16 * 1024; // matches packages/core/src/events.ts MAX_MESSAGE_LEN
const MAX_EMBEDDING_DIM = 4096; // matches packages/core/src/events.ts MAX_EMBEDDING_DIM

/** The retrieval methods of a weaviate-client v3+ collection's `.query` namespace. */
const RETRIEVAL_METHODS = new Set(["nearVector", "nearText", "hybrid", "bm25", "fetchObjects"]);

type GetContent = (object: any) => string | undefined;
type WrapOptions = {
  trace?: MemoturnTrace;
  traceName?: string;
  getContent?: GetContent;
};

function defaultGetContent(object: any): string | undefined {
  const properties = object?.properties;
  if (properties && typeof properties === "object") {
    for (const key of ["text", "content", "page_content", "body"]) {
      const value = properties[key];
      if (typeof value === "string" && value.length > 0) return value;
    }
    try {
      return JSON.stringify(properties);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** Weaviate's per-object metadata carries whichever of distance/score/certainty the search kind produced. */
function objectScore(object: any): number | undefined {
  const metadata = object?.metadata;
  if (typeof metadata?.score === "number") return metadata.score;
  if (typeof metadata?.distance === "number") return 1 - metadata.distance;
  if (typeof metadata?.certainty === "number") return metadata.certainty;
  return undefined;
}

function isNumericVector(value: unknown): value is number[] {
  return Array.isArray(value) && value.length > 0 && typeof value[0] === "number";
}

function toRetrievedDocuments(objects: any[], getContent: GetContent) {
  return objects.map((object, rank) => ({
    rank,
    id: object?.uuid !== undefined ? String(object.uuid) : undefined,
    score: objectScore(object),
    content: (getContent(object) ?? defaultGetContent(object) ?? "").slice(0, MAX_CONTENT_LEN),
    metadata: object?.properties,
  }));
}

/**
 * Drop-in wrapper for a weaviate-client (v3+) collection handle (`client.collections.get(name)`).
 * Intercepts the retrieval methods of its `.query` namespace — `nearVector`, `nearText`,
 * `hybrid`, `bm25`, `fetchObjects` (whichever exist) — recording each call as a `RETRIEVER`
 * span: the query vector as `embedding` (nearVector), the query text as `input`
 * (nearText/hybrid/bm25), and the response's `objects` as `retrievedDocuments`.
 *
 * `score` comes from each object's `metadata` (`score`, else `1 - distance`, else `certainty`
 * — request it via `returnMetadata`); `content` best-effort from `properties`
 * (`text`/`content`/`page_content`/`body`, else stringified properties), overridable via
 * `{ getContent }`. Non-retrieval members (`.data`, `.aggregate`, generate variants, …) pass
 * through untouched.
 */
export function wrapWeaviate<T extends object>(collection: T, memoturn: Memoturn, options: WrapOptions = {}): T {
  const getContent = options.getContent ?? defaultGetContent;

  const wrapMethod = (queryTarget: object, method: string, fn: (...args: any[]) => any) =>
    async function wrapped(...args: any[]) {
      const trace = options.trace ?? memoturn.trace({ name: options.traceName ?? `weaviate.${method}` });
      const first = method === "fetchObjects" ? undefined : args[0];
      const opts = method === "fetchObjects" ? args[0] : args[1];
      const embedding = isNumericVector(first) ? first.slice(0, MAX_EMBEDDING_DIM) : undefined;
      const span = trace.span({
        name: `weaviate.${method}`,
        observationType: "RETRIEVER",
        input: embedding === undefined ? first : undefined,
        metadata: opts && typeof opts === "object" ? { ...opts, vector: undefined } : undefined,
        embedding,
      });
      try {
        const response = await fn.apply(queryTarget, args);
        const objects = Array.isArray(response?.objects) ? response.objects : [];
        span.end({
          retrievedDocuments: toRetrievedDocuments(objects, getContent),
          output: `${objects.length} document(s)`,
        });
        return response;
      } catch (err) {
        span.end({ level: "ERROR", statusMessage: String(err) });
        throw err;
      }
    };

  return new Proxy(collection, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);

      if (prop === "query" && value && typeof value === "object") {
        return new Proxy(value as object, {
          get(queryTarget, queryProp, queryReceiver) {
            const queryValue = Reflect.get(queryTarget, queryProp, queryReceiver);
            if (typeof queryProp === "string" && RETRIEVAL_METHODS.has(queryProp) && typeof queryValue === "function") {
              return wrapMethod(queryTarget, queryProp, queryValue as (...args: any[]) => any);
            }
            return queryValue;
          },
        });
      }

      return value;
    },
  });
}
