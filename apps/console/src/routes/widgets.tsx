import {
  ANALYTICS_VIEWS,
  type AnalyticsQuery,
  type ChartType,
  type QueryAggregation,
  type QueryGranularity,
  type QueryView,
  type QueryWidget,
  type SingleFilter,
  TIME_SERIES_CHARTS,
} from "@memoturn/contracts";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { EmptyState } from "../components/empty-state";
import { FilterBuilder } from "../components/filter-builder";
import { PageHeader } from "../components/page-header";
import { Button } from "../components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { WidgetChart } from "../features/widgets/WidgetChart";
import { api } from "../lib/api";
import { useIsReadOnly } from "../lib/role";
import { useRangeDays } from "../lib/timeRange";

export const Route = createFileRoute("/widgets")({ component: WidgetBuilderPage });

const CHART_LABEL: Record<ChartType, string> = {
  line: "Line",
  bar: "Bar",
  horizontal_bar: "Horizontal bar",
  big_number: "Big number",
  pie: "Pie",
  table: "Table",
};
const AGG_LABEL: Record<QueryAggregation, string> = {
  count: "Count",
  sum: "Sum",
  avg: "Average",
  min: "Min",
  max: "Max",
  p50: "p50",
  p75: "p75",
  p90: "p90",
  p95: "p95",
  p99: "p99",
  uniq: "Unique",
};
const GRANULARITIES: QueryGranularity[] = ["minute", "hour", "day", "week", "month"];
// Dashboard-level filters use columns common to every view (environment is in all three).
const DASHBOARD_FILTER_COLUMNS = [{ id: "environment", label: "Environment", type: "stringOptions" as const }];

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <div className="text-xs font-medium text-muted-foreground">{label}</div>
      {children}
    </div>
  );
}

function WidgetBuilderPage() {
  const days = useRangeDays();
  const [view, setView] = useState<QueryView>("observations");
  const [measure, setMeasure] = useState("count");
  const [aggregation, setAggregation] = useState<QueryAggregation>("count");
  const [dimension, setDimension] = useState<string>("none");
  const [chartType, setChartType] = useState<ChartType>("line");
  const [granularity, setGranularity] = useState<QueryGranularity>("day");
  const [filters, setFilters] = useState<SingleFilter[]>([]);
  const [dashFilters, setDashFilters] = useState<SingleFilter[]>([]);

  const catalog = ANALYTICS_VIEWS.find((v) => v.view === view) ?? ANALYTICS_VIEWS[0]!;
  const measureDef = catalog.measures.find((m) => m.id === measure) ?? catalog.measures[0]!;
  const isTimeSeries = TIME_SERIES_CHARTS.includes(chartType);
  // The current view's dimensions become filterable columns (categorical → stringOptions).
  const filterColumns = catalog.dimensions.map((d) => ({ id: d.id, label: d.label, type: "stringOptions" as const }));

  // Dependent resets keep the form in a valid state as the view/measure change.
  const onView = (v: string) => {
    const cat = ANALYTICS_VIEWS.find((c) => c.view === v) ?? ANALYTICS_VIEWS[0]!;
    setView(v as QueryView);
    setMeasure(cat.measures[0]!.id);
    setAggregation(cat.measures[0]!.aggregations[0]!);
    setDimension("none");
    setFilters([]); // dimension/filter columns are view-specific
  };
  const onMeasure = (m: string) => {
    setMeasure(m);
    const def = catalog.measures.find((x) => x.id === m) ?? catalog.measures[0]!;
    setAggregation(def.aggregations[0]!);
  };

  const query = useMemo<AnalyticsQuery>(() => {
    const now = Date.now();
    const useDimension = !isTimeSeries && chartType !== "big_number" && dimension !== "none";
    return {
      view,
      metrics: [{ measure, aggregation }],
      dimensions: useDimension ? [{ field: dimension }] : [],
      filters,
      timeDimension: isTimeSeries ? { granularity } : null,
      fromTimestamp: new Date(now - days * 86_400_000).toISOString(),
      toTimestamp: new Date(now).toISOString(),
      // Total-value breakdowns need a bounded top-N (also satisfies the high-cardinality guard).
      orderBy: useDimension ? [{ field: `${aggregation}_${measure}`, direction: "desc" }] : [],
      rowLimit: 100,
    };
  }, [view, measure, aggregation, dimension, chartType, granularity, isTimeSeries, days, filters]);

  const { data, error, isFetching } = useQuery({
    queryKey: ["analytics-query", query],
    queryFn: () => api.runAnalyticsQuery(query),
    placeholderData: keepPreviousData,
    retry: false,
  });

  const qc = useQueryClient();
  const readOnly = useIsReadOnly();
  const saved = useQuery({ queryKey: ["query-widgets"], queryFn: () => api.listQueryWidgets() });
  const save = useMutation({
    mutationFn: (title: string) => api.createQueryWidget({ title, query, chartType, gridW: 6 }),
    onSuccess: () => {
      toast.success("Chart saved");
      qc.invalidateQueries({ queryKey: ["query-widgets"] });
    },
    onError: (e) => toast.error(`Failed to save: ${String(e)}`),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.deleteWidget(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["query-widgets"] }),
    onError: (e) => toast.error(`Failed to delete: ${String(e)}`),
  });
  const resize = useMutation({
    mutationFn: ({ id, gridW }: { id: string; gridW: number }) => api.updateWidgetGrid(id, { gridW }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["query-widgets"] }),
    onError: (e) => toast.error(`Failed to resize: ${String(e)}`),
  });
  const promptSave = () => {
    if (!data) return;
    const title = window.prompt("Name this chart", `${AGG_LABEL[aggregation]} of ${measureDef.label}`);
    if (title) save.mutate(title);
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Explore"
        description="Build an ad-hoc chart: pick a view, a metric, and how to break it down. The preview updates live. (Saving to a dashboard comes with grid dashboards.)"
        help="A query builder over your telemetry — choose traces/observations/scores, an aggregation, an optional breakdown, and a chart type."
      />

      <div className="grid gap-6 lg:grid-cols-[260px_1fr]">
        <div className="space-y-4">
          <Field label="View">
            <Select value={view} onValueChange={onView}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ANALYTICS_VIEWS.map((v) => (
                  <SelectItem key={v.view} value={v.view}>
                    {v.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>

          <Field label="Measure">
            <Select value={measure} onValueChange={onMeasure}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {catalog.measures.map((m) => (
                  <SelectItem key={m.id} value={m.id}>
                    {m.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>

          <Field label="Aggregation">
            <Select value={aggregation} onValueChange={(v) => setAggregation(v as QueryAggregation)}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {measureDef.aggregations.map((a) => (
                  <SelectItem key={a} value={a}>
                    {AGG_LABEL[a]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>

          <Field label="Chart type">
            <Select value={chartType} onValueChange={(v) => setChartType(v as ChartType)}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(CHART_LABEL) as ChartType[]).map((c) => (
                  <SelectItem key={c} value={c}>
                    {CHART_LABEL[c]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>

          {isTimeSeries ? (
            <Field label="Granularity">
              <Select value={granularity} onValueChange={(v) => setGranularity(v as QueryGranularity)}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {GRANULARITIES.map((g) => (
                    <SelectItem key={g} value={g}>
                      {g}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          ) : (
            chartType !== "big_number" && (
              <Field label="Break down by">
                <Select value={dimension} onValueChange={setDimension}>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">(none)</SelectItem>
                    {catalog.dimensions.map((d) => (
                      <SelectItem key={d.id} value={d.id}>
                        {d.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            )
          )}

          <Field label="Filters">
            <FilterBuilder value={filters} onChange={setFilters} columns={filterColumns} />
          </Field>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Preview</CardTitle>
            <CardDescription>
              {catalog.label} · {AGG_LABEL[aggregation]} of {measureDef.label}
              {query.dimensions[0] ? ` by ${query.dimensions[0].field}` : ""} · last {days}d
            </CardDescription>
            {!readOnly && (
              <CardAction>
                <Button size="sm" variant="outline" disabled={!data || !!error || save.isPending} onClick={promptSave}>
                  {save.isPending ? "Saving…" : "Save to dashboard"}
                </Button>
              </CardAction>
            )}
          </CardHeader>
          <CardContent>
            {error ? (
              <div className="flex h-[240px] items-center justify-center text-sm text-destructive">
                {error instanceof Error ? error.message : "Query failed"}
              </div>
            ) : data ? (
              <div className={isFetching ? "opacity-60 transition-opacity" : undefined}>
                <WidgetChart query={query} result={data} chartType={chartType} height={280} />
              </div>
            ) : (
              <div className="flex h-[240px] items-center justify-center text-sm text-muted-foreground">Loading…</div>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-medium">Saved charts</h2>
          {saved.data && saved.data.length > 0 && (
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">Dashboard filter:</span>
              {/* Applies to every saved chart at render; views without the column simply ignore it. */}
              <FilterBuilder value={dashFilters} onChange={setDashFilters} columns={DASHBOARD_FILTER_COLUMNS} />
            </div>
          )}
        </div>
        {saved.data && saved.data.length > 0 ? (
          <div className="grid grid-cols-12 gap-4">
            {saved.data.map((w) => (
              <SavedWidget
                key={w.id}
                widget={w}
                readOnly={readOnly}
                extraFilters={dashFilters}
                onDelete={() => remove.mutate(w.id)}
                onResize={(gridW) => resize.mutate({ id: w.id, gridW })}
              />
            ))}
          </div>
        ) : (
          <EmptyState title="No saved charts yet" description="Build a chart above and “Save to dashboard”." />
        )}
      </div>
    </div>
  );
}

const WIDTHS = [
  { value: "3", label: "¼" },
  { value: "6", label: "½" },
  { value: "9", label: "¾" },
  { value: "12", label: "Full" },
];

/** One saved query-widget: runs its stored query and renders it, spanning `gridW` of 12 columns.
 * The width control persists gridW (a lightweight resize; drag-and-drop reorder is a follow-up). */
function SavedWidget({
  widget,
  readOnly,
  extraFilters,
  onDelete,
  onResize,
}: {
  widget: QueryWidget;
  readOnly: boolean;
  extraFilters: SingleFilter[];
  onDelete: () => void;
  onResize: (gridW: number) => void;
}) {
  const days = useRangeDays();
  // Recompute the time range live from the global picker (the stored absolute range would freeze),
  // and merge dashboard-level filters (the engine skips columns a view lacks).
  const now = Date.now();
  const query = {
    ...widget.query,
    filters: extraFilters.length ? [...widget.query.filters, ...extraFilters] : widget.query.filters,
    fromTimestamp: new Date(now - days * 86_400_000).toISOString(),
    toTimestamp: new Date(now).toISOString(),
  };
  const { data, error } = useQuery({
    queryKey: ["query-widget", widget.id, days, extraFilters],
    queryFn: () => api.runAnalyticsQuery(query),
    retry: false,
  });
  const span = Math.min(12, Math.max(2, widget.gridW));
  return (
    <Card className="col-span-12" style={{ gridColumn: `span ${span} / span ${span}` }}>
      <CardHeader>
        <CardTitle className="text-base">{widget.title}</CardTitle>
        {!readOnly && (
          <CardAction className="flex items-center gap-1">
            <Select value={String(span)} onValueChange={(v) => onResize(Number(v))}>
              <SelectTrigger className="h-7 w-16 text-xs" title="Widget width">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {WIDTHS.map((w) => (
                  <SelectItem key={w.value} value={w.value}>
                    {w.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              size="icon"
              variant="ghost"
              className="size-7 text-muted-foreground"
              onClick={onDelete}
              title="Delete chart"
            >
              <Trash2 className="size-4" />
            </Button>
          </CardAction>
        )}
      </CardHeader>
      <CardContent>
        {error ? (
          <div className="flex h-[200px] items-center justify-center text-sm text-destructive">
            {error instanceof Error ? error.message : "Query failed"}
          </div>
        ) : data ? (
          <WidgetChart query={query} result={data} chartType={widget.chartType} height={220} />
        ) : (
          <div className="flex h-[200px] items-center justify-center text-sm text-muted-foreground">Loading…</div>
        )}
      </CardContent>
    </Card>
  );
}
