import type { WidgetBreakdown, WidgetFilters, WidgetMetric, WidgetPoint } from "@memoturn/contracts";
import { prisma } from "@memoturn/db";
import { telemetry } from "@memoturn/telemetry";

/**
 * Custom dashboard widgets — each widget is a saved metric query computed by the telemetry
 * store over GENERATION observations (or scores, for the `score` metric). Widgets carry
 * optional per-widget filters (environment/model/tag) and belong to a named dashboard
 * (null dashboardId = the implicit "Default" dashboard). `getWidgetData` computes the series;
 * the API inlines it.
 */
export type { WidgetBreakdown, WidgetFilters, WidgetMetric, WidgetPoint };

export interface CreateWidgetInput {
  title: string;
  metric?: WidgetMetric;
  breakdown?: WidgetBreakdown;
  days?: number;
  filters?: WidgetFilters;
  dashboardId?: string | null;
}

export async function getWidgetData(
  projectId: string,
  metric: WidgetMetric,
  breakdown: WidgetBreakdown,
  days: number,
  filters: WidgetFilters = {},
): Promise<WidgetPoint[]> {
  return telemetry().widgetSeries(projectId, metric, breakdown, days, filters);
}

export async function createWidget(projectId: string, input: CreateWidgetInput) {
  const w = await prisma.widget.create({
    data: {
      projectId,
      dashboardId: input.dashboardId ?? null,
      title: input.title,
      metric: input.metric ?? "cost",
      breakdown: input.breakdown ?? "by_day",
      days: input.days ?? 30,
      filters: (input.filters ?? {}) as object,
    },
  });
  return widgetWithData(projectId, w);
}

/** List a project's widgets for one dashboard (dashboardId undefined ⇒ the Default dashboard). */
export async function listWidgets(projectId: string, dashboardId?: string | null) {
  const widgets = await prisma.widget.findMany({
    where: { projectId, dashboardId: dashboardId ?? null },
    orderBy: [{ position: "asc" }, { createdAt: "asc" }],
  });
  return Promise.all(widgets.map((w) => widgetWithData(projectId, w)));
}

export async function deleteWidget(projectId: string, id: string) {
  await prisma.widget.deleteMany({ where: { projectId, id } });
  return { deleted: true };
}

function cleanFilters(raw: unknown): WidgetFilters {
  const f = (raw ?? {}) as Record<string, unknown>;
  const out: WidgetFilters = {};
  if (typeof f.environment === "string" && f.environment) out.environment = f.environment;
  if (typeof f.model === "string" && f.model) out.model = f.model;
  if (typeof f.tag === "string" && f.tag) out.tag = f.tag;
  return out;
}

async function widgetWithData(
  projectId: string,
  w: {
    id: string;
    dashboardId: string | null;
    title: string;
    metric: string;
    breakdown: string;
    days: number;
    filters: unknown;
  },
) {
  const filters = cleanFilters(w.filters);
  const data = await getWidgetData(
    projectId,
    w.metric as WidgetMetric,
    w.breakdown as WidgetBreakdown,
    w.days,
    filters,
  ).catch(() => []);
  return {
    id: w.id,
    dashboardId: w.dashboardId,
    title: w.title,
    metric: w.metric as WidgetMetric,
    breakdown: w.breakdown as WidgetBreakdown,
    days: w.days,
    filters,
    data,
  };
}
