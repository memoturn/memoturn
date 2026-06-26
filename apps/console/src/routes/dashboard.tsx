import { zodResolver } from "@hookform/resolvers/zod";
import type { DailyMetric, ModelMetric, Widget } from "@memoturn/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import type { ColumnDef } from "@tanstack/react-table";
import { LayoutDashboard, Trash2 } from "lucide-react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { DataTable } from "../components/data-table";
import { EmptyState } from "../components/empty-state";
import { PageHeader } from "../components/page-header";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
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

function Bar({ value, max }: { value: number; max: number }) {
  const pct = max > 0 ? Math.max(2, Math.round((value / max) * 100)) : 0;
  return (
    <div className="h-2 flex-1 overflow-hidden rounded bg-muted">
      <div className="h-full rounded bg-primary" style={{ width: `${pct}%` }} />
    </div>
  );
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

  const maxCost = Math.max(0, ...data.byDay.map((d) => Number(d.total_cost)));

  const dayColumns: ColumnDef<DailyMetric>[] = [
    {
      accessorKey: "date",
      header: "Date",
      cell: ({ row }) => <span className="font-medium">{row.original.date}</span>,
    },
    {
      accessorKey: "generations",
      header: "Gens",
      cell: ({ row }) => Number(row.original.generations).toLocaleString(),
    },
    {
      accessorKey: "total_tokens",
      header: "Tokens",
      cell: ({ row }) => Number(row.original.total_tokens).toLocaleString(),
    },
    { accessorKey: "p95_latency_ms", header: "p95 latency", cell: ({ row }) => `${row.original.p95_latency_ms} ms` },
    {
      accessorKey: "total_cost",
      header: "Cost",
      cell: ({ row }) => (
        <div className="flex min-w-40 items-center gap-2">
          <Bar value={Number(row.original.total_cost)} max={maxCost} />
          <span className="tabular-nums">{money(row.original.total_cost)}</span>
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-6">
      <PageHeader title="Dashboard" description={`Overview of the last ${days} days.`} />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Traces" value={Number(data.total_traces).toLocaleString()} />
        <Stat label="Generations" value={Number(data.total_generations).toLocaleString()} />
        <Stat label="Tokens" value={Number(data.total_tokens).toLocaleString()} />
        <Stat label="Cost" value={money(data.total_cost)} />
      </div>

      <div className="space-y-3">
        <h2 className="text-lg font-semibold tracking-tight">Cost by day ({days}d)</h2>
        {data.byDay.length === 0 ? (
          <EmptyState title="No generation data yet" description="Cost trends appear once traces are ingested." />
        ) : (
          <DataTable columns={dayColumns} data={data.byDay} />
        )}
      </div>

      <div className="space-y-3">
        <h2 className="text-lg font-semibold tracking-tight">By model</h2>
        {data.byModel.length === 0 ? (
          <EmptyState
            title="No model data yet"
            description="Per-model breakdown appears once generations are recorded."
          />
        ) : (
          <DataTable columns={modelColumns} data={data.byModel} />
        )}
      </div>

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
  const max = Math.max(0, ...widget.data.map((p) => Number(p.value)));
  const fmt = (v: number) => (widget.metric === "cost" ? `$${Number(v).toFixed(4)}` : Number(v).toLocaleString());
  return (
    <Card size="sm">
      <CardHeader>
        <div className="flex items-start justify-between gap-2">
          <div className="space-y-1">
            <CardTitle>{widget.title}</CardTitle>
            <CardDescription>
              {widget.metric} · {widget.breakdown.replace("_", " ")} · {widget.days}d
            </CardDescription>
          </div>
          <Button variant="ghost" size="icon" onClick={onDelete} disabled={disabled} aria-label="Delete widget">
            <Trash2 className="size-4" />
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {widget.data.length === 0 ? (
          <p className="text-sm text-muted-foreground">no data</p>
        ) : (
          <div className="space-y-2">
            {widget.data.slice(-12).map((p) => (
              <div className="flex items-center gap-2 text-sm" key={p.label}>
                <span className="w-24 shrink-0 truncate text-muted-foreground">{p.label}</span>
                <Bar value={Number(p.value)} max={max} />
                <span className="shrink-0 tabular-nums">{fmt(p.value)}</span>
              </div>
            ))}
          </div>
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
