// Wire types — kept local to the SDK so it stays dependency-free and publishable
// on its own. Must stay structurally compatible with @memoturn/core's Zod contracts.

export type JsonValue = unknown;

export interface Usage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

export type ObservationLevel = "DEBUG" | "DEFAULT" | "WARNING" | "ERROR";

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

export interface SpanInput {
  id?: string;
  name?: string;
  parentObservationId?: string;
  metadata?: JsonValue;
  input?: JsonValue;
  output?: JsonValue;
  level?: ObservationLevel;
  statusMessage?: string;
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

export interface MemoturnOptions {
  baseUrl?: string;
  publicKey?: string;
  secretKey?: string;
  environment?: string;
  /** Flush when the buffer reaches this many events. Default 20. */
  flushAt?: number;
  /** Flush at least this often (ms). Default 5000. */
  flushInterval?: number;
}
