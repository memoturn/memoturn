// Wire types — kept local to the SDK so it stays dependency-free and publishable
// on its own. Must stay structurally compatible with @memoturn/core's Zod contracts.

export type JsonValue = unknown;

export interface Usage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

export type ObservationLevel = "DEBUG" | "DEFAULT" | "WARNING" | "ERROR";

/** A document a retriever/RAG span returned (surfaced in the trace view + RAG analysis). */
export interface RetrievedDocument {
  /** Stable id in the source store, if any. */
  id?: string;
  /** Position in the result set (0-based). */
  rank: number;
  /** Relevance / similarity score. */
  score?: number;
  /** Document text. */
  content: string;
  metadata?: JsonValue;
  /** Optional per-document embedding vector. */
  embedding?: number[];
}

export interface TraceInput {
  id?: string;
  name?: string;
  userId?: string;
  sessionId?: string;
  release?: string;
  version?: string;
  environment?: string;
  tags?: string[];
  metadata?: JsonValue;
  input?: JsonValue;
  output?: JsonValue;
}

/** Observation type — the default derives from which method created it (span/generation/event);
 * pass `observationType` (or use the `tool()`/`agent()` helpers) to classify agentic spans. */
export type ObservationType =
  | "SPAN"
  | "GENERATION"
  | "EVENT"
  | "TOOL"
  | "AGENT"
  | "RETRIEVER"
  | "RERANKER"
  | "EMBEDDING"
  | "CHAIN"
  | "GUARDRAIL";

export interface SpanInput {
  id?: string;
  name?: string;
  parentObservationId?: string;
  metadata?: JsonValue;
  input?: JsonValue;
  output?: JsonValue;
  level?: ObservationLevel;
  statusMessage?: string;
  /** Classify this observation (e.g. TOOL for a tool call, AGENT for an agent step). */
  observationType?: ObservationType;
  /** RAG: documents this span retrieved (retriever / vector-search spans). */
  retrievedDocuments?: RetrievedDocument[];
  /** Embedding vector for this observation (e.g. an embedding-model call). */
  embedding?: number[];
}

export interface GenerationInput extends SpanInput {
  model?: string;
  provider?: string;
  modelParameters?: Record<string, unknown>;
  usage?: Usage;
  promptId?: string;
  promptVersion?: string;
}

export interface ScoreInput {
  id?: string;
  name: string;
  value?: number;
  stringValue?: string;
  dataType?: "NUMERIC" | "CATEGORICAL" | "BOOLEAN";
  comment?: string;
  observationId?: string;
}

export interface IngestEnvelope {
  id: string;
  type:
    | "trace-create"
    | "span-create"
    | "span-update"
    | "generation-create"
    | "generation-update"
    | "event-create"
    | "score-create";
  timestamp: string;
  body: Record<string, unknown>;
}

/**
 * Redact or transform a value before it is buffered for ingest. Applied to the
 * `input`, `output`, and `metadata` fields of every event body — including events
 * produced by the OpenAI wrapper and LangChain callback. If the function throws,
 * the value is replaced with a sentinel string; the event is never dropped and the
 * unmasked value is never sent.
 */
export type MaskFunction = (
  value: unknown,
  ctx: { field: "input" | "output" | "metadata"; type: IngestEnvelope["type"] },
) => unknown;

export interface MemoturnOptions {
  baseUrl?: string;
  publicKey?: string;
  secretKey?: string;
  environment?: string;
  /** Flush when the buffer reaches this many events. Default 20. */
  flushAt?: number;
  /** Flush at least this often (ms). Default 5000. */
  flushInterval?: number;
  /** Hard cap on buffered events; incoming events are dropped (with a one-time
   * warning) once reached. Default 10000, or `MEMOTURN_MAX_BUFFER_SIZE`. */
  maxBufferSize?: number;
  /** Per-request timeout (ms) for ingest calls. Default 10000. */
  requestTimeout?: number;
  /** Flush buffered events on Node `beforeExit`. Default true (no-op outside Node). */
  flushOnExit?: boolean;
  /** Suppress the cleartext-http warning for non-local `http://` base URLs
   * (or set `MEMOTURN_ALLOW_HTTP=1`). */
  allowInsecureHttp?: boolean;
  /** Redaction hook applied to input/output/metadata of every event before buffering. */
  mask?: MaskFunction;
}
