import { z } from "zod";

/**
 * memoturn ingestion wire contract.
 *
 * A client POSTs a batch of envelopes to `/v1/ingest`. Each envelope carries its
 * own `id` (for idempotency/dedup) and `timestamp` (the event_ts used to merge
 * late/partial updates in the telemetry store — newest wins). The `body` shape is selected
 * by the envelope `type`.
 *
 * This file is the single source of truth shared by the SDK, the web API, and the
 * worker. Changing it changes all three.
 */

export const ISO_DATETIME = z.iso.datetime({ offset: true });

export const ObservationLevel = z.enum(["DEBUG", "DEFAULT", "WARNING", "ERROR"]);
export type ObservationLevel = z.infer<typeof ObservationLevel>;

// The observation taxonomy. Beyond the base span/generation/event, agentic + RAG kinds
// (tool/agent + retriever/reranker/embedding/chain/guardrail) mirror the OpenInference span
// kinds so OpenInference-instrumented apps map cleanly (see packages/server/src/otel.ts).
export const ObservationType = z.enum([
  "SPAN",
  "GENERATION",
  "EVENT",
  "TOOL",
  "AGENT",
  "RETRIEVER",
  "RERANKER",
  "EMBEDDING",
  "CHAIN",
  "GUARDRAIL",
]);
export type ObservationType = z.infer<typeof ObservationType>;

export const ScoreDataType = z.enum(["NUMERIC", "CATEGORICAL", "BOOLEAN", "CORRECTION", "TEXT"]);
export type ScoreDataType = z.infer<typeof ScoreDataType>;

/** Max length for a TEXT-dataType score's stringValue (free-text, tighter than MAX_MESSAGE_LEN). */
export const MAX_TEXT_SCORE_LEN = 500;

export const ScoreSource = z.enum(["API", "EVAL", "ANNOTATION"]);
export type ScoreSource = z.infer<typeof ScoreSource>;

/**
 * Hard ceiling for a single serialized JSON field (input/output/metadata). Oversized
 * fields are rejected at ingest (400) to bound memory/storage. This is the ceiling — the
 * worker soft-truncates large-but-allowed payloads to blob storage well below this.
 */
export const MAX_JSON_FIELD_BYTES = 1024 * 1024; // 1 MB

/** Length caps for identifier/label strings and tag arrays (bound cardinality + memory). */
export const MAX_IDENTIFIER_LEN = 2048;
export const MAX_TAGS = 256;
/** Free-text status/message fields — larger than identifiers, still bounded. */
export const MAX_MESSAGE_LEN = 16 * 1024;

/** JSON-serializable payload (input/output/metadata), capped at MAX_JSON_FIELD_BYTES. */
const Json = z.any().refine(
  (v) => {
    if (v === undefined) return true;
    try {
      return JSON.stringify(v).length <= MAX_JSON_FIELD_BYTES;
    } catch {
      return true; // non-serializable values are handled elsewhere; don't block here
    }
  },
  { message: `JSON field exceeds the ${MAX_JSON_FIELD_BYTES}-byte limit` },
);

const usage = z
  .object({
    promptTokens: z.number().int().nonnegative().optional(),
    completionTokens: z.number().int().nonnegative().optional(),
    totalTokens: z.number().int().nonnegative().optional(),
    // Prompt-caching usage (e.g. Anthropic): tokens served from cache vs. tokens written to
    // the cache on this call. Both are subsets/companions of promptTokens, reported separately.
    cacheReadTokens: z.number().int().nonnegative().optional(),
    cacheCreationTokens: z.number().int().nonnegative().optional(),
  })
  .optional();

// ── Trace ─────────────────────────────────────────────────────────────────────
export const traceBody = z.object({
  id: z.string().min(1).max(MAX_IDENTIFIER_LEN),
  name: z.string().max(MAX_IDENTIFIER_LEN).optional(),
  timestamp: ISO_DATETIME.optional(),
  userId: z.string().max(MAX_IDENTIFIER_LEN).optional(),
  sessionId: z.string().max(MAX_IDENTIFIER_LEN).optional(),
  release: z.string().max(MAX_IDENTIFIER_LEN).optional(),
  version: z.string().max(MAX_IDENTIFIER_LEN).optional(),
  environment: z.string().max(MAX_IDENTIFIER_LEN).default("default"),
  public: z.boolean().optional(),
  tags: z.array(z.string().max(MAX_IDENTIFIER_LEN)).max(MAX_TAGS).optional(),
  metadata: Json.optional(),
  input: Json.optional(),
  output: Json.optional(),
});
export type TraceBody = z.infer<typeof traceBody>;

/** Max embedding dimensionality accepted on the wire (covers common 1536/3072 models). */
export const MAX_EMBEDDING_DIM = 4096;

/**
 * A single retrieved document on a RAG/retriever span. The worker explodes a span's
 * `retrievedDocuments` into queryable rows so "show me low-relevance retrievals" is a
 * table scan, not JSON parsing. `rank` is the position in the result set (0-based).
 */
export const retrievedDocument = z.object({
  id: z.string().max(MAX_IDENTIFIER_LEN).optional(), // stable doc id if the store has one
  rank: z.number().int().nonnegative(),
  score: z.number().optional(), // relevance/similarity score
  content: z.string().max(MAX_MESSAGE_LEN), // document text (bounded)
  metadata: Json.optional(), // source uri, chunk id, etc.
  embedding: z.array(z.number()).max(MAX_EMBEDDING_DIM).optional(), // optional per-doc vector
});
export type RetrievedDocument = z.infer<typeof retrievedDocument>;

// ── Observation (span / generation / event) ─────────────────────────────────────
const observationBase = z.object({
  id: z.string().min(1).max(MAX_IDENTIFIER_LEN),
  traceId: z.string().min(1).max(MAX_IDENTIFIER_LEN),
  parentObservationId: z.string().max(MAX_IDENTIFIER_LEN).optional(),
  name: z.string().max(MAX_IDENTIFIER_LEN).optional(),
  startTime: ISO_DATETIME.optional(),
  endTime: ISO_DATETIME.optional(),
  environment: z.string().max(MAX_IDENTIFIER_LEN).default("default"),
  level: ObservationLevel.optional(),
  // Optional override letting a span/generation be classified as TOOL or AGENT
  // (default derives from the event kind: span-create → SPAN, generation-create → GENERATION, …).
  observationType: ObservationType.optional(),
  statusMessage: z.string().max(MAX_MESSAGE_LEN).optional(),
  metadata: Json.optional(),
  input: Json.optional(),
  output: Json.optional(),
  // RAG: documents retrieved by this span (retriever/vector-search spans).
  retrievedDocuments: z.array(retrievedDocument).max(500).optional(),
  // Embedding vector for THIS observation (e.g. an embedding-model generation). The
  // embedded text typically lives in `input`; points on the projection view are
  // observations that carry a vector.
  embedding: z.array(z.number()).max(MAX_EMBEDDING_DIM).optional(),
});

export const spanBody = observationBase;
export type SpanBody = z.infer<typeof spanBody>;

export const generationBody = observationBase.extend({
  model: z.string().optional(),
  provider: z.string().optional(),
  modelParameters: z.record(z.string(), z.any()).optional(),
  usage,
  promptId: z.string().optional(),
  promptVersion: z.string().optional(),
});
export type GenerationBody = z.infer<typeof generationBody>;

export const eventBody = observationBase;
export type EventBody = z.infer<typeof eventBody>;

// ── Score ───────────────────────────────────────────────────────────────────────
export const scoreBody = z
  .object({
    id: z.string().min(1).max(MAX_IDENTIFIER_LEN),
    traceId: z.string().min(1).max(MAX_IDENTIFIER_LEN),
    observationId: z.string().max(MAX_IDENTIFIER_LEN).optional(),
    name: z.string().min(1).max(MAX_IDENTIFIER_LEN),
    timestamp: ISO_DATETIME.optional(),
    environment: z.string().max(MAX_IDENTIFIER_LEN).default("default"),
    source: ScoreSource.default("API"),
    dataType: ScoreDataType.default("NUMERIC"),
    value: z.number().optional(),
    stringValue: z.string().max(MAX_MESSAGE_LEN).optional(),
    comment: z.string().max(MAX_MESSAGE_LEN).optional(),
    configId: z.string().max(MAX_IDENTIFIER_LEN).optional(),
  })
  .superRefine((body, ctx) => {
    if (body.dataType === "BOOLEAN" && body.value !== undefined && body.value !== 0 && body.value !== 1) {
      ctx.addIssue({ code: "custom", path: ["value"], message: "BOOLEAN score value must be 0 or 1" });
    }
    if (body.dataType === "TEXT" && body.stringValue !== undefined && body.stringValue.length > MAX_TEXT_SCORE_LEN) {
      ctx.addIssue({
        code: "custom",
        path: ["stringValue"],
        message: `TEXT score stringValue exceeds the ${MAX_TEXT_SCORE_LEN}-char limit`,
      });
    }
  });
export type ScoreBody = z.infer<typeof scoreBody>;

// ── Envelope ─────────────────────────────────────────────────────────────────────
const envelope = z.object({
  id: z.string().min(1), // event id (idempotency)
  timestamp: ISO_DATETIME, // event_ts (merge version)
});

export const ingestEvent = z.discriminatedUnion("type", [
  envelope.extend({ type: z.literal("trace-create"), body: traceBody }),
  envelope.extend({ type: z.literal("span-create"), body: spanBody }),
  envelope.extend({
    type: z.literal("span-update"),
    body: spanBody.partial({ name: true }).required({ id: true, traceId: true }),
  }),
  envelope.extend({ type: z.literal("generation-create"), body: generationBody }),
  envelope.extend({
    type: z.literal("generation-update"),
    body: generationBody.partial({ name: true }).required({ id: true, traceId: true }),
  }),
  envelope.extend({ type: z.literal("event-create"), body: eventBody }),
  envelope.extend({ type: z.literal("score-create"), body: scoreBody }),
]);
export type IngestEvent = z.infer<typeof ingestEvent>;
export type IngestEventType = IngestEvent["type"];

export const ingestRequest = z.object({
  batch: z.array(ingestEvent).min(1).max(1000),
});
export type IngestRequest = z.infer<typeof ingestRequest>;

/** Per-event result returned in the 207 response. */
export const ingestResult = z.object({
  id: z.string(), // "" when a rejected event had no readable id
  index: z.number().int().optional(), // position in the submitted batch (set on rejections)
  status: z.union([z.literal(201), z.literal(400)]),
  error: z.string().optional(),
});
export type IngestResult = z.infer<typeof ingestResult>;

export const ingestResponse = z.object({
  successes: z.array(ingestResult),
  errors: z.array(ingestResult),
});
export type IngestResponse = z.infer<typeof ingestResponse>;
