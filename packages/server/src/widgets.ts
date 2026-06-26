import { prisma } from "@memoturn/db";
import { clickhouse } from "@memoturn/db/clickhouse";

/**
 * Custom dashboard widgets — each widget is a saved metric query over the daily rollup
 * (`observations_daily`). `getWidgetData` computes the series; the API inlines it.
 */
export type WidgetMetric = "cost" | "tokens" | "generations" | "latency_p95";
export type WidgetBreakdown = "by_day" | "by_model";

export interface CreateWidgetInput {
  title: string;
  metric?: WidgetMetric;
  breakdown?: WidgetBreakdown;
  days?: number;
}

const AGG: Record<WidgetMetric, string> = {
  cost: "sumMerge(total_cost)",
  tokens: "sumMerge(total_tokens)",
  generations: "countMerge(observations)",
  latency_p95: "arrayElement(quantilesMerge(0.95)(latency_ms), 1)",
};

export interface WidgetPoint {
  label: string;
  value: number;
}

export async function getWidgetData(
  projectId: string,
  metric: WidgetMetric,
  breakdown: WidgetBreakdown,
  days: number,
): Promise<WidgetPoint[]> {
  const agg = AGG[metric] ?? AGG.cost;
  const groupExpr = breakdown === "by_model" ? "model" : "toString(date)";
  const order = breakdown === "by_model" ? "value DESC" : "label ASC";
  const rs = await clickhouse().query({
    query: `
      SELECT ${groupExpr} AS label, ${agg} AS value
      FROM observations_daily
      WHERE project_id = {projectId:String} AND date >= today() - {days:UInt32}
      GROUP BY label
      ORDER BY ${order}
      LIMIT 100
    `,
    query_params: { projectId, days },
    format: "JSONEachRow",
  });
  const rows = await rs.json<{ label: string; value: number }>();
  return rows.map((r) => ({ label: r.label || "(unknown)", value: Number(r.value) }));
}

export async function createWidget(projectId: string, input: CreateWidgetInput) {
  const w = await prisma.widget.create({
    data: {
      projectId,
      title: input.title,
      metric: input.metric ?? "cost",
      breakdown: input.breakdown ?? "by_day",
      days: input.days ?? 30,
    },
  });
  return widgetWithData(projectId, w);
}

export async function listWidgets(projectId: string) {
  const widgets = await prisma.widget.findMany({
    where: { projectId },
    orderBy: [{ position: "asc" }, { createdAt: "asc" }],
  });
  return Promise.all(widgets.map((w) => widgetWithData(projectId, w)));
}

export async function deleteWidget(projectId: string, id: string) {
  await prisma.widget.deleteMany({ where: { projectId, id } });
  return { deleted: true };
}

async function widgetWithData(
  projectId: string,
  w: { id: string; title: string; metric: string; breakdown: string; days: number },
) {
  const data = await getWidgetData(projectId, w.metric as WidgetMetric, w.breakdown as WidgetBreakdown, w.days).catch(
    () => [],
  );
  return {
    id: w.id,
    title: w.title,
    metric: w.metric as WidgetMetric,
    breakdown: w.breakdown as WidgetBreakdown,
    days: w.days,
    data,
  };
}
