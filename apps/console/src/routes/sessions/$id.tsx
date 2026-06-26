import type { TraceSummary } from "@memoturn/contracts";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import type { ColumnDef } from "@tanstack/react-table";
import { Activity } from "lucide-react";
import { DataTable } from "../../components/data-table";
import { EmptyState } from "../../components/empty-state";
import { PageHeader } from "../../components/page-header";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "../../components/ui/breadcrumb";
import { Skeleton } from "../../components/ui/skeleton";
import { api } from "../../lib/api";

export const Route = createFileRoute("/sessions/$id")({ component: SessionDetailPage });

function fmtCost(n: number): string {
  return n > 0 ? `$${n.toFixed(6)}` : "—";
}

const columns: ColumnDef<TraceSummary>[] = [
  {
    accessorKey: "name",
    header: "Name",
    cell: ({ row }) => (
      <Link
        to="/traces/$id"
        params={{ id: row.original.id }}
        className="font-medium text-primary hover:underline"
        onClick={(e) => e.stopPropagation()}
      >
        {row.original.name || row.original.id.slice(0, 8)}
      </Link>
    ),
  },
  { accessorKey: "timestamp", header: "Timestamp" },
  { accessorKey: "total_tokens", header: "Tokens", cell: ({ row }) => Number(row.original.total_tokens) },
  { accessorKey: "total_cost", header: "Cost", cell: ({ row }) => fmtCost(Number(row.original.total_cost)) },
  { accessorKey: "latency_ms", header: "Latency", cell: ({ row }) => `${row.original.latency_ms} ms` },
];

function SessionDetailPage() {
  const { id } = Route.useParams();
  const navigate = Route.useNavigate();
  const {
    data: traces,
    isLoading,
    error,
  } = useQuery({
    queryKey: ["session-traces", id],
    queryFn: () => api.listTraces({ sessionId: id }),
  });

  return (
    <div className="space-y-4">
      <Breadcrumb>
        <BreadcrumbList>
          <BreadcrumbItem>
            <BreadcrumbLink asChild>
              <Link to="/sessions">Sessions</Link>
            </BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbPage>{id}</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>

      <PageHeader title={`Session ${id}`} description="Traces sharing this session id." />

      {isLoading ? (
        <Skeleton className="h-64 w-full" />
      ) : error ? (
        <EmptyState title="Failed to load traces" description={String(error)} />
      ) : !traces || traces.length === 0 ? (
        <EmptyState icon={Activity} title="No traces in this session" description="This session has no traces yet." />
      ) : (
        <DataTable
          columns={columns}
          data={traces}
          filterColumn="name"
          filterPlaceholder="Filter traces…"
          onRowClick={(t) => navigate({ to: "/traces/$id", params: { id: t.id } })}
        />
      )}
    </div>
  );
}
