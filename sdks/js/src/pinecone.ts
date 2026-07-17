import type { Memoturn, MemoturnTrace } from "./client.js";

const MAX_CONTENT_LEN = 16 * 1024; // matches packages/core/src/events.ts MAX_MESSAGE_LEN
const MAX_EMBEDDING_DIM = 4096; // matches packages/core/src/events.ts MAX_EMBEDDING_DIM

type GetContent = (match: any) => string | undefined;
type WrapOptions = {
  trace?: MemoturnTrace;
  traceName?: string;
  getContent?: GetContent;
  /** @internal set only by the recursive `.namespace()` interception below — not part of
   * the public surface documented to callers. */
  namespaceOverride?: string;
};

function defaultGetContent(match: any): string | undefined {
  const metadata = match?.metadata;
  if (metadata && typeof metadata === "object") {
    for (const key of ["text", "content", "page_content"]) {
      const value = metadata[key];
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

function toRetrievedDocuments(matches: any[], getContent: GetContent) {
  return matches.map((match, rank) => ({
    rank,
    id: match?.id !== undefined ? String(match.id) : undefined,
    score: typeof match?.score === "number" ? match.score : undefined,
    content: (getContent(match) ?? defaultGetContent(match) ?? "").slice(0, MAX_CONTENT_LEN),
    metadata: match?.metadata,
  }));
}

/**
 * Drop-in wrapper for a Pinecone data-plane index handle (`pinecone.index(name)` /
 * `pc.Index(name)`) — NOT the control-plane client. Wraps `.query()` (RETRIEVER span:
 * query vector as `embedding`, matches as `retrievedDocuments`) and `.namespace(ns)` (so
 * `index.namespace(ns).query(...)` is instrumented too).
 *
 * Pinecone's response has no document text field — `content` is extracted best-effort
 * from `metadata` (`text`/`content`/`page_content`, else stringified metadata). Pass
 * `{ getContent }` to override for a non-standard metadata schema.
 */
export function wrapPinecone<T extends object>(index: T, memoturn: Memoturn, options: WrapOptions = {}): T {
  const getContent = options.getContent ?? defaultGetContent;

  return new Proxy(index, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);

      if (prop === "query" && typeof value === "function") {
        return async function query(params: any, ...rest: any[]) {
          const trace = options.trace ?? memoturn.trace({ name: options.traceName ?? "pinecone.query" });
          const { vector, topK, filter, namespace, ...rest2 } = params ?? {};
          const span = trace.span({
            name: "pinecone.query",
            observationType: "RETRIEVER",
            metadata: { namespace: namespace ?? options.namespaceOverride, topK, filter, ...rest2 },
            embedding: Array.isArray(vector) ? vector.slice(0, MAX_EMBEDDING_DIM) : undefined,
          });
          try {
            const response = await (value as (...args: any[]) => Promise<any>).call(target, params, ...rest);
            const matches = Array.isArray(response?.matches) ? response.matches : [];
            span.end({
              retrievedDocuments: toRetrievedDocuments(matches, getContent),
              output: `${matches.length} document(s)`,
            });
            return response;
          } catch (err) {
            span.end({ level: "ERROR", statusMessage: String(err) });
            throw err;
          }
        };
      }

      if (prop === "namespace" && typeof value === "function") {
        return function namespace(ns: string, ...args: any[]) {
          const scoped = (value as (...args: any[]) => any).call(target, ns, ...args);
          return wrapPinecone(scoped, memoturn, { ...options, namespaceOverride: ns });
        };
      }

      return value;
    },
  });
}
