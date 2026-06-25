import { clickhouse } from "@memoturn/db/clickhouse";

/**
 * Metrics reads over the `observations_daily` AggregatingMergeTree rollup (populated
 * by the materialized view for GENERATION observations). State columns are read with
 * the `-Merge` combinators. Trace counts come from the `traces` table directly.
 */

export interface DailyMetric {
  date: string;
  generations: number;
  total_tokens: number;
  total_cost: number;
  p50_latency_ms: number;
  p95_latency_ms: number;
}

export interface ModelMetric {
  model: string;
  generations: number;
  total_tokens: number;
  total_cost: number;
}

export interface MetricsSummary {
  total_traces: number;
  total_generations: number;
  total_tokens: number;
  total_cost: number;
  byDay: DailyMetric[];
  byModel: ModelMetric[];
}

async function query<T>(sql: string, params: Record<string, unknown>): Promise<T[]> {
  const rs = await clickhouse().query({ query: sql, query_params: params, format: "JSONEachRow" });
  return rs.json<T>();
}

export async function getMetrics(projectId: string, days = 30): Promise<MetricsSummary> {
  const byDay = await query<{ day: string; generations: number; total_tokens: number; total_cost: number; latency: number[] }>(
    `
    SELECT
      toString(date) AS day,
      countMerge(observations) AS generations,
      sumMerge(total_tokens) AS total_tokens,
      sumMerge(total_cost) AS total_cost,
      quantilesMerge(0.5, 0.95, 0.99)(latency_ms) AS latency
    FROM observations_daily
    WHERE project_id = {projectId:String} AND date >= today() - {days:UInt32}
    GROUP BY date
    ORDER BY date ASC
    `,
    { projectId, days },
  );

  const byModel = await query<ModelMetric>(
    `
    SELECT
      model,
      countMerge(observations) AS generations,
      sumMerge(total_tokens) AS total_tokens,
      sumMerge(total_cost) AS total_cost
    FROM observations_daily
    WHERE project_id = {projectId:String} AND date >= today() - {days:UInt32}
    GROUP BY model
    ORDER BY total_cost DESC
    `,
    { projectId, days },
  );

  const traceCount = await query<{ c: number }>(
    `SELECT count() AS c FROM (SELECT id FROM traces FINAL WHERE project_id = {projectId:String} AND timestamp >= now() - toIntervalDay({days:UInt32}) GROUP BY id)`,
    { projectId, days },
  );

  return {
    total_traces: Number(traceCount[0]?.c ?? 0),
    total_generations: byModel.reduce((s, m) => s + Number(m.generations), 0),
    total_tokens: byModel.reduce((s, m) => s + Number(m.total_tokens), 0),
    total_cost: byModel.reduce((s, m) => s + Number(m.total_cost), 0),
    byDay: byDay.map((d) => ({
      date: d.day,
      generations: Number(d.generations),
      total_tokens: Number(d.total_tokens),
      total_cost: Number(d.total_cost),
      p50_latency_ms: Math.round(Number(d.latency?.[0] ?? 0)),
      p95_latency_ms: Math.round(Number(d.latency?.[1] ?? 0)),
    })),
    byModel: byModel.map((m) => ({
      model: m.model || "(unknown)",
      generations: Number(m.generations),
      total_tokens: Number(m.total_tokens),
      total_cost: Number(m.total_cost),
    })),
  };
}
