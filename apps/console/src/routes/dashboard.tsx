import { zodResolver } from "@hookform/resolvers/zod";
import type { ModelMetric, ToolAnalyticsRow, Widget } from "@memoturn/contracts";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import type { ColumnDef } from "@tanstack/react-table";
import {
  Activity,
  Coins,
  DollarSign,
  LayoutDashboard,
  type LucideIcon,
  Sparkles,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import { type ReactNode, useState } from "react";
import { useForm } from "react-hook-form";
import { Area, AreaChart, Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { toast } from "sonner";
import { z } from "zod";
import { DataTable } from "../components/data-table";
import { EmptyState } from "../components/empty-state";
import { HelpTip } from "../components/help-tip";
import { PageHeader } from "../components/page-header";
import { ModelLabel, ProviderIcon } from "../components/provider-icon";
import { Button } from "../components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "../components/ui/card";
import { type ChartConfig, ChartContainer, ChartTooltip, ChartTooltipContent } from "../components/ui/chart";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "../components/ui/form";
import { Input } from "../components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { Skeleton } from "../components/ui/skeleton";
import { api } from "../lib/api";
import { useIsReadOnly } from "../lib/role";
import { useRangeDays } from "../lib/timeRange";

export const Route = createFileRoute("/dashboard")({ component: DashboardPage });

function money(n: number): string {
  return `$${Number(n).toFixed(4)}`;
}

const modelColumns: ColumnDef<ModelMetric>[] = [
  {
    accessorKey: "model",
    header: "Model",
    cell: ({ row }) => <ModelLabel model={row.original.model} className="font-medium" />,
  },
  { accessorKey: "generations", header: "Gens", cell: ({ row }) => Number(row.original.generations).toLocaleString() },
  {
    accessorKey: "total_tokens",
    header: "Tokens",
    cell: ({ row }) => Number(row.original.total_tokens).toLocaleString(),
  },
  { accessorKey: "total_cost", header: "Cost", cell: ({ row }) => money(row.original.total_cost) },
];

const toolColumns: ColumnDef<ToolAnalyticsRow>[] = [
  { accessorKey: "tool", header: "Tool", cell: ({ row }) => <span className="font-medium">{row.original.tool}</span> },
  { accessorKey: "calls", header: "Calls", cell: ({ row }) => Number(row.original.calls).toLocaleString() },
  {
    accessorKey: "error_rate",
    header: "Error rate",
    cell: ({ row }) => {
      const rate = row.original.error_rate;
      return (
        <span className={rate > 0 ? "text-destructive" : "text-muted-foreground"}>
          {(rate * 100).toFixed(1)}% ({Number(row.original.errors).toLocaleString()})
        </span>
      );
    },
  },
  { accessorKey: "p50_latency_ms", header: "p50", cell: ({ row }) => `${row.original.p50_latency_ms} ms` },
  { accessorKey: "p95_latency_ms", header: "p95", cell: ({ row }) => `${row.original.p95_latency_ms} ms` },
];

// ── Interactive usage-over-time area chart ────────────────────────────────────────
type MetricKey = "cost" | "tokens" | "gens" | "errors" | "latency";
const usageConfig = {
  cost: { label: "Cost", color: "var(--chart-1)" },
  tokens: { label: "Tokens", color: "var(--chart-2)" },
  gens: { label: "Generations", color: "var(--chart-3)" },
  errors: { label: "Errors", color: "var(--destructive)" },
  latency: { label: "p95 latency", color: "var(--chart-4)" },
} satisfies ChartConfig;

function UsageChart({
  series,
  totals,
  days,
}: {
  series: { date: string; cost: number; tokens: number; gens: number; latency: number }[];
  totals: Record<MetricKey, string>;
  days: number;
}) {
  const [active, setActive] = useState<MetricKey>("cost");
  const metrics: MetricKey[] = ["cost", "tokens", "gens", "errors", "latency"];

  return (
    <Card className="gap-0 py-0">
      <CardHeader className="flex flex-col items-stretch space-y-0 border-b p-0 sm:flex-row">
        <div className="flex flex-1 flex-col justify-center gap-1.5 px-6 py-5">
          <div className="flex items-center gap-1.5">
            <CardTitle>Usage over time</CardTitle>
            <HelpTip>Daily totals for the selected metric — click a tile above to switch metrics.</HelpTip>
          </div>
          <CardDescription>
            Daily {usageConfig[active].label.toLowerCase()} over the last {days} days
          </CardDescription>
        </div>
        <div className="flex">
          {metrics.map((m) => (
            <button
              type="button"
              key={m}
              data-active={active === m}
              onClick={() => setActive(m)}
              className="flex flex-1 flex-col justify-center gap-1 border-t border-l px-4 py-3 text-left transition-colors hover:bg-muted/50 data-[active=true]:bg-muted sm:border-t-0 sm:px-5 sm:py-4"
            >
              <span className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
                {usageConfig[m].label}
              </span>
              <span className="text-sm font-semibold tabular-nums sm:text-lg">{totals[m]}</span>
            </button>
          ))}
        </div>
      </CardHeader>
      <CardContent className="px-2 pt-4 sm:px-6">
        <ChartContainer config={usageConfig} className="aspect-auto h-[260px] w-full">
          <AreaChart data={series} margin={{ left: 12, right: 12, top: 8 }}>
            <defs>
              <linearGradient id={`fill-${active}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor={`var(--color-${active})`} stopOpacity={0.7} />
                <stop offset="95%" stopColor={`var(--color-${active})`} stopOpacity={0.05} />
              </linearGradient>
            </defs>
            <CartesianGrid vertical={false} />
            <XAxis
              dataKey="date"
              tickLine={false}
              axisLine={false}
              tickMargin={8}
              minTickGap={24}
              tickFormatter={(v: string) => v.slice(5)}
            />
            <ChartTooltip cursor={false} content={<ChartTooltipContent labelFormatter={(v) => String(v)} />} />
            <Area
              dataKey={active}
              type="natural"
              stroke={`var(--color-${active})`}
              strokeWidth={2}
              fill={`url(#fill-${active})`}
            />
          </AreaChart>
        </ChartContainer>
      </CardContent>
    </Card>
  );
}

/** Vertical-bar-chart Y-axis tick: vendor logo + (truncated) model name, right-aligned to the axis. */
function ModelYTick({ x, y, payload }: { x?: number; y?: number; payload?: { value: string } }) {
  const value = payload?.value ?? "";
  const w = 126;
  return (
    <foreignObject x={(x ?? 0) - w} y={(y ?? 0) - 9} width={w} height={18}>
      <div className="flex items-center justify-end gap-1 pr-1.5 text-xs text-muted-foreground">
        <ProviderIcon model={value} size={14} />
        <span className="truncate">{value}</span>
      </div>
    </foreignObject>
  );
}

// ── Per-model bar chart ───────────────────────────────────────────────────────────
function ModelBarChart({
  title,
  description,
  data,
  metric,
  color,
  footer,
}: {
  title: string;
  description: string;
  data: { model: string; value: number }[];
  metric: string;
  color: string;
  footer?: ReactNode;
}) {
  const config = { value: { label: metric, color } } satisfies ChartConfig;
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>
        <ChartContainer config={config} className="aspect-auto h-[240px] w-full">
          <BarChart data={data} layout="vertical" margin={{ left: 8, right: 16 }}>
            <CartesianGrid horizontal={false} />
            <XAxis type="number" hide />
            <YAxis
              dataKey="model"
              type="category"
              tickLine={false}
              axisLine={false}
              width={132}
              tickMargin={6}
              tick={<ModelYTick />}
            />
            <ChartTooltip cursor={false} content={<ChartTooltipContent />} />
            <Bar dataKey="value" fill="var(--color-value)" radius={0} />
          </BarChart>
        </ChartContainer>
      </CardContent>
      {footer && <CardFooter className="border-t text-sm text-muted-foreground">{footer}</CardFooter>}
    </Card>
  );
}

/** First-load skeleton that mirrors the dashboard layout (stat row + charts) — no gray-block pop. */
function DashboardSkeleton({ days }: { days: number }) {
  return (
    <div className="space-y-6">
      <PageHeader title="Dashboard" description={`Overview of the last ${days} days.`} />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        {[0, 1, 2, 3, 4].map((i) => (
          <Skeleton key={i} className="h-24 w-full" />
        ))}
      </div>
      <Skeleton className="h-[340px] w-full" />
      <div className="grid gap-4 lg:grid-cols-2">
        <Skeleton className="h-[320px] w-full" />
        <Skeleton className="h-[320px] w-full" />
      </div>
    </div>
  );
}

function DashboardPage() {
  const days = useRangeDays();
  const { data, isLoading, error } = useQuery({
    queryKey: ["metrics", days],
    queryFn: () => api.getMetrics(days),
    refetchInterval: 10_000,
    // Keep the prior dashboard on screen while a new time range loads — no full-page skeleton flash.
    placeholderData: keepPreviousData,
  });
  const { data: tools } = useQuery({
    queryKey: ["tool-analytics", days],
    queryFn: () => api.getToolAnalytics(days),
    refetchInterval: 10_000,
    placeholderData: keepPreviousData,
  });
  const { data: costByUser } = useQuery({
    queryKey: ["cost-by-user", days],
    queryFn: () => api.getCostBreakdown("user", days, 10),
    placeholderData: keepPreviousData,
  });
  const { data: costBySession } = useQuery({
    queryKey: ["cost-by-session", days],
    queryFn: () => api.getCostBreakdown("session", days, 10),
    placeholderData: keepPreviousData,
  });

  if (isLoading) return <DashboardSkeleton days={days} />;
  if (error) return <EmptyState title="Failed to load dashboard" description={String(error)} />;
  if (!data) return null;

  const series = data.byDay.map((d) => ({
    date: d.date,
    cost: Number(d.total_cost),
    tokens: Number(d.total_tokens),
    gens: Number(d.generations),
    errors: Number(d.errors),
    latency: Number(d.p95_latency_ms),
  }));
  const maxLatency = Math.max(0, ...series.map((s) => s.latency));
  const totals: Record<MetricKey, string> = {
    cost: money(data.total_cost),
    tokens: Number(data.total_tokens).toLocaleString(),
    gens: Number(data.total_generations).toLocaleString(),
    errors: Number(data.total_errors).toLocaleString(),
    latency: `${maxLatency} ms`,
  };
  const costByModel = data.byModel.map((m) => ({ model: m.model, value: Number(m.total_cost) }));
  const tokensByModel = data.byModel.map((m) => ({ model: m.model, value: Number(m.total_tokens) }));
  const totalModelCost = costByModel.reduce((a, m) => a + m.value, 0);
  const totalModelTokens = tokensByModel.reduce((a, m) => a + m.value, 0);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Dashboard"
        description={`Overview of the last ${days} days.`}
        help="A rollup of traces, generations, tokens, cost, and errors across the selected time range."
      />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        <Stat
          label="Traces"
          value={Number(data.total_traces).toLocaleString()}
          icon={Activity}
          help="A trace is one end-to-end request through your app, including all of its nested spans."
        />
        <Stat
          label="Generations"
          value={Number(data.total_generations).toLocaleString()}
          icon={Sparkles}
          help="Generations are LLM calls (spans of type generation)."
        />
        <Stat
          label="Errors"
          value={Number(data.total_errors).toLocaleString()}
          icon={TriangleAlert}
          help="Spans recorded with an error level during this period."
        />
        <Stat
          label="Tokens"
          value={Number(data.total_tokens).toLocaleString()}
          icon={Coins}
          help="Total input plus output tokens across all generations."
        />
        <Stat
          label="Cost"
          value={money(data.total_cost)}
          icon={DollarSign}
          help="Estimated spend, computed from token counts and the model price table."
        />
      </div>

      {data.byDay.length === 0 ? (
        <EmptyState title="No generation data yet" description="Charts appear once traces are ingested." />
      ) : (
        <UsageChart series={series} totals={totals} days={days} />
      )}

      {data.byModel.length > 0 && (
        <div className="grid gap-4 lg:grid-cols-2">
          <ModelBarChart
            title="Cost by model"
            description="Total spend per model"
            data={costByModel}
            metric="Cost"
            color="var(--chart-1)"
            footer={`${money(totalModelCost)} total across ${costByModel.length} model${costByModel.length === 1 ? "" : "s"}`}
          />
          <ModelBarChart
            title="Tokens by model"
            description="Total tokens per model"
            data={tokensByModel}
            metric="Tokens"
            color="var(--chart-2)"
            footer={`${Math.round(totalModelTokens).toLocaleString()} tokens across ${tokensByModel.length} model${tokensByModel.length === 1 ? "" : "s"}`}
          />
        </div>
      )}

      {((costByUser && costByUser.length > 0) || (costBySession && costBySession.length > 0)) && (
        <div className="grid gap-4 lg:grid-cols-2">
          <ModelBarChart
            title="Top users by cost"
            description="Highest-spend end users"
            data={(costByUser ?? []).map((r) => ({ model: r.key, value: r.total_cost }))}
            metric="Cost"
            color="var(--chart-3)"
            footer={`${costByUser?.length ?? 0} user${(costByUser?.length ?? 0) === 1 ? "" : "s"}`}
          />
          <ModelBarChart
            title="Top sessions by cost"
            description="Highest-spend sessions"
            data={(costBySession ?? []).map((r) => ({ model: r.key, value: r.total_cost }))}
            metric="Cost"
            color="var(--chart-4)"
            footer={`${costBySession?.length ?? 0} session${(costBySession?.length ?? 0) === 1 ? "" : "s"}`}
          />
        </div>
      )}

      <Card>
        <CardHeader>
          <div className="flex items-center gap-1.5">
            <CardTitle>By model ({data.byModel.length})</CardTitle>
            <HelpTip>Per-model breakdown; spend is estimated from token counts and the model price table.</HelpTip>
          </div>
          <CardDescription>Generations, tokens, and spend per model.</CardDescription>
          {data.byModel.length > 0 && (
            <CardAction>
              <Button asChild variant="outline" size="sm">
                <Link to="/traces">View traces</Link>
              </Button>
            </CardAction>
          )}
        </CardHeader>
        <CardContent>
          {data.byModel.length === 0 ? (
            <EmptyState title="No model data yet" description="Per-model breakdown appears once generations record." />
          ) : (
            <DataTable columns={modelColumns} data={data.byModel} />
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>By tool ({tools?.length ?? 0})</CardTitle>
          <CardDescription>
            Call volume, error rate, and latency per tool/step (named spans) — where agents are slow or failing.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {!tools || tools.length === 0 ? (
            <EmptyState
              title="No tool data yet"
              description="Tool analytics appear once traces record tool/step spans (LangChain tools, OTel execute_tool spans)."
            />
          ) : (
            <DataTable columns={toolColumns} data={tools} />
          )}
        </CardContent>
      </Card>

      <CustomWidgets />
    </div>
  );
}

const widgetSchema = z.object({
  title: z.string().min(1, "Title is required"),
  metric: z.enum(["cost", "tokens", "generations", "latency_p95", "error_rate", "score"]),
  breakdown: z.enum(["by_day", "by_model", "by_user", "by_session"]),
  environment: z.string(),
  model: z.string(),
  tag: z.string(),
});
type WidgetForm = z.infer<typeof widgetSchema>;

const METRIC_LABELS: Record<string, string> = {
  cost: "cost",
  tokens: "tokens",
  generations: "generations",
  latency_p95: "p95 latency",
  error_rate: "error rate",
  score: "avg score",
};
const BREAKDOWN_LABELS: Record<string, string> = {
  by_day: "by day",
  by_model: "by model",
  by_user: "by user",
  by_session: "by session",
};

function CustomWidgets() {
  const qc = useQueryClient();
  const readOnly = useIsReadOnly();
  // null = the implicit "Default" dashboard (widgets with a null dashboardId).
  const [dashboardId, setDashboardId] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const { data: dashboards } = useQuery({ queryKey: ["dashboards"], queryFn: () => api.listDashboards() });
  const { data: widgets } = useQuery({
    queryKey: ["widgets", dashboardId],
    queryFn: () => api.listWidgets(dashboardId ?? undefined),
  });

  const form = useForm<WidgetForm>({
    resolver: zodResolver(widgetSchema),
    defaultValues: { title: "", metric: "cost", breakdown: "by_day", environment: "", model: "", tag: "" },
  });

  const add = useMutation({
    mutationFn: (v: WidgetForm) =>
      api.createWidget({
        title: v.title,
        metric: v.metric,
        breakdown: v.breakdown,
        days: 30,
        filters: {
          environment: v.environment || undefined,
          model: v.model || undefined,
          tag: v.tag || undefined,
        },
        dashboardId,
      }),
    onSuccess: () => {
      toast.success("Widget created");
      form.reset();
      qc.invalidateQueries({ queryKey: ["widgets", dashboardId] });
    },
    onError: (e) => toast.error(`Failed to create widget: ${String(e)}`),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.deleteWidget(id),
    onSuccess: () => {
      toast.success("Widget deleted");
      qc.invalidateQueries({ queryKey: ["widgets", dashboardId] });
    },
    onError: (e) => toast.error(`Failed to delete widget: ${String(e)}`),
  });
  const createDash = useMutation({
    mutationFn: (name: string) => api.createDashboard(name),
    onSuccess: (d) => {
      toast.success("Dashboard created");
      setNewName("");
      setDashboardId(d.id);
      qc.invalidateQueries({ queryKey: ["dashboards"] });
    },
    onError: (e) => toast.error(`Failed to create dashboard: ${String(e)}`),
  });
  const removeDash = useMutation({
    mutationFn: (id: string) => api.deleteDashboard(id),
    onSuccess: () => {
      toast.success("Dashboard deleted");
      setDashboardId(null);
      qc.invalidateQueries({ queryKey: ["dashboards"] });
    },
    onError: (e) => toast.error(`Failed to delete dashboard: ${String(e)}`),
  });

  return (
    <div className="space-y-4">
      <h2 className="flex items-center gap-1.5 text-lg font-semibold tracking-tight">
        Custom widgets
        <HelpTip>Pin your own filtered metric charts to a named dashboard for reuse.</HelpTip>
      </h2>

      {/* Dashboard tabs: the implicit Default plus any named dashboards. */}
      <div className="flex flex-wrap items-center gap-2">
        <Button variant={dashboardId === null ? "default" : "outline"} size="sm" onClick={() => setDashboardId(null)}>
          Default
        </Button>
        {(dashboards ?? []).map((d) => (
          <Button
            key={d.id}
            variant={dashboardId === d.id ? "default" : "outline"}
            size="sm"
            onClick={() => setDashboardId(d.id)}
          >
            {d.name}
          </Button>
        ))}
        {!readOnly && (
          <form
            className="flex items-center gap-1"
            onSubmit={(e) => {
              e.preventDefault();
              if (newName.trim()) createDash.mutate(newName.trim());
            }}
          >
            <Input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="New dashboard"
              className="h-8 w-40"
            />
            <Button type="submit" size="sm" variant="ghost" disabled={createDash.isPending || !newName.trim()}>
              + Add
            </Button>
          </form>
        )}
        {!readOnly && dashboardId !== null && (
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto text-destructive"
            onClick={() => removeDash.mutate(dashboardId)}
          >
            Delete dashboard
          </Button>
        )}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>New widget</CardTitle>
          <CardDescription>Pin a filtered metric to this dashboard.</CardDescription>
        </CardHeader>
        <CardContent>
          <Form {...form}>
            <form onSubmit={form.handleSubmit((v) => add.mutate(v))} className="space-y-4">
              <div className="grid items-end gap-4 sm:grid-cols-2 lg:grid-cols-3">
                <FormField
                  control={form.control}
                  name="title"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Title</FormLabel>
                      <FormControl>
                        <Input placeholder="Daily cost" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="metric"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Metric</FormLabel>
                      <Select value={field.value} onValueChange={field.onChange}>
                        <FormControl>
                          <SelectTrigger className="w-full">
                            <SelectValue />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {Object.entries(METRIC_LABELS).map(([v, label]) => (
                            <SelectItem key={v} value={v}>
                              {label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="breakdown"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Breakdown</FormLabel>
                      <Select value={field.value} onValueChange={field.onChange}>
                        <FormControl>
                          <SelectTrigger className="w-full">
                            <SelectValue />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {Object.entries(BREAKDOWN_LABELS).map(([v, label]) => (
                            <SelectItem key={v} value={v}>
                              {label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
              <div className="grid items-end gap-4 sm:grid-cols-2 lg:grid-cols-4">
                <FormField
                  control={form.control}
                  name="environment"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Environment (filter)</FormLabel>
                      <FormControl>
                        <Input placeholder="any" {...field} />
                      </FormControl>
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="model"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Model (filter)</FormLabel>
                      <FormControl>
                        <Input placeholder="any" {...field} />
                      </FormControl>
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="tag"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Tag (filter)</FormLabel>
                      <FormControl>
                        <Input placeholder="any" {...field} />
                      </FormControl>
                    </FormItem>
                  )}
                />
                <Button type="submit" disabled={readOnly || add.isPending}>
                  {add.isPending ? "Adding…" : "Add widget"}
                </Button>
              </div>
            </form>
          </Form>
        </CardContent>
      </Card>

      {!widgets || widgets.length === 0 ? (
        <EmptyState
          icon={LayoutDashboard}
          title="No widgets on this dashboard yet"
          description="Create one above to pin a metric here."
        />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {widgets.map((w) => (
            <WidgetCard key={w.id} widget={w} onDelete={() => remove.mutate(w.id)} disabled={readOnly} />
          ))}
        </div>
      )}
    </div>
  );
}

function WidgetCard({ widget, onDelete, disabled }: { widget: Widget; onDelete: () => void; disabled: boolean }) {
  const series = widget.data.map((p) => ({ label: p.label, value: Number(p.value) }));
  const isPeak = widget.metric === "latency_p95";
  const total = series.reduce((a, p) => a + p.value, 0);
  const avg = series.length ? total / series.length : 0;
  const peak = Math.max(0, ...series.map((p) => p.value));
  // error_rate / score aggregate as an average across buckets; the others sum.
  const headline =
    series.length === 0
      ? "—"
      : widget.metric === "cost"
        ? money(total)
        : isPeak
          ? `${peak} ms`
          : widget.metric === "error_rate"
            ? `${(avg * 100).toFixed(1)}%`
            : widget.metric === "score"
              ? avg.toFixed(2)
              : Math.round(total).toLocaleString();
  const activeFilters = Object.entries(widget.filters ?? {})
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}=${v}`)
    .join(" · ");
  const config = { value: { label: widget.metric, color: "var(--chart-1)" } } satisfies ChartConfig;
  return (
    <Card size="sm" className="gap-3">
      <CardHeader>
        <CardTitle className="truncate">{widget.title}</CardTitle>
        <CardDescription className="text-[0.6875rem]">
          {widget.metric} · {widget.breakdown.replace("_", " ")} · {widget.days}d
          {activeFilters ? ` · ${activeFilters}` : ""}
        </CardDescription>
        <CardAction>
          <Button
            variant="ghost"
            size="icon-sm"
            className="-mt-1 -mr-1 text-muted-foreground hover:text-destructive"
            onClick={onDelete}
            disabled={disabled}
            aria-label="Delete widget"
          >
            <Trash2 className="size-4" />
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="space-y-0.5">
          <div className="text-[0.6875rem] font-medium tracking-wide text-muted-foreground uppercase">
            {isPeak ? "Peak" : "Total"}
          </div>
          <div className="text-2xl font-semibold tabular-nums">{headline}</div>
        </div>
        {series.length === 0 ? (
          <p className="text-sm text-muted-foreground">no data</p>
        ) : (
          <ChartContainer config={config} className="aspect-auto h-[72px] w-full">
            <BarChart data={series} margin={{ top: 2, left: 0, right: 0 }}>
              <XAxis dataKey="label" hide />
              <ChartTooltip cursor={false} content={<ChartTooltipContent />} />
              <Bar dataKey="value" fill="var(--color-value)" radius={0} />
            </BarChart>
          </ChartContainer>
        )}
      </CardContent>
    </Card>
  );
}

function Stat({
  label,
  value,
  icon: Icon,
  help,
}: {
  label: string;
  value: string;
  icon: LucideIcon;
  help?: ReactNode;
}) {
  return (
    <Card>
      <CardHeader>
        <CardDescription>
          <span className="inline-flex items-center gap-1">
            {label}
            {help ? <HelpTip>{help}</HelpTip> : null}
          </span>
        </CardDescription>
        <CardTitle className="text-2xl tabular-nums">{value}</CardTitle>
        <CardAction>
          <span className="flex size-8 items-center justify-center bg-muted text-muted-foreground">
            <Icon className="size-4" />
          </span>
        </CardAction>
      </CardHeader>
    </Card>
  );
}
