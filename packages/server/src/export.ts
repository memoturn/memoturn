import { clickhouse } from "@memoturn/db/clickhouse";

/**
 * Batch export — stream a project's traces (with their observations) as newline-
 * delimited JSON for download / offline analysis / warehousing. Filterable like the
 * trace list. Returns an NDJSON string (one trace object per line).
 */
export interface ExportFilters {
  limit?: number;
  environment?: string;
}

export async function exportTracesJsonl(projectId: string, filters: ExportFilters = {}): Promise<string> {
  const { limit = 1000, environment } = filters;
  const conds = ["t.project_id = {projectId:String}"];
  const params: Record<string, unknown> = { projectId, limit };
  if (environment) {
    conds.push("t.environment = {environment:String}");
    params.environment = environment;
  }

  const rs = await clickhouse().query({
    query: `
      SELECT
        t.id AS id,
        t.name AS name,
        formatDateTime(t.timestamp, '%Y-%m-%dT%H:%i:%SZ') AS timestamp,
        t.user_id AS user_id,
        t.session_id AS session_id,
        t.environment AS environment,
        t.input AS input,
        t.output AS output,
        groupArray((o.id, o.type, o.name, o.model, o.total_tokens, o.total_cost, o.latency_ms)) AS observations
      FROM traces AS t FINAL
      LEFT JOIN observations AS o FINAL ON o.trace_id = t.id AND o.project_id = t.project_id
      WHERE ${conds.join(" AND ")}
      GROUP BY t.id, t.name, t.timestamp, t.user_id, t.session_id, t.environment, t.input, t.output
      ORDER BY t.timestamp DESC
      LIMIT {limit:UInt32}
    `,
    query_params: params,
    format: "JSONEachRow",
  });

  const rows = await rs.json<Record<string, unknown>>();
  return rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : "");
}
