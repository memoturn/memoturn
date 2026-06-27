import { z } from "zod";

/**
 * memoturn ingestion wire contract.
 *
 * A client POSTs a batch of envelopes to `/v1/ingest`. Each envelope carries its
 * own `id` (for idempotency/dedup) and `timestamp` (the event_ts used to merge
 * late/partial updates in ClickHouse — newest wins). The `body` shape is selected
 * by the envelope `type`.
 *
 * This file is the single source of truth shared by the SDK, the web API, and the
 * worker. Changing it changes all three.
 */

export const ISO_DATETIME = z.iso.datetime({ offset: true });

export const ObservationLevel = z.enum(["DEBUG", "DEFAULT", "WARNING", "ERROR"]);
export type ObservationLevel = z.infer<typeof ObservationLevel>;

export const ScoreDataType = z.enum(["NUMERIC", "CATEGORICAL", "BOOLEAN"]);
export type ScoreDataType = z.infer<typeof ScoreDataType>;

export const ScoreSource = z.enum(["API", "EVAL", "ANNOTATION"]);
export type ScoreSource = z.infer<typeof ScoreSource>;

/**
 * Hard ceiling for a single serialized JSON field (input/output/metadata). Oversized
 * fields are rejected at ingest (400) to bound memory/storage. This is the ceiling — the
 * worker soft-truncates large-but-allowed payloads to blob storage well below this.
 */
export const MAX_JSON_FIELD_BYTES = 1024 * 1024; // 1 MB

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
  })
  .optional();

// ── Trace ─────────────────────────────────────────────────────────────────────
export const traceBody = z.object({
  id: z.string().min(1),
  name: z.string().optional(),
  timestamp: ISO_DATETIME.optional(),
  userId: z.string().optional(),
  sessionId: z.string().optional(),
  release: z.string().optional(),
  version: z.string().optional(),
  environment: z.string().default("default"),
  public: z.boolean().optional(),
  tags: z.array(z.string()).optional(),
  metadata: Json.optional(),
  input: Json.optional(),
  output: Json.optional(),
});
export type TraceBody = z.infer<typeof traceBody>;

// ── Observation (span / generation / event) ─────────────────────────────────────
const observationBase = z.object({
  id: z.string().min(1),
  traceId: z.string().min(1),
  parentObservationId: z.string().optional(),
  name: z.string().optional(),
  startTime: ISO_DATETIME.optional(),
  endTime: ISO_DATETIME.optional(),
  environment: z.string().default("default"),
  level: ObservationLevel.optional(),
  statusMessage: z.string().optional(),
  metadata: Json.optional(),
  input: Json.optional(),
  output: Json.optional(),
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
export const scoreBody = z.object({
  id: z.string().min(1),
  traceId: z.string().min(1),
  observationId: z.string().optional(),
  name: z.string().min(1),
  timestamp: ISO_DATETIME.optional(),
  environment: z.string().default("default"),
  source: ScoreSource.default("API"),
  dataType: ScoreDataType.default("NUMERIC"),
  value: z.number().optional(),
  stringValue: z.string().optional(),
  comment: z.string().optional(),
  configId: z.string().optional(),
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
  id: z.string(),
  status: z.union([z.literal(201), z.literal(400)]),
  error: z.string().optional(),
});
export type IngestResult = z.infer<typeof ingestResult>;

export const ingestResponse = z.object({
  successes: z.array(ingestResult),
  errors: z.array(ingestResult),
});
export type IngestResponse = z.infer<typeof ingestResponse>;
