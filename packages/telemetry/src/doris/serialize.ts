import type { ObservationRow, ScoreWriteRow, TelemetryRowMap, TelemetryTable, TraceRow } from "../types.js";

/**
 * Serialization between memoturn's engine-neutral row shapes and Doris SQL.
 *
 * Timestamps: rows carry ISO-8601 UTC strings; Doris DATETIME(3) wants
 * 'YYYY-MM-DD HH:MM:SS.mmm' (sessions are pinned to UTC by the client).
 * Arrays: `tags` is bound as a JSON string and CAST to ARRAY<STRING> in SQL.
 */

/** ISO-8601 → Doris DATETIME(3) literal ('YYYY-MM-DD HH:MM:SS.mmm', UTC). */
export function toDorisDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) throw new Error(`invalid timestamp: ${iso}`);
  return d.toISOString().slice(0, 23).replace("T", " ");
}

/** Doris DATETIME string (or ISO input) → ISO-8601 UTC. */
export function toIso(dorisDateTime: string): string {
  return `${dorisDateTime.replace(" ", "T").slice(0, 19)}Z`;
}

/** Parse a Doris ARRAY<STRING> value as returned over the MySQL protocol. */
export function parseTags(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value !== "string" || value === "") return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

/**
 * Per-table column serialization: column order, the SQL placeholder for each column
 * (tags needs a CAST), and the bound value extracted from the row.
 */
interface ColumnSpec<Row> {
  name: string;
  placeholder?: string; // defaults to "?"
  value: (row: Row) => unknown;
}

const traceColumns: ColumnSpec<TraceRow>[] = [
  { name: "project_id", value: (r) => r.project_id },
  { name: "id", value: (r) => r.id },
  { name: "`timestamp`", value: (r) => toDorisDateTime(r.timestamp) },
  { name: "name", value: (r) => r.name },
  { name: "user_id", value: (r) => r.user_id },
  { name: "session_id", value: (r) => r.session_id },
  { name: "`release`", value: (r) => r.release },
  { name: "version", value: (r) => r.version },
  { name: "environment", value: (r) => r.environment },
  { name: "`public`", value: (r) => r.public },
  { name: "tags", placeholder: "CAST(? AS ARRAY<STRING>)", value: (r) => JSON.stringify(r.tags ?? []) },
  { name: "metadata", value: (r) => r.metadata },
  { name: "input", value: (r) => r.input },
  { name: "output", value: (r) => r.output },
  { name: "event_ts", value: (r) => toDorisDateTime(r.event_ts) },
];

const observationColumns: ColumnSpec<ObservationRow>[] = [
  { name: "project_id", value: (r) => r.project_id },
  { name: "trace_id", value: (r) => r.trace_id },
  { name: "id", value: (r) => r.id },
  { name: "type", value: (r) => r.type },
  { name: "parent_observation_id", value: (r) => r.parent_observation_id },
  { name: "name", value: (r) => r.name },
  { name: "start_time", value: (r) => toDorisDateTime(r.start_time) },
  { name: "end_time", value: (r) => (r.end_time === null ? null : toDorisDateTime(r.end_time)) },
  { name: "environment", value: (r) => r.environment },
  { name: "level", value: (r) => r.level },
  { name: "status_message", value: (r) => r.status_message },
  { name: "model", value: (r) => r.model },
  { name: "provider", value: (r) => r.provider },
  { name: "model_parameters", value: (r) => r.model_parameters },
  { name: "prompt_tokens", value: (r) => r.prompt_tokens },
  { name: "completion_tokens", value: (r) => r.completion_tokens },
  { name: "total_tokens", value: (r) => r.total_tokens },
  { name: "input_cost", value: (r) => r.input_cost },
  { name: "output_cost", value: (r) => r.output_cost },
  { name: "total_cost", value: (r) => r.total_cost },
  { name: "prompt_id", value: (r) => r.prompt_id },
  { name: "prompt_version", value: (r) => r.prompt_version },
  { name: "input", value: (r) => r.input },
  { name: "output", value: (r) => r.output },
  { name: "metadata", value: (r) => r.metadata },
  { name: "latency_ms", value: (r) => r.latency_ms },
  { name: "event_ts", value: (r) => toDorisDateTime(r.event_ts) },
];

const scoreColumns: ColumnSpec<ScoreWriteRow>[] = [
  { name: "project_id", value: (r) => r.project_id },
  { name: "id", value: (r) => r.id },
  { name: "trace_id", value: (r) => r.trace_id },
  { name: "observation_id", value: (r) => r.observation_id },
  { name: "name", value: (r) => r.name },
  { name: "`timestamp`", value: (r) => toDorisDateTime(r.timestamp) },
  { name: "environment", value: (r) => r.environment },
  { name: "source", value: (r) => r.source },
  { name: "data_type", value: (r) => r.data_type },
  { name: "`value`", value: (r) => r.value },
  { name: "string_value", value: (r) => r.string_value },
  { name: "`comment`", value: (r) => r.comment },
  { name: "config_id", value: (r) => r.config_id },
  { name: "event_ts", value: (r) => toDorisDateTime(r.event_ts) },
];

const COLUMNS: { [T in TelemetryTable]: ColumnSpec<TelemetryRowMap[T]>[] } = {
  traces: traceColumns,
  observations: observationColumns,
  scores: scoreColumns,
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
  const rowTemplate = `(${specs.map((c) => c.placeholder ?? "?").join(", ")})`;
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
    const values = specs.map((c) => c.value(row));
    const rowBytes = values.reduce<number>((s, v) => s + (typeof v === "string" ? v.length : 8), 0);
    if (tuples.length > 0 && bytes + rowBytes > MAX_STATEMENT_BYTES) flush();
    tuples.push(rowTemplate);
    params.push(...values);
    bytes += rowBytes;
  }
  flush();
  return statements;
}
