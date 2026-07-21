import { Writable } from "node:stream";
import parquet from "@dsnp/parquetjs";
import { type ExportFilters, telemetry } from "@memoturn/telemetry";

/**
 * Batch export — stream a project's traces (with their observations) as newline-
 * delimited JSON for download / offline analysis / warehousing. Filterable like the
 * trace list. Returns an NDJSON string (one trace object per line).
 */
export type { ExportFilters };

/** Hard ceiling on rows per export — the whole result set (with payloads) is built in memory. */
export const MAX_EXPORT_ROWS = 100_000;

/** Clamp a requested export limit into [1, MAX_EXPORT_ROWS]; NaN/absent/≤0 → the 1000 default. */
export function clampExportLimit(raw: string | number | null | undefined): number {
  const n = Math.floor(Number(raw ?? 1000));
  if (!Number.isFinite(n) || n < 1) return 1000;
  return Math.min(n, MAX_EXPORT_ROWS);
}

export async function exportTracesJsonl(projectId: string, filters: ExportFilters = {}): Promise<string> {
  const rows = await telemetry().exportTraces(projectId, filters);
  return rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : "");
}

/** Quote a CSV field (RFC 4180): wrap in quotes and double any embedded quotes. */
function csvField(v: unknown): string {
  const s = v == null ? "" : typeof v === "string" ? v : JSON.stringify(v);
  return `"${s.replace(/"/g, '""')}"`;
}

/** Export traces as CSV. Nested observations are summarized to a count (CSV is flat). */
export async function exportTracesCsv(projectId: string, filters: ExportFilters = {}): Promise<string> {
  const rows = await telemetry().exportTraces(projectId, filters);
  const cols = [
    "id",
    "name",
    "timestamp",
    "user_id",
    "session_id",
    "environment",
    "observation_count",
    "input",
    "output",
  ];
  const header = cols.join(",");
  const lines = rows.map((r) =>
    [r.id, r.name, r.timestamp, r.user_id, r.session_id, r.environment, r.observations.length, r.input, r.output]
      .map(csvField)
      .join(","),
  );
  return [header, ...lines].join("\n") + (lines.length ? "\n" : "");
}

/**
 * Export traces as Apache Parquet (flat, one row per trace) for BI / notebook use. Nested
 * observations are summarized to a count plus rolled-up cost/tokens (Parquet is columnar).
 * Returns the file bytes. The writer streams into an in-memory sink.
 */
export async function exportTracesParquet(projectId: string, filters: ExportFilters = {}): Promise<Buffer> {
  const rows = await telemetry().exportTraces(projectId, filters);
  const schema = new parquet.ParquetSchema({
    id: { type: "UTF8" },
    name: { type: "UTF8" },
    timestamp: { type: "UTF8" },
    user_id: { type: "UTF8" },
    session_id: { type: "UTF8" },
    environment: { type: "UTF8" },
    observation_count: { type: "INT64" },
    total_cost: { type: "DOUBLE" },
    total_tokens: { type: "INT64" },
    input: { type: "UTF8", optional: true },
    output: { type: "UTF8", optional: true },
  });
  const chunks: Buffer[] = [];
  const sink = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(Buffer.from(chunk));
      cb();
    },
  });
  const writer = await parquet.ParquetWriter.openStream(schema, sink as never);
  for (const r of rows) {
    await writer.appendRow({
      id: r.id,
      name: r.name,
      timestamp: r.timestamp,
      user_id: r.user_id,
      session_id: r.session_id,
      environment: r.environment,
      observation_count: r.observations.length,
      total_cost: r.observations.reduce((s, o) => s + (o.total_cost ?? 0), 0),
      total_tokens: r.observations.reduce((s, o) => s + (o.total_tokens ?? 0), 0),
      input: typeof r.input === "string" ? r.input : JSON.stringify(r.input ?? null),
      output: typeof r.output === "string" ? r.output : JSON.stringify(r.output ?? null),
    });
  }
  await writer.close();
  return Buffer.concat(chunks);
}
