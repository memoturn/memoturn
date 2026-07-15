/**
 * Telemetry row + filter shapes shared by the store interface, the worker mappers, and
 * packages/server. Write rows are engine-neutral: snake_case keys, enum values as string
 * literals, ISO-8601 timestamps, `public` as 0/1 — the engine implementation serializes
 * them to whatever the underlying store expects.
 */

// ── Write rows (produced by apps/worker mappers + score corrections) ─────────────

export interface TraceRow {
  id: string;
  project_id: string;
  timestamp: string;
  name: string;
  user_id: string;
  session_id: string;
  release: string;
  version: string;
  environment: string;
  public: number;
  tags: string[];
  metadata: string;
  input: string;
  output: string;
  event_ts: string;
}

export interface ObservationRow {
  id: string;
  trace_id: string;
  project_id: string;
  type: "SPAN" | "GENERATION" | "EVENT";
  parent_observation_id: string;
  name: string;
  start_time: string;
  end_time: string | null;
  environment: string;
  level: "DEBUG" | "DEFAULT" | "WARNING" | "ERROR";
  status_message: string;
  model: string;
  provider: string;
  model_parameters: string;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  input_cost: number;
  output_cost: number;
  total_cost: number;
  prompt_id: string;
  prompt_version: string;
  input: string;
  output: string;
  metadata: string;
  latency_ms: number;
  event_ts: string;
}

export interface ScoreWriteRow {
  id: string;
  project_id: string;
  trace_id: string;
  observation_id: string;
  name: string;
  timestamp: string;
  environment: string;
  source: "API" | "EVAL" | "ANNOTATION";
  data_type: "NUMERIC" | "CATEGORICAL" | "BOOLEAN";
  value: number | null;
  string_value: string;
  comment: string;
  config_id: string;
  event_ts: string;
}

/** Per-table write-row map — keeps `insertRows(table, rows)` type-safe generically. */
export interface TelemetryRowMap {
  traces: TraceRow;
  observations: ObservationRow;
  scores: ScoreWriteRow;
}

export type TelemetryTable = keyof TelemetryRowMap;

// ── Read filters ─────────────────────────────────────────────────────────────────

export interface TraceFilters {
  limit?: number;
  offset?: number; // rows to skip (pagination)
  userId?: string;
  sessionId?: string;
  environment?: string;
  search?: string; // matches trace name (case-insensitive substring)
  tag?: string; // trace must carry this tag
  promptId?: string; // trace has an observation that used this prompt (by prompt_id)
  scoreName?: string; // trace has a score with this name
  level?: string; // trace has an observation at this level (e.g. ERROR / WARNING)
  days?: number; // only traces from the last N days
}

/**
 * Batch-export filters. Same shape as the trace list so an export honors whatever
 * filters the user has applied in the console (environment, search, tag, score, level, …).
 */
export type ExportFilters = TraceFilters;

// ── Read shapes not covered by @memoturn/contracts ───────────────────────────────

/** Trace row without the per-observation rollups (getTrace assembles the rest). */
export interface TraceHeader {
  id: string;
  name: string;
  timestamp: string;
  user_id: string;
  session_id: string;
  environment: string;
  release: string;
  version: string;
  tags: string[];
  metadata: string;
  input: string;
  output: string;
}

export interface TraceIO {
  id: string;
  name: string;
  input: string;
  output: string;
}

export interface TraceScore {
  trace_id: string;
  name: string;
  value: number | null;
  string_value: string;
}

/** Full score row as stored — read back for corrections (PATCH /v1/scores/{id}). */
export interface FullScoreRow {
  id: string;
  trace_id: string;
  observation_id: string;
  name: string;
  timestamp: string; // ISO-formatted
  environment: string;
  source: "API" | "EVAL" | "ANNOTATION";
  data_type: "NUMERIC" | "CATEGORICAL" | "BOOLEAN";
  value: number | null;
  string_value: string;
  comment: string;
  config_id: string;
}

export interface EvalScoreSummaryRow {
  name: string;
  count: number;
  avgValue: number;
}

export interface EvalScoreTrendRow {
  date: string;
  name: string;
  count: number;
  avgValue: number;
}

export interface ExportObservationRow {
  id: string;
  type: string;
  name: string;
  model: string;
  total_tokens: number;
  total_cost: number;
  latency_ms: number;
}

export interface ExportTraceRow {
  id: string;
  name: string;
  timestamp: string;
  user_id: string;
  session_id: string;
  environment: string;
  input: string;
  output: string;
  observations: ExportObservationRow[];
}

export interface ProjectRowCounts {
  traces: number;
  observations: number;
  scores: number;
}
