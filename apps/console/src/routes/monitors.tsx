import type { AlertRule } from "@memoturn/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import type { ColumnDef } from "@tanstack/react-table";
import { Plus, Radar } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { DataTable } from "../components/data-table";
import { EmptyState } from "../components/empty-state";
import { KindBadge, type KindBadgeTone } from "../components/kind-badge";
import { PageHeader } from "../components/page-header";
import { StatTile } from "../components/stat-tile";
import { Button } from "../components/ui/button";
import { Switch } from "../components/ui/switch";
import { api } from "../lib/api";
import { useIsReadOnly } from "../lib/role";

export const Route = createFileRoute("/monitors")({ component: MonitorsPage });

// A monitor's live severity is derived from the alert rule's evaluation state (set by the
// worker's per-minute alert cron): a paused rule reads PAUSED, a rule the cron hasn't scored
// yet reads NO_DATA, and firing/resolved/ok map to ALERT/WARNING/OK. This gives the Monitors
// page a live status surface without any new backend — it reads the existing `/v1/alerts` state.
const SEVERITIES = ["ALERT", "WARNING", "OK", "NO_DATA", "PAUSED"] as const;
type Severity = (typeof SEVERITIES)[number];

const SEVERITY_TONE: Record<Severity, KindBadgeTone> = {
  ALERT: "red",
  WARNING: "amber",
  OK: "green",
  NO_DATA: "blue",
  PAUSED: "neutral",
};

const SEVERITY_LABEL: Record<Severity, string> = {
  ALERT: "Alert",
  WARNING: "Warning",
  OK: "OK",
  NO_DATA: "No data",
  PAUSED: "Paused",
};

function severityOf(a: AlertRule): Severity {
  if (!a.enabled) return "PAUSED";
  if (a.lastValue == null) return "NO_DATA";
  if (a.status === "firing") return "ALERT";
  if (a.status === "resolved") return "WARNING";
  return "OK";
}

const METRIC_LABEL: Record<string, string> = {
  error_rate: "Error rate",
  latency_p95: "Latency p95",
  cost_per_day: "Cost / day",
  ingest_volume: "Ingest volume",
  dlq_depth: "DLQ depth",
  rehydrate_rate: "Rehydrate / min",
};

const COMPARATOR_SYMBOL: Record<string, string> = {
  gt: ">",
  gte: "≥",
  lt: "<",
  lte: "≤",
  anomaly_high: "anomaly ↑",
  anomaly_low: "anomaly ↓",
};

/** Format a metric value for display: rates as %, everything else thousands-separated. */
function fmtValue(metric: string, v: number | null): string {
  if (v == null) return "—";
  if (metric === "error_rate") return `${(v * 100).toFixed(1)}%`;
  if (metric === "cost_per_day") return `$${v.toFixed(2)}`;
  if (metric === "latency_p95") return `${Math.round(v)}ms`;
  return v.toLocaleString();
}

function lastEvent(a: AlertRule): string {
  const t = a.lastFiredAt ?? a.lastResolvedAt;
  return t ? t.slice(0, 19).replace("T", " ") : "—";
}

function MonitorsPage() {
  const qc = useQueryClient();
  const readOnly = useIsReadOnly();
  // Poll: the alert cron re-evaluates every minute; a 15s refresh keeps the status list live
  // without hammering the API.
  const { data: alerts, isLoading } = useQuery({
    queryKey: ["alerts"],
    queryFn: () => api.listAlerts(),
    refetchInterval: 15_000,
  });

  const toggle = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) => api.updateAlert(id, { enabled }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["alerts"] }),
    onError: (e) => toast.error(`Failed to update monitor: ${String(e)}`),
  });

  // Severity filter — click a chip to narrow the table; empty set means "show all".
  const [active, setActive] = useState<Set<Severity>>(new Set());
  const toggleSeverity = (s: Severity) =>
    setActive((prev) => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s);
      else next.add(s);
      return next;
    });

  const rows = alerts ?? [];
  const counts = SEVERITIES.reduce(
    (acc, s) => {
      acc[s] = 0;
      return acc;
    },
    {} as Record<Severity, number>,
  );
  for (const a of rows) counts[severityOf(a)]++;
  const visible = active.size === 0 ? rows : rows.filter((a) => active.has(severityOf(a)));

  const columns: ColumnDef<AlertRule>[] = [
    {
      id: "severity",
      header: "Severity",
      cell: ({ row }) => {
        const s = severityOf(row.original);
        return <KindBadge tone={SEVERITY_TONE[s]}>{SEVERITY_LABEL[s]}</KindBadge>;
      },
    },
    {
      accessorKey: "name",
      header: "Name",
      cell: ({ row }) => <span className="font-medium">{row.original.name}</span>,
    },
    {
      id: "metric",
      header: "Metric",
      cell: ({ row }) => (
        <span className="text-muted-foreground">{METRIC_LABEL[row.original.metric] ?? row.original.metric}</span>
      ),
    },
    {
      id: "condition",
      header: "Condition",
      cell: ({ row }) => (
        <span className="font-mono text-xs">
          {COMPARATOR_SYMBOL[row.original.comparator] ?? row.original.comparator}{" "}
          {fmtValue(row.original.metric, row.original.threshold)}
          <span className="text-muted-foreground"> · {row.original.window}m</span>
        </span>
      ),
    },
    {
      id: "lastValue",
      header: "Last value",
      cell: ({ row }) => <span className="tabular-nums">{fmtValue(row.original.metric, row.original.lastValue)}</span>,
    },
    {
      id: "lastEvent",
      header: "Last event",
      cell: ({ row }) => <span className="text-muted-foreground">{lastEvent(row.original)}</span>,
    },
    {
      id: "actions",
      header: "Active",
      cell: ({ row }) => (
        <Switch
          checked={row.original.enabled}
          disabled={readOnly || toggle.isPending}
          aria-label={row.original.enabled ? "Pause monitor" : "Resume monitor"}
          onCheckedChange={(v) => toggle.mutate({ id: row.original.id, enabled: v })}
        />
      ),
    },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Monitors"
        description="Live status of your alert rules — each monitor evaluates a metric over a trailing window and reports its current severity. Alerts notify your channels only on a state change; this page is the at-a-glance health board."
        help="A status board over your alert rules: which are firing (Alert), recently recovered (Warning), healthy (OK), awaiting their first evaluation (No data), or paused."
        actions={
          !readOnly && (
            <Button asChild size="sm">
              <Link to="/settings">
                <Plus />
                New monitor
              </Link>
            </Button>
          )
        }
      />

      <div className="grid gap-4 sm:grid-cols-3 lg:grid-cols-5">
        {SEVERITIES.map((s) => (
          <StatTile key={s} label={SEVERITY_LABEL[s]} value={counts[s]} />
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-muted-foreground">Filter:</span>
        {SEVERITIES.map((s) => (
          <Button
            key={s}
            variant={active.has(s) ? "secondary" : "outline"}
            size="sm"
            className="h-7"
            onClick={() => toggleSeverity(s)}
          >
            <KindBadge tone={SEVERITY_TONE[s]} className="border-0 bg-transparent px-0">
              ●
            </KindBadge>
            {SEVERITY_LABEL[s]}
          </Button>
        ))}
        {active.size > 0 && (
          <Button variant="ghost" size="sm" className="h-7 text-muted-foreground" onClick={() => setActive(new Set())}>
            Clear
          </Button>
        )}
      </div>

      {!isLoading && rows.length === 0 ? (
        <EmptyState
          icon={Radar}
          title="No monitors yet"
          description="Create an alert rule in Settings to watch error rate, latency, cost, ingest volume, or DLQ depth. It'll show up here with live status."
        />
      ) : (
        <DataTable columns={columns} data={visible} />
      )}
    </div>
  );
}
