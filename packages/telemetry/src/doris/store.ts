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
import type { TelemetryStore } from "../store.js";
import type {
  EvalScoreSummaryRow,
  EvalScoreTrendRow,
  ExportFilters,
  ExportObservationRow,
  ExportTraceRow,
  FullScoreRow,
  ObservationRow,
  ProjectRowCounts,
  TelemetryRowMap,
  TelemetryTable,
  TraceFilters,
  TraceHeader,
  TraceIO,
  TraceRow,
  TraceScore,
} from "../types.js";
import { closeDorisPool, dorisPool } from "./client.js";
import { buildInserts, parseTags, toDorisDateTime } from "./serialize.js";

/**
 * Apache Doris implementation of the TelemetryStore. All tables are UNIQUE KEY
 * merge-on-write with a sequence column (event_ts), so reads need no de-dup modifier
 * and re-inserting an entity id with a newer event_ts overwrites it. Queries are
 * parameterized with `?` placeholders (mysql2 client-side escaping) and always scoped
 * by project_id. DELETE predicates stay `column op literal` — cutoffs are computed in
 * JS, never via SQL functions — for compatibility with Doris DELETE restrictions.
 */

const ISO_FMT = "'%Y-%m-%dT%H:%i:%sZ'";
// Millisecond-preserving variant for write-shaped row reads: event_ts is the LWW
// sequence value, so read-merge bases must not truncate it. %f is microseconds;
// JS Date parsing truncates the extra digits harmlessly.
const ISO_MS_FMT = "'%Y-%m-%dT%H:%i:%s.%fZ'";

/** ISO timestamp for "now minus N days" as a Doris DATETIME literal. */
function cutoffDaysAgo(days: number): string {
  return toDorisDateTime(new Date(Date.now() - Math.floor(days) * 86_400_000).toISOString());
}

/**
 * UTC-midnight-anchored cutoff N days ago as a Doris DATETIME literal. Calendar-aligned
 * sibling of cutoffDaysAgo for day-bucketed metrics: a plain `start_time >= ?` literal
 * keeps the first bucket complete AND lets Doris prune partitions — wrapping the column
 * in DATE(...) would force a full scan.
 */
function cutoffMidnightDaysAgo(days: number): string {
  const d = new Date(Date.now() - Math.floor(days) * 86_400_000);
  d.setUTCHours(0, 0, 0, 0);
  return toDorisDateTime(d.toISOString());
}

export class DorisTelemetryStore implements TelemetryStore {
  private async query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    const [rows] = await dorisPool().query(sql, params);
    return rows as T[];
  }

  private async exec(sql: string, params: unknown[] = []): Promise<void> {
    await dorisPool().query(sql, params);
  }

  // ── Reads ──────────────────────────────────────────────────────────────────────

  async listTraces(projectId: string, filters: TraceFilters = {}): Promise<TraceSummary[]> {
    const { limit = 50, userId, sessionId, environment, search, tag, days } = filters;
    const conds: string[] = ["t.project_id = ?"];
    const params: unknown[] = [projectId];
    if (userId) {
      conds.push("t.user_id = ?");
      params.push(userId);
    }
    if (sessionId) {
      conds.push("t.session_id = ?");
      params.push(sessionId);
    }
    if (environment) {
      conds.push("t.environment = ?");
      params.push(environment);
    }
    if (search) {
      conds.push("LOWER(t.name) LIKE CONCAT('%', LOWER(?), '%')");
      params.push(search);
    }
    if (tag) {
      conds.push("array_contains(t.tags, ?)");
      params.push(tag);
    }
    if (days && days > 0) {
      conds.push("t.`timestamp` >= ?");
      params.push(cutoffDaysAgo(days));
    }
    params.push(Math.floor(limit));

    // Two-step (like exportTraces): pick the page of traces first, then aggregate
    // observations for just those trace ids — an unconditioned subquery would scan
    // and GROUP BY every observation in the project before the LIMIT applies.
    const rows = await this.query<
      Omit<TraceSummary, "observation_count" | "total_cost" | "total_tokens" | "latency_ms"> & { tags: unknown }
    >(
      `
      SELECT
        t.id AS id,
        t.name AS name,
        DATE_FORMAT(t.\`timestamp\`, ${ISO_FMT}) AS \`timestamp\`,
        t.user_id AS user_id,
        t.session_id AS session_id,
        t.environment AS environment,
        CAST(t.tags AS JSON) AS tags
      FROM traces t
      WHERE ${conds.join(" AND ")}
      ORDER BY t.\`timestamp\` DESC
      LIMIT ?
      `,
      params,
    );
    if (rows.length === 0) return [];

    const aggs = await this.query<{
      trace_id: string;
      observation_count: unknown;
      total_cost: unknown;
      total_tokens: unknown;
      latency_ms: unknown;
    }>(
      `
      SELECT trace_id,
             COUNT(id) AS observation_count,
             SUM(total_cost) AS total_cost,
             SUM(total_tokens) AS total_tokens,
             MAX(latency_ms) AS latency_ms
      FROM observations
      WHERE project_id = ? AND trace_id IN (?)
      GROUP BY trace_id
      `,
      [projectId, rows.map((r) => r.id)],
    );
    const byTrace = new Map(aggs.map((a) => [a.trace_id, a]));
    return rows.map((r) => {
      const a = byTrace.get(r.id);
      return {
        ...r,
        tags: parseTags(r.tags),
        observation_count: Number(a?.observation_count ?? 0),
        total_cost: Number(a?.total_cost ?? 0),
        total_tokens: Number(a?.total_tokens ?? 0),
        latency_ms: Number(a?.latency_ms ?? 0),
      };
    });
  }

  async listSessions(projectId: string, limit = 50): Promise<SessionSummary[]> {
    const rows = await this.query<SessionSummary>(
      `
      SELECT
        t.session_id AS session_id,
        COUNT(t.id) AS trace_count,
        DATE_FORMAT(MIN(t.\`timestamp\`), ${ISO_FMT}) AS first_seen,
        DATE_FORMAT(MAX(t.\`timestamp\`), ${ISO_FMT}) AS last_seen,
        COALESCE(SUM(o.total_cost), 0) AS total_cost
      FROM traces t
      LEFT JOIN (
        SELECT trace_id, SUM(total_cost) AS total_cost
        FROM observations
        WHERE project_id = ?
        GROUP BY trace_id
      ) o ON o.trace_id = t.id
      WHERE t.project_id = ? AND t.session_id != ''
      GROUP BY t.session_id
      ORDER BY last_seen DESC
      LIMIT ?
      `,
      [projectId, projectId, Math.floor(limit)],
    );
    return rows.map((r) => ({ ...r, trace_count: Number(r.trace_count), total_cost: Number(r.total_cost) }));
  }

  async getTraceHeader(projectId: string, traceId: string): Promise<TraceHeader | null> {
    const rows = await this.query<TraceHeader & { tags: unknown }>(
      `
      SELECT
        id, name,
        DATE_FORMAT(\`timestamp\`, ${ISO_FMT}) AS \`timestamp\`,
        user_id, session_id, environment, \`release\`, version, CAST(tags AS JSON) AS tags,
        COALESCE(metadata, '{}') AS metadata,
        COALESCE(input, '') AS input,
        COALESCE(output, '') AS output
      FROM traces
      WHERE project_id = ? AND id = ?
      LIMIT 1
      `,
      [projectId, traceId],
    );
    const r = rows[0];
    return r ? { ...r, tags: parseTags(r.tags) } : null;
  }

  async listObservationsByTrace(projectId: string, traceId: string): Promise<ObservationDetail[]> {
    const rows = await this.query<ObservationDetail>(
      `
      SELECT
        id, trace_id, type, parent_observation_id, name,
        DATE_FORMAT(start_time, ${ISO_FMT}) AS start_time,
        IF(end_time IS NULL, NULL, DATE_FORMAT(end_time, ${ISO_FMT})) AS end_time,
        level,
        COALESCE(status_message, '') AS status_message,
        model, provider,
        prompt_tokens, completion_tokens, total_tokens, total_cost, latency_ms,
        COALESCE(input, '') AS input,
        COALESCE(output, '') AS output,
        COALESCE(metadata, '{}') AS metadata
      FROM observations
      WHERE project_id = ? AND trace_id = ?
      ORDER BY start_time ASC
      `,
      [projectId, traceId],
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
        name, source, data_type, \`value\` AS value,
        COALESCE(string_value, '') AS string_value,
        COALESCE(\`comment\`, '') AS comment,
        DATE_FORMAT(\`timestamp\`, ${ISO_FMT}) AS \`timestamp\`
      FROM scores
      WHERE project_id = ? AND trace_id = ?
      ORDER BY \`timestamp\` ASC
      `,
      [projectId, traceId],
    );
    return rows.map((r) => ({ ...r, value: r.value === null ? null : Number(r.value) }));
  }

  async getTraceIO(projectId: string, traceIds: string[]): Promise<TraceIO[]> {
    if (traceIds.length === 0) return [];
    return this.query<TraceIO>(
      `
      SELECT id, name, COALESCE(input, '') AS input, COALESCE(output, '') AS output
      FROM traces
      WHERE project_id = ? AND id IN (?)
      `,
      [projectId, traceIds],
    );
  }

  async getScoresByTraceIds(projectId: string, traceIds: string[]): Promise<TraceScore[]> {
    if (traceIds.length === 0) return [];
    const rows = await this.query<TraceScore>(
      `
      SELECT trace_id, name, \`value\` AS value, COALESCE(string_value, '') AS string_value
      FROM scores
      WHERE project_id = ? AND trace_id IN (?)
      `,
      [projectId, traceIds],
    );
    return rows.map((r) => ({ ...r, value: r.value === null ? null : Number(r.value) }));
  }

  async getScoreById(projectId: string, scoreId: string): Promise<FullScoreRow | null> {
    const rows = await this.query<FullScoreRow>(
      `
      SELECT
        id, trace_id, observation_id, name,
        DATE_FORMAT(\`timestamp\`, ${ISO_FMT}) AS \`timestamp\`,
        environment, source, data_type, \`value\` AS value,
        COALESCE(string_value, '') AS string_value,
        COALESCE(\`comment\`, '') AS comment,
        config_id
      FROM scores
      WHERE project_id = ? AND id = ?
      LIMIT 1
      `,
      [projectId, scoreId],
    );
    const r = rows[0];
    if (!r) return null;
    return { ...r, value: r.value === null ? null : Number(r.value) };
  }

  async evaluatorScoreSummary(projectId: string, days: number): Promise<EvalScoreSummaryRow[]> {
    const rows = await this.query<{ name: string; cnt: unknown; avg_value: unknown }>(
      `
      SELECT name, COUNT(*) AS cnt, AVG(\`value\`) AS avg_value
      FROM scores
      WHERE project_id = ? AND source = 'EVAL' AND \`timestamp\` >= ? AND \`value\` IS NOT NULL
      GROUP BY name
      ORDER BY cnt DESC
      `,
      [projectId, cutoffDaysAgo(days)],
    );
    return rows.map((r) => ({ name: r.name, count: Number(r.cnt), avgValue: Number(r.avg_value) }));
  }

  async evaluatorScoreTrend(projectId: string, days: number): Promise<EvalScoreTrendRow[]> {
    const rows = await this.query<{ date: string; name: string; cnt: unknown; avg_value: unknown }>(
      `
      SELECT
        DATE_FORMAT(\`timestamp\`, '%Y-%m-%d') AS date,
        name,
        COUNT(*) AS cnt,
        AVG(\`value\`) AS avg_value
      FROM scores
      WHERE project_id = ? AND source = 'EVAL' AND \`timestamp\` >= ? AND \`value\` IS NOT NULL
      GROUP BY DATE_FORMAT(\`timestamp\`, '%Y-%m-%d'), name
      ORDER BY date ASC, name ASC
      `,
      [projectId, cutoffDaysAgo(days)],
    );
    return rows.map((r) => ({ date: r.date, name: r.name, count: Number(r.cnt), avgValue: Number(r.avg_value) }));
  }

  async metricsByDay(projectId: string, days: number): Promise<DailyMetric[]> {
    const rows = await this.query<{
      date: string;
      generations: unknown;
      total_tokens: unknown;
      total_cost: unknown;
      p50: unknown;
      p95: unknown;
    }>(
      `
      SELECT
        DATE_FORMAT(start_time, '%Y-%m-%d') AS date,
        COUNT(*) AS generations,
        SUM(total_tokens) AS total_tokens,
        SUM(total_cost) AS total_cost,
        PERCENTILE_APPROX(latency_ms, 0.5) AS p50,
        PERCENTILE_APPROX(latency_ms, 0.95) AS p95
      FROM observations
      WHERE project_id = ? AND type = 'GENERATION' AND start_time >= ?
      GROUP BY DATE_FORMAT(start_time, '%Y-%m-%d')
      ORDER BY date ASC
      `,
      [projectId, cutoffMidnightDaysAgo(days)],
    );
    return rows.map((r) => ({
      date: r.date,
      generations: Number(r.generations),
      total_tokens: Number(r.total_tokens),
      total_cost: Number(r.total_cost),
      p50_latency_ms: Math.round(Number(r.p50 ?? 0)),
      p95_latency_ms: Math.round(Number(r.p95 ?? 0)),
    }));
  }

  async metricsByModel(projectId: string, days: number): Promise<ModelMetric[]> {
    const rows = await this.query<ModelMetric>(
      `
      SELECT
        model,
        COUNT(*) AS generations,
        SUM(total_tokens) AS total_tokens,
        SUM(total_cost) AS total_cost
      FROM observations
      WHERE project_id = ? AND type = 'GENERATION' AND start_time >= ?
      GROUP BY model
      ORDER BY total_cost DESC
      LIMIT 100
      `,
      [projectId, cutoffMidnightDaysAgo(days)],
    );
    return rows.map((r) => ({
      model: r.model,
      generations: Number(r.generations),
      total_tokens: Number(r.total_tokens),
      total_cost: Number(r.total_cost),
    }));
  }

  async countTracesSince(projectId: string, days: number): Promise<number> {
    const rows = await this.query<{ c: unknown }>(
      "SELECT COUNT(*) AS c FROM traces WHERE project_id = ? AND `timestamp` >= ?",
      [projectId, cutoffDaysAgo(days)],
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
      cost: "SUM(total_cost)",
      tokens: "SUM(total_tokens)",
      generations: "COUNT(*)",
      latency_p95: "PERCENTILE_APPROX(latency_ms, 0.95)",
    };
    const agg = AGG[metric] ?? AGG.cost;
    const groupExpr = breakdown === "by_model" ? "model" : "DATE_FORMAT(start_time, '%Y-%m-%d')";
    const order = breakdown === "by_model" ? "value DESC" : "label ASC";
    const rows = await this.query<{ label: string; value: unknown }>(
      `
      SELECT ${groupExpr} AS label, ${agg} AS value
      FROM observations
      WHERE project_id = ? AND type = 'GENERATION' AND start_time >= ?
      GROUP BY ${groupExpr}
      ORDER BY ${order}
      LIMIT 100
      `,
      [projectId, cutoffMidnightDaysAgo(days)],
    );
    return rows.map((r) => ({ label: r.label || "(unknown)", value: Number(r.value) }));
  }

  async exportTraces(projectId: string, filters: ExportFilters = {}): Promise<ExportTraceRow[]> {
    const { limit = 1000, environment } = filters;
    const conds = ["project_id = ?"];
    const params: unknown[] = [projectId];
    if (environment) {
      conds.push("environment = ?");
      params.push(environment);
    }
    params.push(Math.floor(limit));

    const traces = await this.query<Omit<ExportTraceRow, "observations">>(
      `
      SELECT
        id, name,
        DATE_FORMAT(\`timestamp\`, ${ISO_FMT}) AS \`timestamp\`,
        user_id, session_id, environment,
        COALESCE(input, '') AS input,
        COALESCE(output, '') AS output
      FROM traces
      WHERE ${conds.join(" AND ")}
      ORDER BY \`timestamp\` DESC
      LIMIT ?
      `,
      params,
    );
    if (traces.length === 0) return [];

    const observations = await this.query<ExportObservationRow & { trace_id: string }>(
      `
      SELECT trace_id, id, type, name, model, total_tokens, total_cost, latency_ms
      FROM observations
      WHERE project_id = ? AND trace_id IN (?)
      `,
      [projectId, traces.map((t) => t.id)],
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
    const rows = await this.query<{ c: unknown }>(
      "SELECT COUNT(*) AS c FROM traces WHERE project_id = ? AND `timestamp` < ?",
      [projectId, cutoffDaysAgo(days)],
    );
    return Number(rows[0]?.c ?? 0);
  }

  async getTraceRowsByIds(projectId: string, traceIds: string[]): Promise<TraceRow[]> {
    if (traceIds.length === 0) return [];
    const rows = await this.query<TraceRow & { tags: unknown }>(
      `
      SELECT
        project_id, id,
        DATE_FORMAT(\`timestamp\`, ${ISO_MS_FMT}) AS \`timestamp\`,
        name, user_id, session_id, \`release\`, version, environment, \`public\`,
        CAST(tags AS JSON) AS tags,
        COALESCE(metadata, '{}') AS metadata,
        COALESCE(input, '') AS input,
        COALESCE(output, '') AS output,
        DATE_FORMAT(event_ts, ${ISO_MS_FMT}) AS event_ts
      FROM traces
      WHERE project_id = ? AND id IN (?)
      `,
      [projectId, traceIds],
    );
    return rows.map((r) => ({ ...r, tags: parseTags(r.tags), public: Number(r.public) }));
  }

  async getObservationRowsByIds(projectId: string, observationIds: string[]): Promise<ObservationRow[]> {
    if (observationIds.length === 0) return [];
    const rows = await this.query<ObservationRow>(
      `
      SELECT
        project_id, trace_id, id, type, parent_observation_id, name,
        DATE_FORMAT(start_time, ${ISO_MS_FMT}) AS start_time,
        IF(end_time IS NULL, NULL, DATE_FORMAT(end_time, ${ISO_MS_FMT})) AS end_time,
        environment, level,
        COALESCE(status_message, '') AS status_message,
        model, provider,
        COALESCE(model_parameters, '{}') AS model_parameters,
        prompt_tokens, completion_tokens, total_tokens,
        input_cost, output_cost, total_cost,
        prompt_id, prompt_version,
        COALESCE(input, '') AS input,
        COALESCE(output, '') AS output,
        COALESCE(metadata, '{}') AS metadata,
        latency_ms,
        DATE_FORMAT(event_ts, ${ISO_MS_FMT}) AS event_ts
      FROM observations
      WHERE project_id = ? AND id IN (?)
      `,
      [projectId, observationIds],
    );
    return rows.map((r) => ({
      ...r,
      prompt_tokens: Number(r.prompt_tokens),
      completion_tokens: Number(r.completion_tokens),
      total_tokens: Number(r.total_tokens),
      input_cost: Number(r.input_cost),
      output_cost: Number(r.output_cost),
      total_cost: Number(r.total_cost),
      latency_ms: Number(r.latency_ms),
    }));
  }

  async countProjectRows(projectId: string): Promise<ProjectRowCounts> {
    const count = async (table: TelemetryTable) => {
      const rows = await this.query<{ c: unknown }>(`SELECT COUNT(*) AS c FROM ${table} WHERE project_id = ?`, [
        projectId,
      ]);
      return Number(rows[0]?.c ?? 0);
    };
    return { traces: await count("traces"), observations: await count("observations"), scores: await count("scores") };
  }

  // ── Writes ─────────────────────────────────────────────────────────────────────

  async insertRows<T extends TelemetryTable>(table: T, rows: TelemetryRowMap[T][]): Promise<void> {
    if (rows.length === 0) return;
    for (const stmt of buildInserts(table, rows)) {
      await this.exec(stmt.sql, stmt.params);
    }
  }

  async deleteScore(projectId: string, scoreId: string): Promise<void> {
    await this.exec("DELETE FROM scores WHERE project_id = ? AND id = ?", [projectId, scoreId]);
  }

  async deleteTraces(projectId: string, traceIds: string[]): Promise<void> {
    if (traceIds.length === 0) return;
    await this.exec("DELETE FROM traces WHERE project_id = ? AND id IN (?)", [projectId, traceIds]);
    await this.exec("DELETE FROM observations WHERE project_id = ? AND trace_id IN (?)", [projectId, traceIds]);
    await this.exec("DELETE FROM scores WHERE project_id = ? AND trace_id IN (?)", [projectId, traceIds]);
  }

  async deleteOlderThan(projectId: string, days: number): Promise<void> {
    const cutoff = cutoffDaysAgo(days);
    await this.exec("DELETE FROM traces WHERE project_id = ? AND `timestamp` < ?", [projectId, cutoff]);
    await this.exec("DELETE FROM observations WHERE project_id = ? AND start_time < ?", [projectId, cutoff]);
    await this.exec("DELETE FROM scores WHERE project_id = ? AND `timestamp` < ?", [projectId, cutoff]);
  }

  async deleteProjectData(projectId: string): Promise<void> {
    await this.exec("DELETE FROM traces WHERE project_id = ?", [projectId]);
    await this.exec("DELETE FROM observations WHERE project_id = ?", [projectId]);
    await this.exec("DELETE FROM scores WHERE project_id = ?", [projectId]);
  }

  // ── Ops ────────────────────────────────────────────────────────────────────────

  async ping(): Promise<boolean> {
    try {
      await this.query("SELECT 1");
      return true;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    await closeDorisPool();
  }
}
