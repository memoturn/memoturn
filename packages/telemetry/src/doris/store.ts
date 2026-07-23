import type {
  AnalyticsQuery,
  CostRollupRow,
  DailyMetric,
  EmbeddingPoint,
  ModelMetric,
  ObservationDetail,
  PromptArmScore,
  PromptVersionCost,
  QueryResult,
  ScoreRow as ScoreDetail,
  SessionSummary,
  SingleFilter,
  ToolAnalyticsRow,
  TraceFacets,
  TraceHistogramBucket,
  TraceSummary,
  UserSummary,
  WidgetBreakdown,
  WidgetFilters,
  WidgetMetric,
  WidgetPoint,
} from "@memoturn/contracts";
import { keysetAfter } from "../serialize-shared.js";
import type { TelemetryStore } from "../store.js";
import type {
  EmbeddingProjectionRow,
  EmbeddingRow,
  EmbeddingVectorRow,
  EvalScoreSummaryRow,
  EvalScoreTrendRow,
  ExportFilters,
  ExportObservationRow,
  ExportTraceRow,
  FullScoreRow,
  ObservationRow,
  ProjectRowCounts,
  RetrievalDocumentDetail,
  RetrievalDocumentRow,
  ScanCursor,
  ScanPage,
  ScoreWriteRow,
  TelemetryRowMap,
  TelemetryTable,
  TraceEmbeddingRow,
  TraceFilters,
  TraceHeader,
  TraceIO,
  TraceRow,
  TraceScore,
  WindowMetric,
} from "../types.js";
import { TELEMETRY_PRIMARY_KEYS } from "../types.js";
import { closeDorisPool, dorisQuery } from "./client.js";
import { buildTraceFilterSql } from "./filters.js";
import { compileQuery, validateQuery } from "./query.js";
import { buildInserts, parseTags, parseVector, toDorisDateTime } from "./serialize.js";
import { streamLoad, streamLoadEnabled } from "./streamload.js";

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

/** ISO timestamp for "now minus N minutes" as a Doris DATETIME literal (short-window metrics). */
function cutoffMinutesAgo(minutes: number): string {
  return toDorisDateTime(new Date(Date.now() - Math.floor(minutes) * 60_000).toISOString());
}

/** Zeroed window metric — the default for a project with no rows in the window. */
function zeroWindow(): WindowMetric {
  return {
    generations: 0,
    errors: 0,
    total_tokens: 0,
    total_cost: 0,
    p50_latency_ms: 0,
    p95_latency_ms: 0,
    trace_count: 0,
  };
}

export class DorisTelemetryStore implements TelemetryStore {
  private async query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    const [rows] = await dorisQuery(sql, params);
    return rows as T[];
  }

  private async exec(sql: string, params: unknown[] = []): Promise<void> {
    await dorisQuery(sql, params);
  }

  // ── Reads ──────────────────────────────────────────────────────────────────────

  /** Shared filter predicate for listTraces + countTraces (alias `t`), sans limit/offset. */
  private traceListWhere(projectId: string, filters: TraceFilters): { where: string; params: unknown[] } {
    const { userId, sessionId, environment, search, tag, promptId, scoreName, level, type, days, traceIds } = filters;
    const conds: string[] = ["t.project_id = ?"];
    const params: unknown[] = [projectId];
    if (traceIds && traceIds.length > 0) {
      // Restrict to an explicit id set (mysql2 expands a single `?` bound to an array).
      conds.push("t.id IN (?)");
      params.push(traceIds);
    }
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
      // Match the trace name OR any observation's input/output content (inline payloads only —
      // payloads offloaded to blob at ingest aren't searchable here).
      conds.push(
        `(LOWER(t.name) LIKE CONCAT('%', LOWER(?), '%')
          OR t.id IN (
            SELECT trace_id FROM observations
            WHERE project_id = ?
              AND (LOWER(input) LIKE CONCAT('%', LOWER(?), '%') OR LOWER(output) LIKE CONCAT('%', LOWER(?), '%'))
          ))`,
      );
      params.push(search, projectId, search, search);
    }
    if (tag) {
      conds.push("array_contains(t.tags, ?)");
      params.push(tag);
    }
    if (promptId) {
      // Trace has at least one observation (generation) that used this prompt.
      conds.push("t.id IN (SELECT trace_id FROM observations WHERE project_id = ? AND prompt_id = ?)");
      params.push(projectId, promptId);
    }
    if (scoreName) {
      // Trace has at least one score with this name (eval/annotation/api).
      conds.push("t.id IN (SELECT trace_id FROM scores WHERE project_id = ? AND name = ?)");
      params.push(projectId, scoreName);
    }
    if (level) {
      // Trace has at least one observation at this level (e.g. ERROR / WARNING).
      conds.push("t.id IN (SELECT trace_id FROM observations WHERE project_id = ? AND level = ?)");
      params.push(projectId, level);
    }
    if (type) {
      // Trace has at least one observation of this type (SPAN/GENERATION/TOOL/AGENT/EVENT).
      conds.push("t.id IN (SELECT trace_id FROM observations WHERE project_id = ? AND type = ?)");
      params.push(projectId, type);
    }
    if (days && days > 0) {
      conds.push("t.`timestamp` >= ?");
      params.push(cutoffDaysAgo(days));
    }
    // Structured operator-based filters (the power-path builder) compile to additional
    // AND-ed predicates; the faceted filters above remain the quick path.
    if (filters.filters && filters.filters.length > 0) {
      const compiled = buildTraceFilterSql(projectId, filters.filters);
      conds.push(...compiled.conds);
      params.push(...compiled.params);
    }
    return { where: conds.join(" AND "), params };
  }

  async countTraces(projectId: string, filters: TraceFilters = {}): Promise<number> {
    const { where, params } = this.traceListWhere(projectId, filters);
    const [row] = await this.query<{ c: unknown }>(`SELECT COUNT(*) AS c FROM traces t WHERE ${where}`, params);
    return Number(row?.c ?? 0);
  }

  async traceHistogram(
    projectId: string,
    filters: TraceFilters = {},
    interval: "hour" | "day" = "day",
  ): Promise<TraceHistogramBucket[]> {
    // Bucket format is chosen from a fixed set (never user input) so it's safe to inline.
    const fmt = interval === "hour" ? "%Y-%m-%dT%H:00" : "%Y-%m-%d";
    const { where, params } = this.traceListWhere(projectId, filters);
    const rows = await this.query<{ bucket: string; c: unknown }>(
      `
      SELECT DATE_FORMAT(t.\`timestamp\`, '${fmt}') AS bucket, COUNT(*) AS c
      FROM traces t
      WHERE ${where}
      GROUP BY bucket
      ORDER BY bucket ASC
      `,
      params,
    );
    return rows.map((r) => ({ bucket: r.bucket, count: Number(r.c) }));
  }

  async listTraces(projectId: string, filters: TraceFilters = {}): Promise<TraceSummary[]> {
    const { limit = 50, offset = 0 } = filters;
    const { where, params } = this.traceListWhere(projectId, filters);
    params.push(Math.floor(limit), Math.max(0, Math.floor(offset)));

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
      WHERE ${where}
      ORDER BY t.\`timestamp\` DESC, t.id DESC
      LIMIT ? OFFSET ?
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

  async traceFacets(
    projectId: string,
    opts: {
      days?: number;
      limit?: number;
      environment?: string;
      search?: string;
      userId?: string;
      tag?: string;
      scoreName?: string;
      level?: string;
      type?: string;
      filters?: SingleFilter[];
    } = {},
  ): Promise<TraceFacets> {
    const { days = 0, limit = 25, environment, search, userId, tag, scoreName, level, type, filters } = opts;
    const cap = Math.floor(limit);

    // The structured power-path filter set narrows every facet identically — it is not a facet
    // dimension, so no facet-excluding treatment. Compiled once, applied as an id-subquery so it
    // composes with the unaliased facet queries (and the LATERAL VIEW tags variant) unchanged.
    const structured: { cond: string; params: unknown[] } | null = (() => {
      if (!filters || filters.length === 0) return null;
      const compiled = buildTraceFilterSql(projectId, filters);
      if (compiled.conds.length === 0) return null;
      return {
        cond: `id IN (SELECT t.id FROM traces t WHERE t.project_id = ? AND ${compiled.conds.join(" AND ")})`,
        params: [projectId, ...compiled.params],
      };
    })();

    // Compose a WHERE from a chosen subset of the active filters. Each facet omits its own
    // dimension (facet-excluding counts) so a selected value still shows its alternatives.
    const build = (include: {
      env?: boolean;
      name?: boolean;
      user?: boolean;
      tag?: boolean;
      score?: boolean;
      level?: boolean;
      type?: boolean;
    }) => {
      const conds = ["project_id = ?"];
      const params: unknown[] = [projectId];
      if (days > 0) {
        conds.push("`timestamp` >= ?");
        params.push(cutoffDaysAgo(days));
      }
      if (include.env && environment) {
        conds.push("environment = ?");
        params.push(environment);
      }
      if (include.name && search) {
        conds.push(
          `(LOWER(name) LIKE CONCAT('%', LOWER(?), '%')
            OR id IN (
              SELECT trace_id FROM observations
              WHERE project_id = ?
                AND (LOWER(input) LIKE CONCAT('%', LOWER(?), '%') OR LOWER(output) LIKE CONCAT('%', LOWER(?), '%'))
            ))`,
        );
        params.push(search, projectId, search, search);
      }
      if (include.user && userId) {
        conds.push("user_id = ?");
        params.push(userId);
      }
      if (include.tag && tag) {
        conds.push("array_contains(tags, ?)");
        params.push(tag);
      }
      if (include.score && scoreName) {
        conds.push("id IN (SELECT trace_id FROM scores WHERE project_id = ? AND name = ?)");
        params.push(projectId, scoreName);
      }
      if (include.level && level) {
        conds.push("id IN (SELECT trace_id FROM observations WHERE project_id = ? AND level = ?)");
        params.push(projectId, level);
      }
      if (include.type && type) {
        conds.push("id IN (SELECT trace_id FROM observations WHERE project_id = ? AND type = ?)");
        params.push(projectId, type);
      }
      if (structured) {
        conds.push(structured.cond);
        params.push(...structured.params);
      }
      return { where: conds.join(" AND "), params };
    };

    // One {value, count} list per facet, ordered by frequency. Tags is an ARRAY<STRING>
    // column, so it's unnested with LATERAL VIEW explode before grouping (empty/NULL
    // tag arrays simply contribute no rows).
    const facet = (sql: string, params: unknown[]) =>
      this.query<{ value: string; count: unknown }>(sql, params).then((rows) =>
        rows.filter((r) => r.value != null && r.value !== "").map((r) => ({ value: r.value, count: Number(r.count) })),
      );

    const envW = build({ name: true, user: true, tag: true, score: true, level: true, type: true });
    const nameW = build({ env: true, user: true, tag: true, score: true, level: true, type: true });
    const tagW = build({ env: true, name: true, user: true, score: true, level: true, type: true });
    // Scores + levels + types facets each join their source table to the filtered trace set and
    // exclude their own dimension, so a selected value still shows its alternatives.
    const scoreW = build({ env: true, name: true, user: true, tag: true, level: true, type: true });
    const levelW = build({ env: true, name: true, user: true, tag: true, score: true, type: true });
    const typeW = build({ env: true, name: true, user: true, tag: true, score: true, level: true });

    const [environments, names, tags, scores, levels, types] = await Promise.all([
      facet(
        `SELECT environment AS value, COUNT(*) AS count FROM traces
         WHERE ${envW.where} GROUP BY environment ORDER BY count DESC LIMIT ?`,
        [...envW.params, cap],
      ),
      facet(
        `SELECT name AS value, COUNT(*) AS count FROM traces
         WHERE ${nameW.where} GROUP BY name ORDER BY count DESC LIMIT ?`,
        [...nameW.params, cap],
      ),
      facet(
        `SELECT tag AS value, COUNT(*) AS count FROM traces
         LATERAL VIEW explode(tags) tv AS tag
         WHERE ${tagW.where} GROUP BY tag ORDER BY count DESC LIMIT ?`,
        [...tagW.params, cap],
      ),
      facet(
        `SELECT s.name AS value, COUNT(DISTINCT s.trace_id) AS count
         FROM scores s
         WHERE s.project_id = ? AND s.trace_id IN (SELECT id FROM traces WHERE ${scoreW.where})
         GROUP BY s.name ORDER BY count DESC LIMIT ?`,
        [projectId, ...scoreW.params, cap],
      ),
      facet(
        `SELECT o.level AS value, COUNT(DISTINCT o.trace_id) AS count
         FROM observations o
         WHERE o.project_id = ? AND o.trace_id IN (SELECT id FROM traces WHERE ${levelW.where})
         GROUP BY o.level ORDER BY count DESC LIMIT ?`,
        [projectId, ...levelW.params, cap],
      ),
      facet(
        `SELECT o.type AS value, COUNT(DISTINCT o.trace_id) AS count
         FROM observations o
         WHERE o.project_id = ? AND o.trace_id IN (SELECT id FROM traces WHERE ${typeW.where})
         GROUP BY o.type ORDER BY count DESC LIMIT ?`,
        [projectId, ...typeW.params, cap],
      ),
    ]);

    return { environments, names, tags, scores, levels, types };
  }

  async listSessions(
    projectId: string,
    opts: { limit?: number; offset?: number; days?: number; search?: string } = {},
  ): Promise<SessionSummary[]> {
    const { limit = 50, offset = 0, days = 0, search = "" } = opts;
    const dayCond = days > 0 ? "AND t.`timestamp` >= ?" : "";
    const dayParam = days > 0 ? [cutoffDaysAgo(days)] : [];
    const searchCond = search ? "AND t.session_id LIKE ?" : "";
    const searchParam = search ? [`%${search}%`] : [];
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
      WHERE t.project_id = ? AND t.session_id != '' ${dayCond} ${searchCond}
      GROUP BY t.session_id
      ORDER BY last_seen DESC, t.session_id DESC
      LIMIT ? OFFSET ?
      `,
      [projectId, projectId, ...dayParam, ...searchParam, Math.floor(limit), Math.max(0, Math.floor(offset))],
    );
    return rows.map((r) => ({ ...r, trace_count: Number(r.trace_count), total_cost: Number(r.total_cost) }));
  }

  async countSessions(projectId: string, days = 0, search = ""): Promise<number> {
    const dayCond = days > 0 ? "AND `timestamp` >= ?" : "";
    const searchCond = search ? "AND session_id LIKE ?" : "";
    const params = [projectId, ...(days > 0 ? [cutoffDaysAgo(days)] : []), ...(search ? [`%${search}%`] : [])];
    const [row] = await this.query<{ c: unknown }>(
      `SELECT COUNT(DISTINCT session_id) AS c FROM traces WHERE project_id = ? AND session_id != '' ${dayCond} ${searchCond}`,
      params,
    );
    return Number(row?.c ?? 0);
  }

  async listUsers(
    projectId: string,
    opts: { limit?: number; offset?: number; days?: number; search?: string } = {},
  ): Promise<UserSummary[]> {
    const { limit = 50, offset = 0, days = 0, search = "" } = opts;
    const dayCond = days > 0 ? "AND t.`timestamp` >= ?" : "";
    const dayParam = days > 0 ? [cutoffDaysAgo(days)] : [];
    const searchCond = search ? "AND t.user_id LIKE ?" : "";
    const searchParam = search ? [`%${search}%`] : [];
    const rows = await this.query<UserSummary>(
      `
      SELECT
        t.user_id AS user_id,
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
      WHERE t.project_id = ? AND t.user_id != '' ${dayCond} ${searchCond}
      GROUP BY t.user_id
      ORDER BY last_seen DESC, t.user_id DESC
      LIMIT ? OFFSET ?
      `,
      [projectId, projectId, ...dayParam, ...searchParam, Math.floor(limit), Math.max(0, Math.floor(offset))],
    );
    return rows.map((r) => ({ ...r, trace_count: Number(r.trace_count), total_cost: Number(r.total_cost) }));
  }

  async countUsers(projectId: string, days = 0, search = ""): Promise<number> {
    const dayCond = days > 0 ? "AND `timestamp` >= ?" : "";
    const searchCond = search ? "AND user_id LIKE ?" : "";
    const params = [projectId, ...(days > 0 ? [cutoffDaysAgo(days)] : []), ...(search ? [`%${search}%`] : [])];
    const [row] = await this.query<{ c: unknown }>(
      `SELECT COUNT(DISTINCT user_id) AS c FROM traces WHERE project_id = ? AND user_id != '' ${dayCond} ${searchCond}`,
      params,
    );
    return Number(row?.c ?? 0);
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
        COALESCE(prompt_id, '') AS prompt_id, COALESCE(prompt_version, '') AS prompt_version,
        prompt_tokens, completion_tokens, total_tokens,
        cache_read_tokens, cache_creation_tokens, total_cost, latency_ms,
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
      cache_read_tokens: Number(r.cache_read_tokens),
      cache_creation_tokens: Number(r.cache_creation_tokens),
      total_cost: Number(r.total_cost),
      latency_ms: Number(r.latency_ms),
      // Enriched by packages/server getTrace (kept empty at the store boundary).
      retrieval_documents: [],
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
      errors: unknown;
      total_tokens: unknown;
      total_cost: unknown;
      p50: unknown;
      p95: unknown;
    }>(
      `
      SELECT
        DATE_FORMAT(start_time, '%Y-%m-%d') AS date,
        COUNT(*) AS generations,
        SUM(IF(level = 'ERROR', 1, 0)) AS errors,
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
      errors: Number(r.errors ?? 0),
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

  costByUser(projectId: string, opts: { days?: number; limit?: number } = {}): Promise<CostRollupRow[]> {
    return this.costRollup(projectId, "user_id", opts);
  }

  costBySession(projectId: string, opts: { days?: number; limit?: number } = {}): Promise<CostRollupRow[]> {
    return this.costRollup(projectId, "session_id", opts);
  }

  /** Shared cost rollup: sum observation cost/tokens onto traces, group by a trace key column. */
  private async costRollup(
    projectId: string,
    keyCol: "user_id" | "session_id",
    opts: { days?: number; limit?: number },
  ): Promise<CostRollupRow[]> {
    const { days = 0, limit = 20 } = opts;
    // keyCol is a fixed allowlist (not user input), so it's safe to interpolate.
    const dayCond = days > 0 ? "AND t.`timestamp` >= ?" : "";
    const dayParam = days > 0 ? [cutoffDaysAgo(days)] : [];
    const rows = await this.query<CostRollupRow>(
      `
      SELECT
        t.${keyCol} AS \`key\`,
        COUNT(t.id) AS trace_count,
        COALESCE(SUM(o.total_cost), 0) AS total_cost,
        COALESCE(SUM(o.total_tokens), 0) AS total_tokens
      FROM traces t
      LEFT JOIN (
        SELECT trace_id, SUM(total_cost) AS total_cost, SUM(total_tokens) AS total_tokens
        FROM observations
        WHERE project_id = ?
        GROUP BY trace_id
      ) o ON o.trace_id = t.id
      WHERE t.project_id = ? AND t.${keyCol} != '' ${dayCond}
      GROUP BY t.${keyCol}
      ORDER BY total_cost DESC
      LIMIT ?
      `,
      [projectId, projectId, ...dayParam, Math.max(1, Math.floor(limit))],
    );
    return rows.map((r) => ({
      key: r.key,
      trace_count: Number(r.trace_count),
      total_cost: Number(r.total_cost),
      total_tokens: Number(r.total_tokens),
    }));
  }

  async costByPrompt(projectId: string, opts: { days?: number; limit?: number } = {}): Promise<CostRollupRow[]> {
    const { days = 0, limit = 20 } = opts;
    // Project-wide rollup on observations.prompt_id (the prompt NAME — see
    // costByPromptVersion below); no traces join needed, the cost lives on the rows.
    const dayCond = days > 0 ? "AND start_time >= ?" : "";
    const dayParam = days > 0 ? [cutoffDaysAgo(days)] : [];
    const rows = await this.query<CostRollupRow>(
      `
      SELECT
        prompt_id AS \`key\`,
        COUNT(DISTINCT trace_id) AS trace_count,
        COALESCE(SUM(total_cost), 0) AS total_cost,
        COALESCE(SUM(total_tokens), 0) AS total_tokens
      FROM observations
      WHERE project_id = ? AND prompt_id != '' ${dayCond}
      GROUP BY prompt_id
      ORDER BY total_cost DESC
      LIMIT ?
      `,
      [projectId, ...dayParam, Math.max(1, Math.floor(limit))],
    );
    return rows.map((r) => ({
      key: r.key,
      trace_count: Number(r.trace_count),
      total_cost: Number(r.total_cost),
      total_tokens: Number(r.total_tokens),
    }));
  }

  async costByPromptVersion(
    projectId: string,
    promptName: string,
    opts: { days?: number } = {},
  ): Promise<PromptVersionCost[]> {
    const { days = 0 } = opts;
    // Observations carry the prompt NAME in prompt_id (that's what the SDK sends and what the
    // console filters by) plus a prompt_version string. Group one prompt's usage by version.
    const dayCond = days > 0 ? "AND start_time >= ?" : "";
    const dayParam = days > 0 ? [cutoffDaysAgo(days)] : [];
    const rows = await this.query<PromptVersionCost>(
      `
      SELECT
        prompt_version,
        COUNT(id) AS observation_count,
        COALESCE(SUM(total_cost), 0) AS total_cost,
        COALESCE(SUM(total_tokens), 0) AS total_tokens
      FROM observations
      WHERE project_id = ? AND prompt_id = ? ${dayCond}
      GROUP BY prompt_version
      ORDER BY total_cost DESC
      `,
      [projectId, promptName, ...dayParam],
    );
    return rows.map((r) => ({
      prompt_version: r.prompt_version,
      observation_count: Number(r.observation_count),
      total_cost: Number(r.total_cost),
      total_tokens: Number(r.total_tokens),
    }));
  }

  async scoresByPromptVersion(
    projectId: string,
    promptName: string,
    opts: { days?: number } = {},
  ): Promise<PromptArmScore[]> {
    const { days = 0 } = opts;
    // Attribute each score to the prompt version used in its trace: join scores → the DISTINCT
    // (trace_id, prompt_version) of observations that used this prompt. Only numeric scores.
    const dayCond = days > 0 ? "AND s.timestamp >= ?" : "";
    const dayParam = days > 0 ? [cutoffDaysAgo(days)] : [];
    const rows = await this.query<PromptArmScore>(
      `
      SELECT arm.prompt_version, s.name AS score_name, COUNT(s.id) AS score_count, AVG(s.value) AS avg_value
      FROM scores s
      JOIN (
        SELECT DISTINCT trace_id, prompt_version
        FROM observations
        WHERE project_id = ? AND prompt_id = ?
      ) arm ON arm.trace_id = s.trace_id
      WHERE s.project_id = ? AND s.value IS NOT NULL ${dayCond}
      GROUP BY arm.prompt_version, s.name
      ORDER BY arm.prompt_version DESC, s.name ASC
      `,
      [projectId, promptName, projectId, ...dayParam],
    );
    return rows.map((r) => ({
      prompt_version: r.prompt_version,
      score_name: r.score_name,
      score_count: Number(r.score_count),
      avg_value: Number(r.avg_value),
    }));
  }

  async countTracesSince(projectId: string, days: number): Promise<number> {
    const rows = await this.query<{ c: unknown }>(
      "SELECT COUNT(*) AS c FROM traces WHERE project_id = ? AND `timestamp` >= ?",
      [projectId, cutoffDaysAgo(days)],
    );
    return Number(rows[0]?.c ?? 0);
  }

  async toolAnalytics(projectId: string, days: number): Promise<ToolAnalyticsRow[]> {
    // Tool calls are SPAN observations named after the tool (LangChain callbacks, OTel
    // execute_tool spans). Group by name for the "which tool/step is slow or failing" view.
    const rows = await this.query<{
      tool: string;
      calls: unknown;
      errors: unknown;
      p50: unknown;
      p95: unknown;
      avg_latency: unknown;
    }>(
      `
      SELECT
        name AS tool,
        COUNT(*) AS calls,
        SUM(IF(level = 'ERROR', 1, 0)) AS errors,
        PERCENTILE_APPROX(latency_ms, 0.5) AS p50,
        PERCENTILE_APPROX(latency_ms, 0.95) AS p95,
        AVG(latency_ms) AS avg_latency
      FROM observations
      WHERE project_id = ? AND type = 'SPAN' AND name != '' AND start_time >= ?
      GROUP BY name
      ORDER BY calls DESC
      LIMIT 200
      `,
      [projectId, cutoffMidnightDaysAgo(days)],
    );
    return rows.map((r) => {
      const calls = Number(r.calls);
      const errors = Number(r.errors ?? 0);
      return {
        tool: r.tool,
        calls,
        errors,
        error_rate: calls > 0 ? errors / calls : 0,
        p50_latency_ms: Math.round(Number(r.p50 ?? 0)),
        p95_latency_ms: Math.round(Number(r.p95 ?? 0)),
        avg_latency_ms: Math.round(Number(r.avg_latency ?? 0)),
      };
    });
  }

  async metricsWindow(projectId: string, sinceMinutes: number): Promise<WindowMetric> {
    return (await this.metricsWindowByProjects([projectId], sinceMinutes)).get(projectId) ?? zeroWindow();
  }

  async metricsWindowByProjects(projectIds: string[], sinceMinutes: number): Promise<Map<string, WindowMetric>> {
    const out = new Map<string, WindowMetric>();
    if (projectIds.length === 0) return out;
    const since = cutoffMinutesAgo(sinceMinutes);
    const placeholders = projectIds.map(() => "?").join(", ");
    // Two grouped scans across all requested projects at once: GENERATION aggregates from
    // observations, trace volume from traces. GROUP BY project_id so one query serves N
    // projects (the alert cron batches every rule sharing a window into one round-trip).
    const [gens, traces] = await Promise.all([
      this.query<{
        project_id: string;
        generations: unknown;
        errors: unknown;
        total_tokens: unknown;
        total_cost: unknown;
        p50: unknown;
        p95: unknown;
      }>(
        `
        SELECT
          project_id,
          COUNT(*) AS generations,
          SUM(IF(level = 'ERROR', 1, 0)) AS errors,
          SUM(total_tokens) AS total_tokens,
          SUM(total_cost) AS total_cost,
          PERCENTILE_APPROX(latency_ms, 0.5) AS p50,
          PERCENTILE_APPROX(latency_ms, 0.95) AS p95
        FROM observations
        WHERE project_id IN (${placeholders}) AND type = 'GENERATION' AND start_time >= ?
        GROUP BY project_id
        `,
        [...projectIds, since],
      ),
      this.query<{ project_id: string; c: unknown }>(
        `SELECT project_id, COUNT(*) AS c FROM traces WHERE project_id IN (${placeholders}) AND \`timestamp\` >= ? GROUP BY project_id`,
        [...projectIds, since],
      ),
    ]);
    const traceCounts = new Map(traces.map((t) => [t.project_id, Number(t.c ?? 0)]));
    // Seed zeros so every requested project is present even with no matching generations.
    for (const id of projectIds) out.set(id, { ...zeroWindow(), trace_count: traceCounts.get(id) ?? 0 });
    for (const g of gens) {
      out.set(g.project_id, {
        generations: Number(g.generations ?? 0),
        errors: Number(g.errors ?? 0),
        total_tokens: Number(g.total_tokens ?? 0),
        total_cost: Number(g.total_cost ?? 0),
        p50_latency_ms: Math.round(Number(g.p50 ?? 0)),
        p95_latency_ms: Math.round(Number(g.p95 ?? 0)),
        trace_count: traceCounts.get(g.project_id) ?? 0,
      });
    }
    return out;
  }

  async metricWindowSeries(projectId: string, windowMinutes: number, buckets: number): Promise<WindowMetric[]> {
    const win = Math.max(1, Math.floor(windowMinutes));
    const n = Math.max(1, Math.floor(buckets));
    const winSec = win * 60;
    // Anchor n windows back; bucket index = FLOOR(seconds since anchor / window) → 0 (oldest) .. n-1.
    const anchor = toDorisDateTime(new Date(Date.now() - n * win * 60_000).toISOString());
    const obsBucket = "FLOOR(TIMESTAMPDIFF(SECOND, ?, start_time) / ?)";
    const traceBucket = "FLOOR(TIMESTAMPDIFF(SECOND, ?, `timestamp`) / ?)";
    const [gens, traces] = await Promise.all([
      this.query<{
        b: unknown;
        generations: unknown;
        errors: unknown;
        total_tokens: unknown;
        total_cost: unknown;
        p50: unknown;
        p95: unknown;
      }>(
        `
        SELECT ${obsBucket} AS b,
          COUNT(*) AS generations,
          SUM(IF(level = 'ERROR', 1, 0)) AS errors,
          SUM(total_tokens) AS total_tokens,
          SUM(total_cost) AS total_cost,
          PERCENTILE_APPROX(latency_ms, 0.5) AS p50,
          PERCENTILE_APPROX(latency_ms, 0.95) AS p95
        FROM observations
        WHERE project_id = ? AND type = 'GENERATION' AND start_time >= ?
        GROUP BY b
        `,
        [anchor, winSec, projectId, anchor],
      ),
      this.query<{ b: unknown; c: unknown }>(
        `SELECT ${traceBucket} AS b, COUNT(*) AS c FROM traces WHERE project_id = ? AND \`timestamp\` >= ? GROUP BY b`,
        [anchor, winSec, projectId, anchor],
      ),
    ]);
    const clamp = (b: unknown) => Math.min(n - 1, Math.max(0, Math.floor(Number(b ?? 0))));
    const series: WindowMetric[] = Array.from({ length: n }, () => zeroWindow());
    for (const t of traces) series[clamp(t.b)]!.trace_count += Number(t.c ?? 0);
    for (const g of gens) {
      const w = series[clamp(g.b)]!;
      w.generations += Number(g.generations ?? 0);
      w.errors += Number(g.errors ?? 0);
      w.total_tokens += Number(g.total_tokens ?? 0);
      w.total_cost += Number(g.total_cost ?? 0);
      w.p50_latency_ms = Math.round(Number(g.p50 ?? 0));
      w.p95_latency_ms = Math.round(Number(g.p95 ?? 0));
    }
    return series; // oldest → newest; the last element is the current window
  }

  async widgetSeries(
    projectId: string,
    metric: WidgetMetric,
    breakdown: WidgetBreakdown,
    days: number,
    filters: WidgetFilters = {},
  ): Promise<WidgetPoint[]> {
    // All interpolated fragments (group column, aggregate) come from fixed allowlists, never
    // raw input; every value is bound with `?`. A traces JOIN makes environment/tag filters and
    // user/session breakdowns available (those columns live on `traces`, not `observations`).
    const cutoff = cutoffMidnightDaysAgo(days);
    // Trace-scoped filter conditions shared by both query shapes (env, tag).
    const traceConds: string[] = [];
    const traceParams: unknown[] = [];
    if (filters.environment) {
      traceConds.push("t.environment = ?");
      traceParams.push(filters.environment);
    }
    if (filters.tag) {
      traceConds.push("array_contains(t.tags, ?)");
      traceParams.push(filters.tag);
    }

    if (metric === "score") {
      // Score = average score value; scores live in their own table joined to traces.
      const GROUP: Partial<Record<WidgetBreakdown, string>> = {
        by_day: "DATE_FORMAT(s.`timestamp`, '%Y-%m-%d')",
        by_user: "t.user_id",
        by_session: "t.session_id",
      };
      const groupExpr = GROUP[breakdown] ?? GROUP.by_day!; // scores aren't model-scoped → by_day
      const order = groupExpr.startsWith("DATE_FORMAT") ? "label ASC" : "value DESC";
      const rows = await this.query<{ label: string; value: unknown }>(
        `
        SELECT ${groupExpr} AS label, AVG(s.\`value\`) AS value
        FROM scores s
        JOIN traces t ON t.id = s.trace_id AND t.project_id = s.project_id
        WHERE s.project_id = ? AND s.\`timestamp\` >= ? AND s.\`value\` IS NOT NULL ${traceConds.map((c) => `AND ${c}`).join(" ")}
        GROUP BY ${groupExpr}
        ORDER BY ${order}
        LIMIT 100
        `,
        [projectId, cutoff, ...traceParams],
      );
      return rows.map((r) => ({ label: r.label || "(unknown)", value: Number(r.value) }));
    }

    const AGG: Record<Exclude<WidgetMetric, "score">, string> = {
      cost: "SUM(o.total_cost)",
      tokens: "SUM(o.total_tokens)",
      generations: "COUNT(*)",
      latency_p95: "PERCENTILE_APPROX(o.latency_ms, 0.95)",
      error_rate: "SUM(IF(o.level = 'ERROR', 1, 0)) / COUNT(*)",
    };
    const GROUP: Record<WidgetBreakdown, string> = {
      by_day: "DATE_FORMAT(o.start_time, '%Y-%m-%d')",
      by_model: "o.model",
      by_user: "t.user_id",
      by_session: "t.session_id",
    };
    const agg = AGG[metric] ?? AGG.cost;
    const groupExpr = GROUP[breakdown] ?? GROUP.by_day;
    const order = breakdown === "by_day" ? "label ASC" : "value DESC";
    const conds = [...traceConds];
    const params: unknown[] = [...traceParams];
    if (filters.model) {
      conds.push("o.model = ?");
      params.push(filters.model);
    }
    const rows = await this.query<{ label: string; value: unknown }>(
      `
      SELECT ${groupExpr} AS label, ${agg} AS value
      FROM observations o
      JOIN traces t ON t.id = o.trace_id AND t.project_id = o.project_id
      WHERE o.project_id = ? AND o.type = 'GENERATION' AND o.start_time >= ? ${conds.map((c) => `AND ${c}`).join(" ")}
      GROUP BY ${groupExpr}
      ORDER BY ${order}
      LIMIT 100
      `,
      [projectId, cutoff, ...params],
    );
    return rows.map((r) => ({ label: r.label || "(unknown)", value: Number(r.value) }));
  }

  async runAnalyticsQuery(projectId: string, query: AnalyticsQuery): Promise<QueryResult> {
    const valid = validateQuery(query);
    if (!valid.ok) throw new Error(`invalid analytics query: ${valid.error}`);
    const { sql, params } = compileQuery(projectId, query);
    const rows = await this.query<Record<string, unknown>>(sql, params);
    // Metric columns (`${agg}_${measure}`) come back as strings from mysql2 — coerce to numbers at
    // the store boundary; dimension/time columns stay strings.
    const metricCols = new Set(query.metrics.map((m) => `${m.aggregation}_${m.measure}`));
    return {
      rows: rows.map((r) => {
        const out: Record<string, string | number | null> = {};
        for (const [k, v] of Object.entries(r)) {
          out[k] = metricCols.has(k) ? (v == null ? null : Number(v)) : v == null ? null : String(v);
        }
        return out;
      }),
    };
  }

  async exportTraces(projectId: string, filters: ExportFilters = {}): Promise<ExportTraceRow[]> {
    const { limit = 1000 } = filters;
    // Defensive ceiling: the API clamps the limit, but bound it here too so any caller (the
    // whole result set is materialized in memory) can't request an unbounded scan.
    const boundedLimit = Math.min(Math.max(1, Math.floor(Number(limit) || 1000)), 100_000);
    // Reuse the trace-list WHERE so exports honor the same filters as the console list
    // (environment, search, tag, score, level, user, …).
    const { where, params: whereParams } = this.traceListWhere(projectId, filters);
    const params = [...whereParams, boundedLimit];

    const traces = await this.query<Omit<ExportTraceRow, "observations">>(
      `
      SELECT
        t.id, t.name,
        DATE_FORMAT(t.\`timestamp\`, ${ISO_FMT}) AS \`timestamp\`,
        t.user_id, t.session_id, t.environment,
        COALESCE(t.input, '') AS input,
        COALESCE(t.output, '') AS output
      FROM traces t
      WHERE ${where}
      ORDER BY t.\`timestamp\` DESC
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
        cache_read_tokens, cache_creation_tokens,
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
      cache_read_tokens: Number(r.cache_read_tokens),
      cache_creation_tokens: Number(r.cache_creation_tokens),
      input_cost: Number(r.input_cost),
      output_cost: Number(r.output_cost),
      total_cost: Number(r.total_cost),
      latency_ms: Number(r.latency_ms),
    }));
  }

  // ── RAG: retrieval documents + embeddings ────────────────────────────────────────

  async listRetrievalDocumentsByObservationIds(
    projectId: string,
    observationIds: string[],
  ): Promise<RetrievalDocumentDetail[]> {
    if (observationIds.length === 0) return [];
    const rows = await this.query<{
      observation_id: string;
      rank: unknown;
      score: unknown;
      doc_id: string;
      content: string;
      metadata: string;
    }>(
      `
      SELECT observation_id, rank, score, doc_id,
             COALESCE(content, '') AS content,
             COALESCE(metadata, '{}') AS metadata
      FROM retrieval_documents
      WHERE project_id = ? AND observation_id IN (?)
      ORDER BY observation_id ASC, rank ASC
      `,
      [projectId, observationIds],
    );
    return rows.map((r) => ({
      observation_id: r.observation_id,
      rank: Number(r.rank),
      score: r.score === null ? null : Number(r.score),
      doc_id: r.doc_id,
      content: r.content,
      metadata: r.metadata,
    }));
  }

  async listEmbeddingsForProjection(
    projectId: string,
    opts: { days?: number; limit?: number } = {},
  ): Promise<EmbeddingVectorRow[]> {
    const { days = 30, limit = 5000 } = opts;
    const rows = await this.query<{ observation_id: string; trace_id: string; vector: unknown }>(
      `
      SELECT observation_id, trace_id, CAST(vector AS JSON) AS vector
      FROM embeddings
      WHERE project_id = ? AND event_ts >= ? AND dim > 0
      ORDER BY event_ts DESC
      LIMIT ?
      `,
      [projectId, cutoffDaysAgo(days), Math.floor(limit)],
    );
    return rows
      .map((r) => ({ observation_id: r.observation_id, trace_id: r.trace_id, vector: parseVector(r.vector) }))
      .filter((r) => r.vector.length > 0);
  }

  async latestProjectionRunId(projectId: string): Promise<string | null> {
    const rows = await this.query<{ run_id: string }>(
      "SELECT run_id FROM embedding_projections WHERE project_id = ? ORDER BY event_ts DESC LIMIT 1",
      [projectId],
    );
    return rows[0]?.run_id ?? null;
  }

  async getTraceEmbeddings(projectId: string, traceId: string): Promise<TraceEmbeddingRow[]> {
    const rows = await this.query<{
      observation_id: string;
      trace_id: string;
      model: string;
      dim: unknown;
      vector: unknown;
    }>(
      `
      SELECT observation_id, trace_id, model, dim, CAST(vector AS JSON) AS vector
      FROM embeddings
      WHERE project_id = ? AND trace_id = ? AND dim > 0
      `,
      [projectId, traceId],
    );
    return rows
      .map((r) => ({
        observation_id: r.observation_id,
        trace_id: r.trace_id,
        model: r.model ?? "",
        dim: Number(r.dim ?? 0),
        vector: parseVector(r.vector),
      }))
      .filter((r) => r.vector.length > 0);
  }

  async rankSimilarTraceIds(
    projectId: string,
    opts: {
      seedVectors: number[][];
      model: string;
      dim: number;
      excludeTraceId: string;
      limit: number;
      days?: number;
    },
  ): Promise<{ trace_id: string; similarity: number }[]> {
    const { seedVectors, model, dim, excludeTraceId, limit, days } = opts;
    if (seedVectors.length === 0) return [];

    // Each seed vector becomes a cosine_distance(vector, [<literal>]) term; a candidate's
    // distance is the SMALLEST across seeds (its closest match). Distance is computed on the
    // BEs — exact, no ANN index (which Doris only allows on DUPLICATE KEY tables and which is
    // approximate anyway). Only the top-k rows return; the raw vectors never leave Doris.
    // Query-vector elements bind as per-element `?` placeholders (never CAST-from-string — the
    // same ARRAY-safety rule as writes). SELECT placeholders bind before WHERE, so seed params
    // come first.
    const params: unknown[] = [];
    const distTerms = seedVectors.map((v) => {
      const arr = `[${v.map(() => "?").join(",")}]`;
      params.push(...v);
      return `cosine_distance(vector, ${arr})`;
    });
    const distExpr = distTerms.length === 1 ? distTerms[0] : `LEAST(${distTerms.join(", ")})`;

    const conds = ["project_id = ?", "model = ?", "dim = ?", "dim > 0", "vector IS NOT NULL", "trace_id != ?"];
    params.push(projectId, model, Math.floor(dim), excludeTraceId);
    if (days && days > 0) {
      conds.push("event_ts >= ?");
      params.push(cutoffDaysAgo(days));
    }
    params.push(Math.floor(limit));

    const rows = await this.query<{ trace_id: string; dist: unknown }>(
      `
      SELECT trace_id, MIN(${distExpr}) AS dist
      FROM embeddings
      WHERE ${conds.join(" AND ")}
      GROUP BY trace_id
      ORDER BY dist ASC
      LIMIT ?
      `,
      params,
    );
    return rows
      .filter((r) => r.trace_id && r.dist != null)
      .map((r) => ({ trace_id: r.trace_id, similarity: 1 - Number(r.dist) }));
  }

  async listEmbeddingProjection(
    projectId: string,
    opts: { runId?: string; limit?: number } = {},
  ): Promise<EmbeddingPoint[]> {
    const runId = opts.runId ?? (await this.latestProjectionRunId(projectId));
    if (!runId) return [];
    const rows = await this.query<{
      observation_id: string;
      trace_id: string;
      x: unknown;
      y: unknown;
      z: unknown;
      cluster_id: unknown;
    }>(
      `
      SELECT observation_id, trace_id, x, y, z, cluster_id
      FROM embedding_projections
      WHERE project_id = ? AND run_id = ?
      LIMIT ?
      `,
      [projectId, runId, Math.floor(opts.limit ?? 10000)],
    );
    return rows.map((r) => ({
      observation_id: r.observation_id,
      trace_id: r.trace_id,
      x: Number(r.x),
      y: Number(r.y),
      z: r.z === null ? null : Number(r.z),
      cluster_id: Number(r.cluster_id),
      color_value: null, // filled in packages/server from scores when color-by is requested
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
    // Opt-in high-throughput path: Stream Load (HTTP). Merge-on-write still dedupes by key,
    // so a retry re-loading the same rows is idempotent just like the INSERT path.
    if (streamLoadEnabled()) {
      await streamLoad(table, rows);
      return;
    }
    for (const stmt of buildInserts(table, rows)) {
      await this.exec(stmt.sql, stmt.params);
    }
  }

  /** Write-shaped full-row SELECT list + row mapper per table (ms-precision timestamps). */
  private scanSelect<T extends TelemetryTable>(
    table: T,
  ): { select: string; map: (r: Record<string, unknown>) => TelemetryRowMap[T] } {
    const shapes: { [K in TelemetryTable]: { select: string; map: (r: never) => TelemetryRowMap[K] } } = {
      traces: {
        select: `project_id, id, DATE_FORMAT(\`timestamp\`, ${ISO_MS_FMT}) AS \`timestamp\`,
          name, user_id, session_id, \`release\`, version, environment, \`public\`,
          CAST(tags AS JSON) AS tags, COALESCE(metadata, '{}') AS metadata,
          COALESCE(input, '') AS input, COALESCE(output, '') AS output,
          DATE_FORMAT(event_ts, ${ISO_MS_FMT}) AS event_ts`,
        map: (r: TraceRow & { tags: unknown }) => ({ ...r, tags: parseTags(r.tags), public: Number(r.public) }),
      },
      observations: {
        select: `project_id, trace_id, id, type, parent_observation_id, name,
          DATE_FORMAT(start_time, ${ISO_MS_FMT}) AS start_time,
          IF(end_time IS NULL, NULL, DATE_FORMAT(end_time, ${ISO_MS_FMT})) AS end_time,
          environment, level, COALESCE(status_message, '') AS status_message, model, provider,
          COALESCE(model_parameters, '{}') AS model_parameters,
          prompt_tokens, completion_tokens, total_tokens, cache_read_tokens, cache_creation_tokens,
          input_cost, output_cost, total_cost, prompt_id, prompt_version,
          COALESCE(input, '') AS input, COALESCE(output, '') AS output,
          COALESCE(metadata, '{}') AS metadata, latency_ms,
          DATE_FORMAT(event_ts, ${ISO_MS_FMT}) AS event_ts`,
        map: (r: ObservationRow) => ({
          ...r,
          prompt_tokens: Number(r.prompt_tokens),
          completion_tokens: Number(r.completion_tokens),
          total_tokens: Number(r.total_tokens),
          cache_read_tokens: Number(r.cache_read_tokens),
          cache_creation_tokens: Number(r.cache_creation_tokens),
          input_cost: Number(r.input_cost),
          output_cost: Number(r.output_cost),
          total_cost: Number(r.total_cost),
          latency_ms: Number(r.latency_ms),
        }),
      },
      scores: {
        select: `project_id, id, trace_id, observation_id, name,
          DATE_FORMAT(\`timestamp\`, ${ISO_MS_FMT}) AS \`timestamp\`,
          environment, source, data_type, \`value\` AS value,
          COALESCE(string_value, '') AS string_value, COALESCE(\`comment\`, '') AS comment,
          config_id, DATE_FORMAT(event_ts, ${ISO_MS_FMT}) AS event_ts`,
        map: (r: ScoreWriteRow) => ({ ...r, value: r.value === null ? null : Number(r.value) }),
      },
      retrieval_documents: {
        select: `project_id, observation_id, rank, trace_id, doc_id, score,
          COALESCE(content, '') AS content, COALESCE(metadata, '{}') AS metadata,
          DATE_FORMAT(event_ts, ${ISO_MS_FMT}) AS event_ts`,
        map: (r: RetrievalDocumentRow) => ({
          ...r,
          rank: Number(r.rank),
          score: r.score === null ? null : Number(r.score),
        }),
      },
      embeddings: {
        select: `project_id, observation_id, trace_id, kind, model, dim,
          CAST(vector AS JSON) AS vector, DATE_FORMAT(event_ts, ${ISO_MS_FMT}) AS event_ts`,
        map: (r: EmbeddingRow & { vector: unknown }) => ({
          ...r,
          dim: Number(r.dim),
          vector: parseVector(r.vector),
        }),
      },
      embedding_projections: {
        select: `project_id, run_id, observation_id, trace_id, x, y, z, cluster_id, method,
          DATE_FORMAT(event_ts, ${ISO_MS_FMT}) AS event_ts`,
        map: (r: EmbeddingProjectionRow) => ({
          ...r,
          x: Number(r.x),
          y: Number(r.y),
          z: r.z === null ? null : Number(r.z),
          cluster_id: Number(r.cluster_id),
        }),
      },
    };
    const shape = shapes[table];
    return { select: shape.select, map: shape.map as (r: Record<string, unknown>) => TelemetryRowMap[T] };
  }

  async scanRows<T extends TelemetryTable>(
    table: T,
    cursor?: ScanCursor,
    limit = 1000,
  ): Promise<ScanPage<TelemetryRowMap[T]>> {
    const pk = TELEMETRY_PRIMARY_KEYS[table];
    const { select, map } = this.scanSelect(table);
    const conds: string[] = [];
    const params: unknown[] = [];
    if (cursor) {
      const after = keysetAfter(pk, cursor.key);
      conds.push(after.frag);
      params.push(...after.params);
    }
    const n = Math.max(1, Math.floor(limit));
    params.push(n);
    const rows = await this.query<Record<string, unknown>>(
      `SELECT ${select} FROM ${table}
       ${conds.length ? `WHERE ${conds.join(" AND ")}` : ""}
       ORDER BY ${pk.join(" ASC, ")} ASC
       LIMIT ?`,
      params,
    );
    const mapped = rows.map(map);
    const last = mapped[mapped.length - 1] as Record<string, unknown> | undefined;
    const next = mapped.length === n && last ? { key: pk.map((c) => String(last[c])) } : null;
    return { rows: mapped, next };
  }

  async deleteScore(projectId: string, scoreId: string): Promise<void> {
    await this.exec("DELETE FROM scores WHERE project_id = ? AND id = ?", [projectId, scoreId]);
  }

  async deleteTraces(projectId: string, traceIds: string[]): Promise<void> {
    if (traceIds.length === 0) return;
    await this.exec("DELETE FROM traces WHERE project_id = ? AND id IN (?)", [projectId, traceIds]);
    await this.exec("DELETE FROM observations WHERE project_id = ? AND trace_id IN (?)", [projectId, traceIds]);
    await this.exec("DELETE FROM scores WHERE project_id = ? AND trace_id IN (?)", [projectId, traceIds]);
    await this.exec("DELETE FROM retrieval_documents WHERE project_id = ? AND trace_id IN (?)", [projectId, traceIds]);
    await this.exec("DELETE FROM embeddings WHERE project_id = ? AND trace_id IN (?)", [projectId, traceIds]);
    await this.exec("DELETE FROM embedding_projections WHERE project_id = ? AND trace_id IN (?)", [
      projectId,
      traceIds,
    ]);
  }

  async deleteOlderThan(projectId: string, days: number): Promise<void> {
    const cutoff = cutoffDaysAgo(days);
    await this.exec("DELETE FROM traces WHERE project_id = ? AND `timestamp` < ?", [projectId, cutoff]);
    await this.exec("DELETE FROM observations WHERE project_id = ? AND start_time < ?", [projectId, cutoff]);
    await this.exec("DELETE FROM scores WHERE project_id = ? AND `timestamp` < ?", [projectId, cutoff]);
    await this.exec("DELETE FROM retrieval_documents WHERE project_id = ? AND event_ts < ?", [projectId, cutoff]);
    await this.exec("DELETE FROM embeddings WHERE project_id = ? AND event_ts < ?", [projectId, cutoff]);
    await this.exec("DELETE FROM embedding_projections WHERE project_id = ? AND event_ts < ?", [projectId, cutoff]);
  }

  async deleteProjectData(projectId: string): Promise<void> {
    await this.exec("DELETE FROM traces WHERE project_id = ?", [projectId]);
    await this.exec("DELETE FROM observations WHERE project_id = ?", [projectId]);
    await this.exec("DELETE FROM scores WHERE project_id = ?", [projectId]);
    await this.exec("DELETE FROM retrieval_documents WHERE project_id = ?", [projectId]);
    await this.exec("DELETE FROM embeddings WHERE project_id = ?", [projectId]);
    await this.exec("DELETE FROM embedding_projections WHERE project_id = ?", [projectId]);
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
