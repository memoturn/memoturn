import type { SessionSummary } from "@memoturn/contracts";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import type { ColumnDef } from "@tanstack/react-table";
import { MessageSquare } from "lucide-react";
import { DataTable } from "../../components/data-table";
import { EmptyState } from "../../components/empty-state";
import { PageHeader } from "../../components/page-header";
import { StatTile } from "../../components/stat-tile";
import { Skeleton } from "../../components/ui/skeleton";
import { api } from "../../lib/api";

export const Route = createFileRoute("/sessions/")({ component: SessionsPage });

const money = (n: number) => (n > 0 ? `$${n.toFixed(4)}` : "—");

const columns: ColumnDef<SessionSummary>[] = [
  {
    accessorKey: "session_id",
    header: "Session",
    cell: ({ row }) => (
      <Link
        to="/sessions/$id"
        params={{ id: row.original.session_id }}
        className="font-medium text-primary hover:underline"
        onClick={(e) => e.stopPropagation()}
      >
        {row.original.session_id}
      </Link>
    ),
  },
  { accessorKey: "trace_count", header: "Traces" },
  {
    accessorKey: "total_cost",
    header: "Cost",
    cell: ({ row }) => {
      const cost = Number(row.original.total_cost);
      return cost > 0 ? `$${cost.toFixed(6)}` : "—";
    },
  },
  { accessorKey: "first_seen", header: "First seen", cell: ({ row }) => row.original.first_seen },
  { accessorKey: "last_seen", header: "Last seen", cell: ({ row }) => row.original.last_seen },
];

function SessionsPage() {
  const navigate = useNavigate();
  const {
    data: sessions,
    isLoading,
    error,
  } = useQuery({
    queryKey: ["sessions"],
    queryFn: () => api.listSessions(),
    refetchInterval: 5_000,
  });

  return (
    <div>
      <PageHeader title="Sessions" description="Grouped traces sharing a session id." />
      {isLoading ? (
        <Skeleton className="h-64 w-full" />
      ) : error ? (
        <EmptyState title="Failed to load sessions" description={String(error)} />
      ) : !sessions || sessions.length === 0 ? (
        <EmptyState
          icon={MessageSquare}
          title="No sessions yet"
          description="Sessions appear when traces share a session id."
        />
      ) : (
        <div className="space-y-6">
          <div className="grid grid-cols-3 gap-4 sm:max-w-xl">
            <StatTile label="Sessions" value={sessions.length} />
            <StatTile label="Traces" value={sessions.reduce((a, s) => a + Number(s.trace_count), 0)} />
            <StatTile label="Cost" value={money(sessions.reduce((a, s) => a + Number(s.total_cost), 0))} />
          </div>
          <DataTable
            columns={columns}
            data={sessions}
            filterColumn="session_id"
            filterPlaceholder="Filter sessions…"
            onRowClick={(s) => navigate({ to: "/sessions/$id", params: { id: s.session_id } })}
          />
        </div>
      )}
    </div>
  );
}
