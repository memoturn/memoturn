import type { AuditEntry } from "@memoturn/contracts";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import type { ColumnDef } from "@tanstack/react-table";
import { ScrollText } from "lucide-react";
import { DataTable } from "../components/data-table";
import { EmptyState } from "../components/empty-state";
import { KindBadge } from "../components/kind-badge";
import { PageHeader } from "../components/page-header";
import { StatTile } from "../components/stat-tile";
import { Skeleton } from "../components/ui/skeleton";
import { api } from "../lib/api";

export const Route = createFileRoute("/audit")({ component: AuditPage });

const columns: ColumnDef<AuditEntry>[] = [
  {
    accessorKey: "createdAt",
    header: "Time",
    cell: ({ row }) => row.original.createdAt.slice(0, 19).replace("T", " "),
  },
  { accessorKey: "actor", header: "Actor" },
  {
    accessorKey: "action",
    header: "Action",
    cell: ({ row }) => <KindBadge tone="violet">{row.original.action}</KindBadge>,
  },
  { accessorKey: "target", header: "Target" },
];

function AuditPage() {
  const {
    data: logs,
    isLoading,
    error,
  } = useQuery({
    queryKey: ["audit"],
    queryFn: () => api.listAuditLogs(),
    refetchInterval: 10_000,
  });

  return (
    <div>
      <PageHeader title="Audit log" description="Record of mutating actions across the project." />
      {isLoading ? (
        <Skeleton className="h-64 w-full" />
      ) : error ? (
        <EmptyState title="Failed to load audit log" description={String(error)} />
      ) : !logs || logs.length === 0 ? (
        <EmptyState icon={ScrollText} title="No audit entries yet" description="Mutating actions will appear here." />
      ) : (
        <div className="space-y-6">
          <div className="grid grid-cols-2 gap-4 sm:max-w-md">
            <StatTile label="Entries" value={logs.length} />
            <StatTile label="Actors" value={new Set(logs.map((l) => l.actor)).size} />
          </div>
          <DataTable columns={columns} data={logs} filterColumn="actor" filterPlaceholder="Filter by actor…" />
        </div>
      )}
    </div>
  );
}
