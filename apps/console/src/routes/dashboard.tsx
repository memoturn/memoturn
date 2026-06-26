import { zodResolver } from "@hookform/resolvers/zod";
import type { ModelMetric, Widget } from "@memoturn/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import type { ColumnDef } from "@tanstack/react-table";
import { LayoutDashboard, Trash2 } from "lucide-react";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { Area, AreaChart, Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { toast } from "sonner";
import { z } from "zod";
import { DataTable } from "../components/data-table";
import { EmptyState } from "../components/empty-state";
import { PageHeader } from "../components/page-header";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
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
    cell: ({ row }) => <span className="font-medium">{row.original.model}</span>,
  },
  { accessorKey: "generations", header: "Gens", cell: ({ row }) => Number(row.original.generations).toLocaleString() },
  {
    accessorKey: "total_tokens",
    header: "Tokens",
    cell: ({ row }) => Number(row.original.total_tokens).toLocaleString(),
  },
  { accessorKey: "total_cost", header: "Cost", cell: ({ row }) => money(row.original.total_cost) },
];

// ── Interactive usage-over-time area chart ────────────────────────────────────────
type MetricKey = "cost" | "tokens" | "gens" | "latency";
const usageConfig = {
  cost: { label: "Cost", color: "var(--chart-1)" },
  tokens: { label: "Tokens", color: "var(--chart-2)" },
  gens: { label: "Generations", color: "var(--chart-3)" },
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
  const metrics: MetricKey[] = ["cost", "tokens", "gens", "latency"];

  return (
    <Card>
      <CardHeader>
        <CardTitle>Usage over time</CardTitle>
        <CardDescription>
          Daily {usageConfig[active].label.toLowerCase()} over the last {days} days
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap gap-2">
          {metrics.map((m) => (
            <button
              type="button"
              key={m}
              data-active={active === m}
              onClick={() => setActive(m)}
              className="flex flex-col gap-0.5 border px-3 py-2 text-left transition-colors hover:bg-muted/60 data-[active=true]:border-foreground/30 data-[active=true]:bg-muted"
            >
              <span className="text-[0.6875rem] font-medium tracking-wide text-muted-foreground uppercase">
                {usageConfig[m].label}
              </span>
              <span className="text-base font-semibold tabular-nums">{totals[m]}</span>
            </button>
          ))}
        </div>
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

// ── Per-model bar chart ───────────────────────────────────────────────────────────
function ModelBarChart({
  title,
  description,
  data,
  metric,
  color,
}: {
  title: string;
  description: string;
  data: { model: string; value: number }[];
  metric: string;
  color: string;
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
            <YAxis dataKey="model" type="category" tickLine={false} axisLine={false} width={110} tickMargin={6} />
            <ChartTooltip cursor={false} content={<ChartTooltipContent />} />
            <Bar dataKey="value" fill="var(--color-value)" radius={0} />
          </BarChart>
        </ChartContainer>
      </CardContent>
    </Card>
  );
}

function DashboardPage() {
  const days = useRangeDays();
  const { data, isLoading, error } = useQuery({
    queryKey: ["metrics", days],
    queryFn: () => api.getMetrics(days),
    refetchInterval: 10_000,
  });

  if (isLoading) return <Skeleton className="h-96 w-full" />;
  if (error) return <EmptyState title="Failed to load dashboard" description={String(error)} />;
  if (!data) return null;

  const series = data.byDay.map((d) => ({
    date: d.date,
    cost: Number(d.total_cost),
    tokens: Number(d.total_tokens),
    gens: Number(d.generations),
    latency: Number(d.p95_latency_ms),
  }));
  const maxLatency = Math.max(0, ...series.map((s) => s.latency));
  const totals: Record<MetricKey, string> = {
    cost: money(data.total_cost),
    tokens: Number(data.total_tokens).toLocaleString(),
    gens: Number(data.total_generations).toLocaleString(),
    latency: `${maxLatency} ms`,
  };
  const costByModel = data.byModel.map((m) => ({ model: m.model, value: Number(m.total_cost) }));
  const tokensByModel = data.byModel.map((m) => ({ model: m.model, value: Number(m.total_tokens) }));

  return (
    <div className="space-y-6">
      <PageHeader title="Dashboard" description={`Overview of the last ${days} days.`} />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Traces" value={Number(data.total_traces).toLocaleString()} />
        <Stat label="Generations" value={Number(data.total_generations).toLocaleString()} />
        <Stat label="Tokens" value={Number(data.total_tokens).toLocaleString()} />
        <Stat label="Cost" value={money(data.total_cost)} />
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
          />
          <ModelBarChart
            title="Tokens by model"
            description="Total tokens per model"
            data={tokensByModel}
            metric="Tokens"
            color="var(--chart-2)"
          />
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle>By model ({data.byModel.length})</CardTitle>
        </CardHeader>
        <CardContent className={data.byModel.length === 0 ? undefined : "px-0"}>
          {data.byModel.length === 0 ? (
            <EmptyState title="No model data yet" description="Per-model breakdown appears once generations record." />
          ) : (
            <div className="border-t">
              <DataTable columns={modelColumns} data={data.byModel} />
            </div>
          )}
        </CardContent>
      </Card>

      <CustomWidgets />
    </div>
  );
}

const widgetSchema = z.object({
  title: z.string().min(1, "Title is required"),
  metric: z.enum(["cost", "tokens", "generations", "latency_p95"]),
  breakdown: z.enum(["by_day", "by_model"]),
});
type WidgetForm = z.infer<typeof widgetSchema>;

function CustomWidgets() {
  const qc = useQueryClient();
  const readOnly = useIsReadOnly();
  const { data: widgets } = useQuery({ queryKey: ["widgets"], queryFn: () => api.listWidgets() });

  const form = useForm<WidgetForm>({
    resolver: zodResolver(widgetSchema),
    defaultValues: { title: "", metric: "cost", breakdown: "by_day" },
  });

  const add = useMutation({
    mutationFn: (values: WidgetForm) => api.createWidget({ ...values, days: 30 }),
    onSuccess: () => {
      toast.success("Widget created");
      form.reset();
      qc.invalidateQueries({ queryKey: ["widgets"] });
    },
    onError: (e) => toast.error(`Failed to create widget: ${String(e)}`),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.deleteWidget(id),
    onSuccess: () => {
      toast.success("Widget deleted");
      qc.invalidateQueries({ queryKey: ["widgets"] });
    },
    onError: (e) => toast.error(`Failed to delete widget: ${String(e)}`),
  });

  return (
    <div className="space-y-4">
      <h2 className="text-lg font-semibold tracking-tight">Custom widgets</h2>

      <Card>
        <CardHeader>
          <CardTitle>New widget</CardTitle>
        </CardHeader>
        <CardContent>
          <Form {...form}>
            <form
              onSubmit={form.handleSubmit((v) => add.mutate(v))}
              className="grid items-end gap-4 sm:grid-cols-2 lg:grid-cols-4"
            >
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
                        <SelectItem value="cost">cost</SelectItem>
                        <SelectItem value="tokens">tokens</SelectItem>
                        <SelectItem value="generations">generations</SelectItem>
                        <SelectItem value="latency_p95">p95 latency</SelectItem>
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
                        <SelectItem value="by_day">by day</SelectItem>
                        <SelectItem value="by_model">by model</SelectItem>
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <Button type="submit" disabled={readOnly || add.isPending}>
                {add.isPending ? "Adding…" : "Add widget"}
              </Button>
            </form>
          </Form>
        </CardContent>
      </Card>

      {!widgets || widgets.length === 0 ? (
        <EmptyState
          icon={LayoutDashboard}
          title="No custom widgets yet"
          description="Create one above to pin a metric to the dashboard."
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
  const peak = Math.max(0, ...series.map((p) => p.value));
  const headline =
    series.length === 0
      ? "—"
      : widget.metric === "cost"
        ? money(total)
        : isPeak
          ? `${peak} ms`
          : Math.round(total).toLocaleString();
  const config = { value: { label: widget.metric, color: "var(--chart-1)" } } satisfies ChartConfig;
  return (
    <Card size="sm" className="gap-3">
      <CardHeader>
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 space-y-0.5">
            <CardTitle className="truncate">{widget.title}</CardTitle>
            <CardDescription className="text-[0.6875rem]">
              {widget.metric} · {widget.breakdown.replace("_", " ")} · {widget.days}d
            </CardDescription>
          </div>
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
        </div>
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

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <Card>
      <CardHeader>
        <CardDescription>{label}</CardDescription>
        <CardTitle className="text-2xl tabular-nums">{value}</CardTitle>
      </CardHeader>
    </Card>
  );
}
