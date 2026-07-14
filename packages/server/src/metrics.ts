import type { DailyMetric, MetricsSummary, ModelMetric } from "@memoturn/contracts";
import { telemetry } from "@memoturn/telemetry";

/**
 * Dashboard metrics, aggregated on the fly from the observations table (GENERATION
 * rows) by the telemetry store. Fine at MVP volumes; a pre-aggregated rollup can
 * return behind the same store methods if a deployment ever needs one.
 */

export type { DailyMetric, MetricsSummary, ModelMetric };

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
    total_tokens: byModel.reduce((s, m) => s + m.total_tokens, 0),
    total_cost: byModel.reduce((s, m) => s + m.total_cost, 0),
    byDay,
    byModel: byModel.map((m) => ({ ...m, model: m.model || "(unknown)" })),
  };
}
