import { type ExportFilters, telemetry } from "@memoturn/telemetry";

/**
 * Batch export — stream a project's traces (with their observations) as newline-
 * delimited JSON for download / offline analysis / warehousing. Filterable like the
 * trace list. Returns an NDJSON string (one trace object per line).
 */
export type { ExportFilters };

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
