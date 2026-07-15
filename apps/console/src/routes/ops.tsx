import type { IngestHealth } from "@memoturn/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import type { ColumnDef } from "@tanstack/react-table";
import { HeartPulse } from "lucide-react";
import { toast } from "sonner";
import { DataTable } from "../components/data-table";
import { EmptyState } from "../components/empty-state";
import { KindBadge } from "../components/kind-badge";
import { PageHeader } from "../components/page-header";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { api } from "../lib/api";
import { useIsReadOnly } from "../lib/role";

export const Route = createFileRoute("/ops")({ component: OpsPage });

type FailedBatch = IngestHealth["recentFailures"][number];

const failureColumns: ColumnDef<FailedBatch>[] = [
  {
    accessorKey: "batchId",
    header: "Batch",
    cell: ({ row }) => <span className="font-mono text-xs">{row.original.batchId}</span>,
  },
  { accessorKey: "failedAt", header: "Failed at", cell: ({ row }) => row.original.failedAt || "—" },
  {
    accessorKey: "error",
    header: "Error",
    cell: ({ row }) => <span className="text-muted-foreground">{row.original.error || "—"}</span>,
  },
];

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border p-4">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
    </div>
  );
}

function OpsPage() {
  const qc = useQueryClient();
  const readOnly = useIsReadOnly();
  // Poll: DLQ depth + worker counters move on their own; a 10s refresh keeps ops honest.
  const { data: health } = useQuery({
    queryKey: ["ingest-health"],
    queryFn: () => api.getIngestHealth(),
    refetchInterval: 10_000,
  });

  const replay = useMutation({
    mutationFn: () => api.replayDlq(),
    onSuccess: (r) => {
      toast.success(`Replayed ${r.replayed} batch(es)${r.failed ? ` (${r.failed} failed)` : ""}`);
      qc.invalidateQueries({ queryKey: ["ingest-health"] });
    },
    onError: (e) => toast.error(`Replay failed: ${String(e)}`),
  });

  const counters = Object.entries(health?.counters ?? {});

  return (
    <div className="space-y-6">
      <PageHeader
        title="Ingest health"
        description="The async ingest pipeline: dead-letter queue depth, insert latency, and error counters. Dead-lettered batches keep their blob key, so they can be replayed once the underlying cause is resolved."
      />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="DLQ depth" value={String(health?.dlqDepth ?? "—")} />
        <Stat
          label="Insert latency (avg)"
          value={health?.insertLatencyMs != null ? `${Math.round(health.insertLatencyMs)}ms` : "—"}
        />
        <div className="rounded-lg border p-4">
          <div className="text-xs text-muted-foreground">Worker</div>
          <div className="mt-1">
            <KindBadge tone={health?.workerReachable ? "green" : "red"}>
              {health?.workerReachable ? "reachable" : "unreachable"}
            </KindBadge>
          </div>
        </div>
        <div className="flex items-end">
          <Button
            variant="outline"
            className="w-full"
            disabled={readOnly || replay.isPending || (health?.dlqDepth ?? 0) === 0}
            onClick={() => replay.mutate()}
          >
            {replay.isPending ? "Replaying…" : "Replay DLQ"}
          </Button>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Error counters</CardTitle>
          <CardDescription>Cumulative worker counters (reset on worker restart).</CardDescription>
        </CardHeader>
        <CardContent>
          {counters.length === 0 ? (
            <div className="text-sm text-muted-foreground">
              {health?.workerReachable ? "No counters reported yet." : "Worker unreachable — counters unavailable."}
            </div>
          ) : (
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {counters.map(([k, v]) => (
                <div key={k} className="flex items-center justify-between rounded-md border px-3 py-2 text-sm">
                  <span className="font-mono text-xs text-muted-foreground">{k}</span>
                  <span className="tabular-nums font-medium">{v}</span>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <div>
        <h2 className="mb-3 text-sm font-medium">Recent dead-lettered batches</h2>
        {!health || health.recentFailures.length === 0 ? (
          <EmptyState
            icon={HeartPulse}
            title="No dead-lettered batches"
            description="The ingest pipeline is healthy."
          />
        ) : (
          <DataTable columns={failureColumns} data={health.recentFailures} />
        )}
      </div>
    </div>
  );
}
