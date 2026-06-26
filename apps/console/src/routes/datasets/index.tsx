import type { DatasetListItem } from "@memoturn/contracts";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import type { ColumnDef } from "@tanstack/react-table";
import { Database } from "lucide-react";
import { DataTable } from "../../components/data-table";
import { EmptyState } from "../../components/empty-state";
import { PageHeader } from "../../components/page-header";
import { Skeleton } from "../../components/ui/skeleton";
import { api } from "../../lib/api";

export const Route = createFileRoute("/datasets/")({ component: DatasetsPage });

const columns: ColumnDef<DatasetListItem>[] = [
  {
    accessorKey: "name",
    header: "Name",
    cell: ({ row }) => (
      <Link
        to="/datasets/$name"
        params={{ name: row.original.name }}
        className="font-medium text-primary hover:underline"
        onClick={(e) => e.stopPropagation()}
      >
        {row.original.name}
      </Link>
    ),
  },
  { accessorKey: "items", header: "Items", cell: ({ row }) => Number(row.original.items) },
  { accessorKey: "runs", header: "Runs", cell: ({ row }) => Number(row.original.runs) },
  {
    accessorKey: "description",
    header: "Description",
    cell: ({ row }) => row.original.description || "—",
  },
];

function DatasetsPage() {
  const {
    data: datasets,
    isLoading,
    error,
  } = useQuery({
    queryKey: ["datasets"],
    queryFn: () => api.listDatasets(),
    refetchInterval: 10_000,
  });

  return (
    <div>
      <PageHeader title="Datasets" description="Curated example collections for offline evals and experiments." />
      {isLoading ? (
        <Skeleton className="h-64 w-full" />
      ) : error ? (
        <EmptyState title="Failed to load datasets" description={String(error)} />
      ) : !datasets || datasets.length === 0 ? (
        <EmptyState
          icon={Database}
          title="No datasets yet"
          description="Create one with POST /v1/datasets or the SDK."
        />
      ) : (
        <DataTable columns={columns} data={datasets} filterColumn="name" filterPlaceholder="Filter datasets…" />
      )}
    </div>
  );
}
