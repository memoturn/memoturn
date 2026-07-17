import {
  ANALYTICS_VIEWS,
  type AnalyticsQuery,
  type ChartType,
  type QueryAggregation,
  type QueryGranularity,
  type QueryView,
  TIME_SERIES_CHARTS,
} from "@memoturn/contracts";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { PageHeader } from "../components/page-header";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { WidgetChart } from "../features/widgets/WidgetChart";
import { api } from "../lib/api";
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

  const catalog = ANALYTICS_VIEWS.find((v) => v.view === view) ?? ANALYTICS_VIEWS[0]!;
  const measureDef = catalog.measures.find((m) => m.id === measure) ?? catalog.measures[0]!;
  const isTimeSeries = TIME_SERIES_CHARTS.includes(chartType);

  // Dependent resets keep the form in a valid state as the view/measure change.
  const onView = (v: string) => {
    const cat = ANALYTICS_VIEWS.find((c) => c.view === v) ?? ANALYTICS_VIEWS[0]!;
    setView(v as QueryView);
    setMeasure(cat.measures[0]!.id);
    setAggregation(cat.measures[0]!.aggregations[0]!);
    setDimension("none");
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
      filters: [],
      timeDimension: isTimeSeries ? { granularity } : null,
      fromTimestamp: new Date(now - days * 86_400_000).toISOString(),
      toTimestamp: new Date(now).toISOString(),
      // Total-value breakdowns need a bounded top-N (also satisfies the high-cardinality guard).
      orderBy: useDimension ? [{ field: `${aggregation}_${measure}`, direction: "desc" }] : [],
      rowLimit: 100,
    };
  }, [view, measure, aggregation, dimension, chartType, granularity, isTimeSeries, days]);

  const { data, error, isFetching } = useQuery({
    queryKey: ["analytics-query", query],
    queryFn: () => api.runAnalyticsQuery(query),
    placeholderData: keepPreviousData,
    retry: false,
  });

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
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Preview</CardTitle>
            <CardDescription>
              {catalog.label} · {AGG_LABEL[aggregation]} of {measureDef.label}
              {query.dimensions[0] ? ` by ${query.dimensions[0].field}` : ""} · last {days}d
            </CardDescription>
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
    </div>
  );
}
