import { clickhouse } from "@memoturn/db/clickhouse";

/**
 * ClickHouse read helpers for the trace API + dashboard UI. All queries are scoped by
 * project_id and use FINAL so ReplacingMergeTree de-duplicates merged rows at read
 * time (fine at MVP volumes; Phase 3 swaps hot paths to pre-aggregated views).
 */

export interface TraceSummary {
  id: string;
  name: string;
  timestamp: string;
  user_id: string;
  session_id: string;
  environment: string;
  observation_count: number;
  total_cost: number;
  total_tokens: number;
  latency_ms: number;
}

export interface ObservationDetail {
  id: string;
  trace_id: string;
  type: string;
  parent_observation_id: string;
  name: string;
  start_time: string;
  end_time: string | null;
  level: string;
  status_message: string;
  model: string;
  provider: string;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  total_cost: number;
  latency_ms: number;
  input: string;
  output: string;
  metadata: string;
}

export interface TraceDetail extends TraceSummary {
  release: string;
  version: string;
  tags: string[];
  metadata: string;
  input: string;
  output: string;
  observations: ObservationDetail[];
}

async function query<T>(sql: string, params: Record<string, unknown>): Promise<T[]> {
  const rs = await clickhouse().query({ query: sql, query_params: params, format: "JSONEachRow" });
  return rs.json<T>();
}

export interface TraceFilters {
  limit?: number;
  userId?: string;
  sessionId?: string;
  environment?: string;
  search?: string; // matches trace name (case-insensitive substring)
}

export async function listTraces(projectId: string, filters: TraceFilters = {}): Promise<TraceSummary[]> {
  const { limit = 50, userId, sessionId, environment, search } = filters;

  // Build optional filters as parameterized predicates on the trace row.
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

  return query<TraceSummary>(
    `
    SELECT
      t.id AS id,
      t.name AS name,
      formatDateTime(t.timestamp, '%Y-%m-%dT%H:%i:%SZ') AS timestamp,
      t.user_id AS user_id,
      t.session_id AS session_id,
      t.environment AS environment,
      count(o.id) AS observation_count,
      sum(o.total_cost) AS total_cost,
      sum(o.total_tokens) AS total_tokens,
      max(o.latency_ms) AS latency_ms
    FROM traces AS t FINAL
    LEFT JOIN observations AS o FINAL ON o.trace_id = t.id AND o.project_id = t.project_id
    WHERE ${conds.join(" AND ")}
    GROUP BY t.id, t.name, t.timestamp, t.user_id, t.session_id, t.environment
    ORDER BY t.timestamp DESC
    LIMIT {limit:UInt32}
    `,
    params,
  );
}

export interface SessionSummary {
  session_id: string;
  trace_count: number;
  first_seen: string;
  last_seen: string;
  total_cost: number;
}

export async function listSessions(projectId: string, limit = 50): Promise<SessionSummary[]> {
  return query<SessionSummary>(
    `
    SELECT
      t.session_id AS session_id,
      count(DISTINCT t.id) AS trace_count,
      formatDateTime(min(t.timestamp), '%Y-%m-%dT%H:%i:%SZ') AS first_seen,
      formatDateTime(max(t.timestamp), '%Y-%m-%dT%H:%i:%SZ') AS last_seen,
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
}

export async function getTrace(projectId: string, traceId: string): Promise<TraceDetail | null> {
  const traces = await query<Omit<TraceDetail, "observations" | "observation_count" | "total_cost" | "total_tokens" | "latency_ms">>(
    `
    SELECT
      id,
      name,
      formatDateTime(timestamp, '%Y-%m-%dT%H:%i:%SZ') AS timestamp,
      user_id, session_id, environment, release, version, tags, metadata, input, output
    FROM traces FINAL
    WHERE project_id = {projectId:String} AND id = {traceId:String}
    LIMIT 1
    `,
    { projectId, traceId },
  );
  if (traces.length === 0) return null;

  const observations = await query<ObservationDetail>(
    `
    SELECT
      id, trace_id, type, parent_observation_id, name,
      formatDateTime(start_time, '%Y-%m-%dT%H:%i:%SZ') AS start_time,
      if(end_time IS NULL, NULL, formatDateTime(end_time, '%Y-%m-%dT%H:%i:%SZ')) AS end_time,
      level, status_message, model, provider,
      prompt_tokens, completion_tokens, total_tokens, total_cost, latency_ms,
      input, output, metadata
    FROM observations FINAL
    WHERE project_id = {projectId:String} AND trace_id = {traceId:String}
    ORDER BY start_time ASC
    `,
    { projectId, traceId },
  );

  const t = traces[0]!;
  return {
    ...t,
    observation_count: observations.length,
    total_cost: observations.reduce((s, o) => s + Number(o.total_cost), 0),
    total_tokens: observations.reduce((s, o) => s + Number(o.total_tokens), 0),
    latency_ms: observations.reduce((m, o) => Math.max(m, Number(o.latency_ms)), 0),
    observations,
  };
}
