import type { WidgetBreakdown, WidgetMetric, WidgetPoint } from "@memoturn/contracts";
import { prisma } from "@memoturn/db";
import { telemetry } from "@memoturn/telemetry";

/**
 * Custom dashboard widgets — each widget is a saved metric query computed by the
 * telemetry store over GENERATION observations. `getWidgetData` computes the series;
 * the API inlines it.
 */
export type { WidgetBreakdown, WidgetMetric, WidgetPoint };

export interface CreateWidgetInput {
  title: string;
  metric?: WidgetMetric;
  breakdown?: WidgetBreakdown;
  days?: number;
}

export async function getWidgetData(
  projectId: string,
  metric: WidgetMetric,
  breakdown: WidgetBreakdown,
  days: number,
): Promise<WidgetPoint[]> {
  return telemetry().widgetSeries(projectId, metric, breakdown, days);
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
