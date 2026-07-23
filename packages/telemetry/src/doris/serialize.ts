/**
 * Serialization between memoturn's engine-neutral row shapes and Doris SQL.
 *
 * Timestamps: rows carry ISO-8601 UTC strings; Doris DATETIME(3) wants
 * 'YYYY-MM-DD HH:MM:SS.mmm' (sessions are pinned to UTC by the client).
 * Arrays: `tags` is written as an array constructor with one placeholder per element —
 * CAST('["…"]' AS ARRAY<STRING>) is NOT safe, its parser corrupts values containing
 * escaped quotes and commas.
 *
 * The engine-neutral helpers (datetime conversion, array parsing) live in
 * ../serialize-shared.ts, shared with the Postgres dialect; re-exported here so
 * existing imports keep working.
 */
import { toDorisDateTime } from "../serialize-shared.js";
import type {
  EmbeddingProjectionRow,
  EmbeddingRow,
  ObservationRow,
  RetrievalDocumentRow,
  ScoreWriteRow,
  TelemetryRowMap,
  TelemetryTable,
  TraceRow,
} from "../types.js";

export { parseTags, parseVector, toDorisDateTime, toIso } from "../serialize-shared.js";

/**
 * Per-table column serialization: column order, the SQL placeholder for each column
 * (may depend on the row — arrays bind one placeholder per element), and the bound
 * value(s) extracted from the row.
 */
interface ColumnSpec<Row> {
  name: string;
  placeholder?: (row: Row) => string; // defaults to "?"
  /** Bound values for this column — exactly as many as the placeholder has "?" marks. */
  values: (row: Row) => unknown[];
}

const traceColumns: ColumnSpec<TraceRow>[] = [
  { name: "project_id", values: (r) => [r.project_id] },
  { name: "id", values: (r) => [r.id] },
  { name: "`timestamp`", values: (r) => [toDorisDateTime(r.timestamp)] },
  { name: "name", values: (r) => [r.name] },
  { name: "user_id", values: (r) => [r.user_id] },
  { name: "session_id", values: (r) => [r.session_id] },
  { name: "`release`", values: (r) => [r.release] },
  { name: "version", values: (r) => [r.version] },
  { name: "environment", values: (r) => [r.environment] },
  { name: "`public`", values: (r) => [r.public] },
  {
    name: "tags",
    placeholder: (r) => (r.tags?.length ? `[${r.tags.map(() => "?").join(", ")}]` : "[]"),
    values: (r) => r.tags ?? [],
  },
  { name: "metadata", values: (r) => [r.metadata] },
  { name: "input", values: (r) => [r.input] },
  { name: "output", values: (r) => [r.output] },
  { name: "event_ts", values: (r) => [toDorisDateTime(r.event_ts)] },
];

const observationColumns: ColumnSpec<ObservationRow>[] = [
  { name: "project_id", values: (r) => [r.project_id] },
  { name: "trace_id", values: (r) => [r.trace_id] },
  { name: "id", values: (r) => [r.id] },
  { name: "type", values: (r) => [r.type] },
  { name: "parent_observation_id", values: (r) => [r.parent_observation_id] },
  { name: "name", values: (r) => [r.name] },
  { name: "start_time", values: (r) => [toDorisDateTime(r.start_time)] },
  { name: "end_time", values: (r) => [r.end_time === null ? null : toDorisDateTime(r.end_time)] },
  { name: "environment", values: (r) => [r.environment] },
  { name: "level", values: (r) => [r.level] },
  { name: "status_message", values: (r) => [r.status_message] },
  { name: "model", values: (r) => [r.model] },
  { name: "provider", values: (r) => [r.provider] },
  { name: "model_parameters", values: (r) => [r.model_parameters] },
  { name: "prompt_tokens", values: (r) => [r.prompt_tokens] },
  { name: "completion_tokens", values: (r) => [r.completion_tokens] },
  { name: "total_tokens", values: (r) => [r.total_tokens] },
  { name: "cache_read_tokens", values: (r) => [r.cache_read_tokens] },
  { name: "cache_creation_tokens", values: (r) => [r.cache_creation_tokens] },
  { name: "input_cost", values: (r) => [r.input_cost] },
  { name: "output_cost", values: (r) => [r.output_cost] },
  { name: "total_cost", values: (r) => [r.total_cost] },
  { name: "prompt_id", values: (r) => [r.prompt_id] },
  { name: "prompt_version", values: (r) => [r.prompt_version] },
  { name: "input", values: (r) => [r.input] },
  { name: "output", values: (r) => [r.output] },
  { name: "metadata", values: (r) => [r.metadata] },
  { name: "latency_ms", values: (r) => [r.latency_ms] },
  { name: "event_ts", values: (r) => [toDorisDateTime(r.event_ts)] },
];

const scoreColumns: ColumnSpec<ScoreWriteRow>[] = [
  { name: "project_id", values: (r) => [r.project_id] },
  { name: "id", values: (r) => [r.id] },
  { name: "trace_id", values: (r) => [r.trace_id] },
  { name: "observation_id", values: (r) => [r.observation_id] },
  { name: "name", values: (r) => [r.name] },
  { name: "`timestamp`", values: (r) => [toDorisDateTime(r.timestamp)] },
  { name: "environment", values: (r) => [r.environment] },
  { name: "source", values: (r) => [r.source] },
  { name: "data_type", values: (r) => [r.data_type] },
  { name: "`value`", values: (r) => [r.value] },
  { name: "string_value", values: (r) => [r.string_value] },
  { name: "`comment`", values: (r) => [r.comment] },
  { name: "config_id", values: (r) => [r.config_id] },
  { name: "event_ts", values: (r) => [toDorisDateTime(r.event_ts)] },
];

const retrievalDocumentColumns: ColumnSpec<RetrievalDocumentRow>[] = [
  { name: "project_id", values: (r) => [r.project_id] },
  { name: "observation_id", values: (r) => [r.observation_id] },
  { name: "rank", values: (r) => [r.rank] },
  { name: "trace_id", values: (r) => [r.trace_id] },
  { name: "doc_id", values: (r) => [r.doc_id] },
  { name: "score", values: (r) => [r.score] },
  { name: "content", values: (r) => [r.content] },
  { name: "metadata", values: (r) => [r.metadata] },
  { name: "event_ts", values: (r) => [toDorisDateTime(r.event_ts)] },
];

const embeddingColumns: ColumnSpec<EmbeddingRow>[] = [
  { name: "project_id", values: (r) => [r.project_id] },
  { name: "observation_id", values: (r) => [r.observation_id] },
  { name: "trace_id", values: (r) => [r.trace_id] },
  { name: "kind", values: (r) => [r.kind] },
  { name: "model", values: (r) => [r.model] },
  { name: "dim", values: (r) => [r.dim] },
  {
    // ARRAY<FLOAT> — one placeholder per element with NUMERIC values (never a string CAST,
    // whose parser corrupts values; same rule as `tags`).
    name: "vector",
    placeholder: (r) => (r.vector?.length ? `[${r.vector.map(() => "?").join(", ")}]` : "[]"),
    values: (r) => r.vector ?? [],
  },
  { name: "event_ts", values: (r) => [toDorisDateTime(r.event_ts)] },
];

const embeddingProjectionColumns: ColumnSpec<EmbeddingProjectionRow>[] = [
  { name: "project_id", values: (r) => [r.project_id] },
  { name: "run_id", values: (r) => [r.run_id] },
  { name: "observation_id", values: (r) => [r.observation_id] },
  { name: "trace_id", values: (r) => [r.trace_id] },
  { name: "x", values: (r) => [r.x] },
  { name: "y", values: (r) => [r.y] },
  { name: "z", values: (r) => [r.z] },
  { name: "cluster_id", values: (r) => [r.cluster_id] },
  { name: "method", values: (r) => [r.method] },
  { name: "event_ts", values: (r) => [toDorisDateTime(r.event_ts)] },
];

const COLUMNS: { [T in TelemetryTable]: ColumnSpec<TelemetryRowMap[T]>[] } = {
  traces: traceColumns,
  observations: observationColumns,
  scores: scoreColumns,
  retrieval_documents: retrievalDocumentColumns,
  embeddings: embeddingColumns,
  embedding_projections: embeddingProjectionColumns,
};

export interface InsertStatement {
  sql: string;
  params: unknown[];
}

/** Rough per-statement byte budget — stays well under the FE's max_allowed_packet. */
const MAX_STATEMENT_BYTES = 4 * 1024 * 1024;

/**
 * Build multi-row INSERT statements for a table, chunked by approximate payload size so
 * a batch of large (offload-marker-capped) rows never exceeds the packet limit.
 */
export function buildInserts<T extends TelemetryTable>(table: T, rows: TelemetryRowMap[T][]): InsertStatement[] {
  const specs = COLUMNS[table] as ColumnSpec<TelemetryRowMap[T]>[];
  const columnList = specs.map((c) => c.name).join(", ");
  const prefix = `INSERT INTO ${table} (${columnList}) VALUES `;

  const statements: InsertStatement[] = [];
  let tuples: string[] = [];
  let params: unknown[] = [];
  let bytes = 0;

  const flush = () => {
    if (tuples.length === 0) return;
    statements.push({ sql: prefix + tuples.join(", "), params });
    tuples = [];
    params = [];
    bytes = 0;
  };

  for (const row of rows) {
    const tuple = `(${specs.map((c) => (c.placeholder ? c.placeholder(row) : "?")).join(", ")})`;
    const values = specs.flatMap((c) => c.values(row));
    const rowBytes = values.reduce<number>((s, v) => s + (typeof v === "string" ? v.length : 8), 0);
    if (tuples.length > 0 && bytes + rowBytes > MAX_STATEMENT_BYTES) flush();
    tuples.push(tuple);
    params.push(...values);
    bytes += rowBytes;
  }
  flush();
  return statements;
}
