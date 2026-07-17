import type {
  AnalyticsQuery,
  ChartType,
  QueryWidget,
  WidgetBreakdown,
  WidgetFilters,
  WidgetMetric,
  WidgetPoint,
} from "@memoturn/contracts";
import { Prisma, prisma } from "@memoturn/db";
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
    // Legacy tiles only — query-engine widgets (query set) are listed by listQueryWidgets.
    where: { projectId, dashboardId: dashboardId ?? null, query: { equals: Prisma.DbNull } },
    orderBy: [{ position: "asc" }, { createdAt: "asc" }],
  });
  return Promise.all(widgets.map((w) => widgetWithData(projectId, w)));
}

export async function deleteWidget(projectId: string, id: string) {
  await prisma.widget.deleteMany({ where: { projectId, id } });
  return { deleted: true };
}

// ── Query-engine widgets (built in Explore) ──────────────────────────────────────

export interface CreateQueryWidgetInput {
  title: string;
  query: AnalyticsQuery;
  chartType: ChartType;
  dashboardId?: string | null;
  gridW?: number;
  gridH?: number;
}

function toQueryWidget(w: {
  id: string;
  dashboardId: string | null;
  title: string;
  query: unknown;
  chartType: string | null;
  gridX: number;
  gridY: number;
  gridW: number;
  gridH: number;
}): QueryWidget {
  return {
    id: w.id,
    dashboardId: w.dashboardId,
    title: w.title,
    query: w.query as AnalyticsQuery,
    chartType: (w.chartType ?? "line") as ChartType,
    gridX: w.gridX,
    gridY: w.gridY,
    gridW: w.gridW,
    gridH: w.gridH,
  };
}

export async function createQueryWidget(projectId: string, input: CreateQueryWidgetInput): Promise<QueryWidget> {
  const w = await prisma.widget.create({
    data: {
      projectId,
      dashboardId: input.dashboardId ?? null,
      title: input.title,
      query: input.query as object,
      chartType: input.chartType,
      gridW: input.gridW ?? 6,
      gridH: input.gridH ?? 4,
    },
  });
  return toQueryWidget(w);
}

/** Persist a widget's 12-col grid placement (drag/resize). Unspecified fields are left unchanged. */
export async function updateWidgetGrid(
  projectId: string,
  id: string,
  grid: { gridX?: number; gridY?: number; gridW?: number; gridH?: number },
): Promise<{ updated: boolean }> {
  const { count } = await prisma.widget.updateMany({
    where: { projectId, id },
    data: {
      ...(grid.gridX !== undefined && { gridX: grid.gridX }),
      ...(grid.gridY !== undefined && { gridY: grid.gridY }),
      ...(grid.gridW !== undefined && { gridW: grid.gridW }),
      ...(grid.gridH !== undefined && { gridH: grid.gridH }),
    },
  });
  return { updated: count > 0 };
}

/** Query-engine widgets for a dashboard (rows where `query` is set — legacy tiles are excluded). */
export async function listQueryWidgets(projectId: string, dashboardId?: string | null): Promise<QueryWidget[]> {
  const widgets = await prisma.widget.findMany({
    where: { projectId, dashboardId: dashboardId ?? null, query: { not: Prisma.DbNull } },
    orderBy: [{ position: "asc" }, { createdAt: "asc" }],
  });
  return widgets.map(toQueryWidget);
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
