import type {
  AnalyticsQuery,
  CostRollupRow,
  DailyMetric,
  MetricsSummary,
  ModelMetric,
  QueryResult,
  ToolAnalyticsRow,
} from "@memoturn/contracts";
import { telemetry } from "@memoturn/telemetry";

/**
 * Dashboard metrics, aggregated on the fly from the observations table (GENERATION
 * rows) by the telemetry store. Fine at MVP volumes; a pre-aggregated rollup can
 * return behind the same store methods if a deployment ever needs one.
 */

export type { DailyMetric, MetricsSummary, ModelMetric, ToolAnalyticsRow };

/** Run a dashboard/widget analytics query (view × metrics × dimensions × time × filters). */
export async function runAnalyticsQuery(projectId: string, query: AnalyticsQuery): Promise<QueryResult> {
  return telemetry().runAnalyticsQuery(projectId, query);
}

export async function getMetrics(projectId: string, days = 30): Promise<MetricsSummary> {
  const store = telemetry();
  const [byDay, byModel, totalTraces] = await Promise.all([
    store.metricsByDay(projectId, days),
    store.metricsByModel(projectId, days),
    store.countTracesSince(projectId, days),
  ]);

  return {
    total_traces: totalTraces,
    total_generations: byModel.reduce((s, m) => s + m.generations, 0),
    total_errors: byDay.reduce((s, d) => s + d.errors, 0),
    total_tokens: byModel.reduce((s, m) => s + m.total_tokens, 0),
    total_cost: byModel.reduce((s, m) => s + m.total_cost, 0),
    byDay,
    byModel: byModel.map((m) => ({ ...m, model: m.model || "(unknown)" })),
  };
}

/** Per-tool (named SPAN) analytics — call volume, error rate, and latency over `days`. */
export async function getToolAnalytics(projectId: string, days = 30): Promise<ToolAnalyticsRow[]> {
  return telemetry().toolAnalytics(projectId, days);
}

/** Top spenders: cost rolled up by end user or session over `days`, ranked by spend. */
export async function getCostBreakdown(
  projectId: string,
  by: "user" | "session",
  opts: { days?: number; limit?: number } = {},
): Promise<CostRollupRow[]> {
  const store = telemetry();
  return by === "session" ? store.costBySession(projectId, opts) : store.costByUser(projectId, opts);
}
