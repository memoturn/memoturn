import { type ClickHouseClient, createClient } from "@clickhouse/client";
import type {
  DailyMetric,
  ModelMetric,
  ObservationDetail,
  ScoreRow as ScoreDetail,
  SessionSummary,
  TraceSummary,
  WidgetBreakdown,
  WidgetMetric,
  WidgetPoint,
} from "@memoturn/contracts";
import type { TelemetryStore } from "./store.js";
import type {
  EvalScoreSummaryRow,
  EvalScoreTrendRow,
  ExportFilters,
  ExportObservationRow,
  ExportTraceRow,
  FullScoreRow,
  ProjectRowCounts,
  TelemetryRowMap,
  TelemetryTable,
  TraceFilters,
  TraceHeader,
  TraceIO,
  TraceScore,
} from "./types.js";

/**
 * ClickHouse implementation of the TelemetryStore — TRANSITIONAL scaffold. It exists so
 * the seam extraction lands with green gates; the Apache Doris implementation replaces
 * it (and this file is deleted) in the engine-swap phase. Reads use FINAL so
 * ReplacingMergeTree de-duplicates merged rows at read time; all queries are scoped by
 * project_id and parameterized ({name:Type}), never string-interpolated.
 */

const ISO_FMT = "'%Y-%m-%dT%H:%i:%SZ'";

export class ClickHouseTelemetryStore implements TelemetryStore {
  private client: ClickHouseClient | undefined;

  private ch(): ClickHouseClient {
    if (!this.client) {
      this.client = createClient({
        url: process.env.CLICKHOUSE_URL ?? "http://localhost:8123",
        username: process.env.CLICKHOUSE_USER ?? "memoturn",
        password: process.env.CLICKHOUSE_PASSWORD ?? "memoturn",
        database: process.env.CLICKHOUSE_DB ?? "memoturn",
        clickhouse_settings: {
          async_insert: 1,
          wait_for_async_insert: 1,
          // Accept ISO-8601 timestamps (with 'T' and 'Z') directly in inserts.
          date_time_input_format: "best_effort",
        },
      });
    }
    return this.client;
  }

  private async query<T>(sql: string, params: Record<string, unknown>): Promise<T[]> {
    const rs = await this.ch().query({ query: sql, query_params: params, format: "JSONEachRow" });
    return rs.json<T>();
  }

  private async command(sql: string, params: Record<string, unknown>): Promise<void> {
    await this.ch().command({ query: sql, query_params: params });
  }

  // ── Reads ──────────────────────────────────────────────────────────────────────

  async listTraces(projectId: string, filters: TraceFilters = {}): Promise<TraceSummary[]> {
    const { limit = 50, userId, sessionId, environment, search, tag, days } = filters;
    const conds: string[] = ["t.project_id = {projectId:String}"];
    const params: Record<string, unknown> = { projectId, limit };
    if (userId) {
      conds.push("t.user_id = {userId:String}");
      params.userId = userId;
    }
    if (sessionId) {
      conds.push("t.session_id = {sessionId:String}");
      params.sessionId = sessionId;
    }
    if (environment) {
      conds.push("t.environment = {environment:String}");
      params.environment = environment;
    }
    if (search) {
      conds.push("positionCaseInsensitive(t.name, {search:String}) > 0");
      params.search = search;
    }
    if (tag) {
      conds.push("has(t.tags, {tag:String})");
      params.tag = tag;
    }
    if (days && days > 0) {
      conds.push("t.timestamp >= now() - toIntervalDay({days:UInt32})");
      params.days = Math.floor(days);
    }

    const rows = await this.query<TraceSummary>(
      `
      SELECT
        t.id AS id,
        t.name AS name,
        formatDateTime(t.timestamp, ${ISO_FMT}) AS timestamp,
        t.user_id AS user_id,
        t.session_id AS session_id,
        t.environment AS environment,
        t.tags AS tags,
        count(o.id) AS observation_count,
        sum(o.total_cost) AS total_cost,
        sum(o.total_tokens) AS total_tokens,
        max(o.latency_ms) AS latency_ms
      FROM traces AS t FINAL
      LEFT JOIN observations AS o FINAL ON o.trace_id = t.id AND o.project_id = t.project_id
      WHERE ${conds.join(" AND ")}
      GROUP BY t.id, t.name, t.timestamp, t.user_id, t.session_id, t.environment, t.tags
      ORDER BY t.timestamp DESC
      LIMIT {limit:UInt32}
      `,
      params,
    );
    return rows.map((r) => ({
      ...r,
      observation_count: Number(r.observation_count),
      total_cost: Number(r.total_cost),
      total_tokens: Number(r.total_tokens),
      latency_ms: Number(r.latency_ms),
    }));
  }

  async listSessions(projectId: string, limit = 50): Promise<SessionSummary[]> {
    const rows = await this.query<SessionSummary>(
      `
      SELECT
        t.session_id AS session_id,
        count(DISTINCT t.id) AS trace_count,
        formatDateTime(min(t.timestamp), ${ISO_FMT}) AS first_seen,
        formatDateTime(max(t.timestamp), ${ISO_FMT}) AS last_seen,
        sum(o.total_cost) AS total_cost
      FROM traces AS t FINAL
      LEFT JOIN observations AS o FINAL ON o.trace_id = t.id AND o.project_id = t.project_id
      WHERE t.project_id = {projectId:String} AND t.session_id != ''
      GROUP BY t.session_id
      ORDER BY last_seen DESC
      LIMIT {limit:UInt32}
      `,
      { projectId, limit },
    );
    return rows.map((r) => ({ ...r, trace_count: Number(r.trace_count), total_cost: Number(r.total_cost) }));
  }

  async getTraceHeader(projectId: string, traceId: string): Promise<TraceHeader | null> {
    const rows = await this.query<TraceHeader>(
      `
      SELECT
        id,
        name,
        formatDateTime(timestamp, ${ISO_FMT}) AS timestamp,
        user_id, session_id, environment, release, version, tags, metadata, input, output
      FROM traces FINAL
      WHERE project_id = {projectId:String} AND id = {traceId:String}
      LIMIT 1
      `,
      { projectId, traceId },
    );
    return rows[0] ?? null;
  }

  async listObservationsByTrace(projectId: string, traceId: string): Promise<ObservationDetail[]> {
    const rows = await this.query<ObservationDetail>(
      `
      SELECT
        id, trace_id, type, parent_observation_id, name,
        formatDateTime(start_time, ${ISO_FMT}) AS start_time,
        if(end_time IS NULL, NULL, formatDateTime(end_time, ${ISO_FMT})) AS end_time,
        level, status_message, model, provider,
        prompt_tokens, completion_tokens, total_tokens, total_cost, latency_ms,
        input, output, metadata
      FROM observations FINAL
      WHERE project_id = {projectId:String} AND trace_id = {traceId:String}
      ORDER BY start_time ASC
      `,
      { projectId, traceId },
    );
    return rows.map((r) => ({
      ...r,
      prompt_tokens: Number(r.prompt_tokens),
      completion_tokens: Number(r.completion_tokens),
      total_tokens: Number(r.total_tokens),
      total_cost: Number(r.total_cost),
      latency_ms: Number(r.latency_ms),
    }));
  }

  async listScoresByTrace(projectId: string, traceId: string): Promise<ScoreDetail[]> {
    const rows = await this.query<ScoreDetail>(
      `
      SELECT
        name, source, data_type, value, string_value, comment,
        formatDateTime(timestamp, ${ISO_FMT}) AS timestamp
      FROM scores FINAL
      WHERE project_id = {projectId:String} AND trace_id = {traceId:String}
      ORDER BY timestamp ASC
      `,
      { projectId, traceId },
    );
    return rows.map((r) => ({ ...r, value: r.value === null ? null : Number(r.value) }));
  }

  async getTraceIO(projectId: string, traceIds: string[]): Promise<TraceIO[]> {
    if (traceIds.length === 0) return [];
    return this.query<TraceIO>(
      `
      SELECT id, name, input, output
      FROM traces FINAL
      WHERE project_id = {projectId:String} AND id IN {ids:Array(String)}
      `,
      { projectId, ids: traceIds },
    );
  }

  async getScoresByTraceIds(projectId: string, traceIds: string[]): Promise<TraceScore[]> {
    if (traceIds.length === 0) return [];
    const rows = await this.query<TraceScore>(
      `
      SELECT trace_id, name, value, string_value
      FROM scores FINAL
      WHERE project_id = {projectId:String} AND trace_id IN {ids:Array(String)}
      `,
      { projectId, ids: traceIds },
    );
    return rows.map((r) => ({ ...r, value: r.value === null ? null : Number(r.value) }));
  }

  async getScoreById(projectId: string, scoreId: string): Promise<FullScoreRow | null> {
    const rows = await this.query<FullScoreRow>(
      `
      SELECT
        id, trace_id, observation_id, name,
        formatDateTime(timestamp, ${ISO_FMT}) AS timestamp,
        environment, source, data_type, value, string_value, comment, config_id
      FROM scores FINAL
      WHERE project_id = {p:String} AND id = {id:String}
      LIMIT 1
      `,
      { p: projectId, id: scoreId },
    );
    const r = rows[0];
    if (!r) return null;
    return { ...r, value: r.value === null ? null : Number(r.value) };
  }

  async evaluatorScoreSummary(projectId: string, days: number): Promise<EvalScoreSummaryRow[]> {
    const rows = await this.query<{ name: string; count: string; avgValue: string }>(
      `
      SELECT name, count() AS count, avg(value) AS avgValue
      FROM scores FINAL
      WHERE project_id = {projectId:String}
        AND source = 'EVAL'
        AND timestamp >= now() - toIntervalDay({days:UInt32})
        AND value IS NOT NULL
      GROUP BY name
      ORDER BY count DESC
      `,
      { projectId, days },
    );
    return rows.map((r) => ({ name: r.name, count: Number(r.count), avgValue: Number(r.avgValue) }));
  }

  async evaluatorScoreTrend(projectId: string, days: number): Promise<EvalScoreTrendRow[]> {
    const rows = await this.query<{ date: string; name: string; count: string; avgValue: string }>(
      `
      SELECT toString(toDate(timestamp)) AS date, name, count() AS count, avg(value) AS avgValue
      FROM scores FINAL
      WHERE project_id = {projectId:String}
        AND source = 'EVAL'
        AND timestamp >= now() - toIntervalDay({days:UInt32})
        AND value IS NOT NULL
      GROUP BY date, name
      ORDER BY date ASC, name ASC
      `,
      { projectId, days },
    );
    return rows.map((r) => ({ date: r.date, name: r.name, count: Number(r.count), avgValue: Number(r.avgValue) }));
  }

  async metricsByDay(projectId: string, days: number): Promise<DailyMetric[]> {
    const rows = await this.query<{
      date: string;
      generations: string;
      total_tokens: string;
      total_cost: string;
      latency: number[];
    }>(
      `
      SELECT
        toString(toDate(start_time)) AS date,
        count() AS generations,
        sum(total_tokens) AS total_tokens,
        sum(total_cost) AS total_cost,
        quantiles(0.5, 0.95)(latency_ms) AS latency
      FROM observations FINAL
      WHERE project_id = {projectId:String}
        AND type = 'GENERATION'
        AND toDate(start_time) >= today() - {days:UInt32}
      GROUP BY date
      ORDER BY date ASC
      `,
      { projectId, days },
    );
    return rows.map((r) => ({
      date: r.date,
      generations: Number(r.generations),
      total_tokens: Number(r.total_tokens),
      total_cost: Number(r.total_cost),
      p50_latency_ms: Math.round(Number(r.latency?.[0] ?? 0)),
      p95_latency_ms: Math.round(Number(r.latency?.[1] ?? 0)),
    }));
  }

  async metricsByModel(projectId: string, days: number): Promise<ModelMetric[]> {
    const rows = await this.query<ModelMetric>(
      `
      SELECT
        model,
        count() AS generations,
        sum(total_tokens) AS total_tokens,
        sum(total_cost) AS total_cost
      FROM observations FINAL
      WHERE project_id = {projectId:String}
        AND type = 'GENERATION'
        AND toDate(start_time) >= today() - {days:UInt32}
      GROUP BY model
      ORDER BY total_cost DESC
      `,
      { projectId, days },
    );
    return rows.map((r) => ({
      model: r.model,
      generations: Number(r.generations),
      total_tokens: Number(r.total_tokens),
      total_cost: Number(r.total_cost),
    }));
  }

  async countTracesSince(projectId: string, days: number): Promise<number> {
    const rows = await this.query<{ c: string }>(
      `SELECT count() AS c FROM (SELECT id FROM traces FINAL WHERE project_id = {projectId:String} AND timestamp >= now() - toIntervalDay({days:UInt32}) GROUP BY id)`,
      { projectId, days },
    );
    return Number(rows[0]?.c ?? 0);
  }

  async widgetSeries(
    projectId: string,
    metric: WidgetMetric,
    breakdown: WidgetBreakdown,
    days: number,
  ): Promise<WidgetPoint[]> {
    // Fixed allowlist — the aggregate expression is never derived from user input.
    const AGG: Record<WidgetMetric, string> = {
      cost: "sum(total_cost)",
      tokens: "sum(total_tokens)",
      generations: "count()",
      latency_p95: "arrayElement(quantiles(0.95)(latency_ms), 1)",
    };
    const agg = AGG[metric] ?? AGG.cost;
    const groupExpr = breakdown === "by_model" ? "model" : "toString(toDate(start_time))";
    const order = breakdown === "by_model" ? "value DESC" : "label ASC";
    const rows = await this.query<{ label: string; value: number }>(
      `
      SELECT ${groupExpr} AS label, ${agg} AS value
      FROM observations FINAL
      WHERE project_id = {projectId:String}
        AND type = 'GENERATION'
        AND toDate(start_time) >= today() - {days:UInt32}
      GROUP BY label
      ORDER BY ${order}
      LIMIT 100
      `,
      { projectId, days },
    );
    return rows.map((r) => ({ label: r.label || "(unknown)", value: Number(r.value) }));
  }

  async exportTraces(projectId: string, filters: ExportFilters = {}): Promise<ExportTraceRow[]> {
    const { limit = 1000, environment } = filters;
    const conds = ["project_id = {projectId:String}"];
    const params: Record<string, unknown> = { projectId, limit };
    if (environment) {
      conds.push("environment = {environment:String}");
      params.environment = environment;
    }

    const traces = await this.query<Omit<ExportTraceRow, "observations">>(
      `
      SELECT
        id, name,
        formatDateTime(timestamp, ${ISO_FMT}) AS timestamp,
        user_id, session_id, environment, input, output
      FROM traces FINAL
      WHERE ${conds.join(" AND ")}
      ORDER BY timestamp DESC
      LIMIT {limit:UInt32}
      `,
      params,
    );
    if (traces.length === 0) return [];

    const observations = await this.query<ExportObservationRow & { trace_id: string }>(
      `
      SELECT trace_id, id, type, name, model, total_tokens, total_cost, latency_ms
      FROM observations FINAL
      WHERE project_id = {projectId:String} AND trace_id IN {ids:Array(String)}
      `,
      { projectId, ids: traces.map((t) => t.id) },
    );
    const byTrace = new Map<string, ExportObservationRow[]>();
    for (const { trace_id, ...o } of observations) {
      const arr = byTrace.get(trace_id) ?? [];
      arr.push({
        ...o,
        total_tokens: Number(o.total_tokens),
        total_cost: Number(o.total_cost),
        latency_ms: Number(o.latency_ms),
      });
      byTrace.set(trace_id, arr);
    }
    return traces.map((t) => ({ ...t, observations: byTrace.get(t.id) ?? [] }));
  }

  async countTracesOlderThan(projectId: string, days: number): Promise<number> {
    const rows = await this.query<{ c: string }>(
      `SELECT count() AS c FROM traces FINAL WHERE project_id = {p:String} AND timestamp < now() - toIntervalDay({days:UInt32})`,
      { p: projectId, days: Math.floor(days) },
    );
    return Number(rows[0]?.c ?? 0);
  }

  async countProjectRows(projectId: string): Promise<ProjectRowCounts> {
    const count = async (table: TelemetryTable) => {
      const rows = await this.query<{ c: string }>(
        `SELECT count() AS c FROM ${table} FINAL WHERE project_id = {p:String}`,
        { p: projectId },
      );
      return Number(rows[0]?.c ?? 0);
    };
    return { traces: await count("traces"), observations: await count("observations"), scores: await count("scores") };
  }

  // ── Writes ─────────────────────────────────────────────────────────────────────

  async insertRows<T extends TelemetryTable>(table: T, rows: TelemetryRowMap[T][]): Promise<void> {
    if (rows.length === 0) return;
    // latency_ms is a MATERIALIZED column in the ClickHouse DDL — it cannot be inserted
    // explicitly, so strip it here (the Doris schema stores it as a plain column).
    const values: object[] =
      table === "observations"
        ? (rows as TelemetryRowMap["observations"][]).map(({ latency_ms: _latency, ...rest }) => rest)
        : rows;
    await this.ch().insert({ table, values, format: "JSONEachRow" });
  }

  async deleteScore(projectId: string, scoreId: string): Promise<void> {
    await this.command("DELETE FROM scores WHERE project_id = {p:String} AND id = {id:String}", {
      p: projectId,
      id: scoreId,
    });
  }

  async deleteTraces(projectId: string, traceIds: string[]): Promise<void> {
    if (traceIds.length === 0) return;
    const params = { p: projectId, ids: traceIds };
    await this.command("DELETE FROM traces WHERE project_id = {p:String} AND id IN {ids:Array(String)}", params);
    await this.command(
      "DELETE FROM observations WHERE project_id = {p:String} AND trace_id IN {ids:Array(String)}",
      params,
    );
    await this.command("DELETE FROM scores WHERE project_id = {p:String} AND trace_id IN {ids:Array(String)}", params);
  }

  async deleteOlderThan(projectId: string, days: number): Promise<void> {
    const cutoff = "now() - toIntervalDay({days:UInt32})";
    const params = { p: projectId, days: Math.floor(days) };
    await this.command(`DELETE FROM traces WHERE project_id = {p:String} AND timestamp < ${cutoff}`, params);
    await this.command(`DELETE FROM observations WHERE project_id = {p:String} AND start_time < ${cutoff}`, params);
    await this.command(`DELETE FROM scores WHERE project_id = {p:String} AND timestamp < ${cutoff}`, params);
  }

  async deleteProjectData(projectId: string): Promise<void> {
    const params = { p: projectId };
    await this.command("DELETE FROM traces WHERE project_id = {p:String}", params);
    await this.command("DELETE FROM observations WHERE project_id = {p:String}", params);
    await this.command("DELETE FROM scores WHERE project_id = {p:String}", params);
  }

  // ── Ops ────────────────────────────────────────────────────────────────────────

  async ping(): Promise<boolean> {
    try {
      await this.ch().query({ query: "SELECT 1" });
      return true;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    if (this.client) {
      await this.client.close();
      this.client = undefined;
    }
  }

  /** Internal: used only by the migration runner (deleted with this scaffold). */
  async execRaw(sql: string): Promise<void> {
    await this.ch().command({ query: sql });
  }
}
