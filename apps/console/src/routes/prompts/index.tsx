import type { PromptListItem } from "@memoturn/contracts";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import type { ColumnDef } from "@tanstack/react-table";
import { FileText, GitBranch, Radio } from "lucide-react";
import { DataTable } from "../../components/data-table";
import { EmptyState } from "../../components/empty-state";
import { HelpTip } from "../../components/help-tip";
import { KindBadge } from "../../components/kind-badge";
import { PageHeader } from "../../components/page-header";
import { StatTile } from "../../components/stat-tile";
import { Skeleton } from "../../components/ui/skeleton";
import { api } from "../../lib/api";

export const Route = createFileRoute("/prompts/")({ component: PromptsPage });

const columns: ColumnDef<PromptListItem>[] = [
  {
    accessorKey: "name",
    header: "Name",
    cell: ({ row }) => (
      <Link
        to="/prompts/$name"
        params={{ name: row.original.name }}
        className="font-medium text-primary hover:underline"
        onClick={(e) => e.stopPropagation()}
      >
        {row.original.folder ? `${row.original.folder}/` : ""}
        {row.original.name}
      </Link>
    ),
  },
  {
    accessorKey: "latestVersion",
    header: "Latest",
    cell: ({ row }) => <KindBadge tone="blue">v{row.original.latestVersion}</KindBadge>,
  },
  { accessorKey: "versions", header: "Versions" },
  {
    id: "channels",
    header: () => (
      <span className="inline-flex items-center gap-1">
        Channels
        <HelpTip>
          A named deployment pointer (like "production") that resolves to a specific version, so code can request a
          channel instead of a fixed version number.
        </HelpTip>
      </span>
    ),
    cell: ({ row }) => (
      <div className="flex flex-wrap gap-1">
        {row.original.channels.map((c) => (
          <KindBadge key={c.label} tone="green">
            {c.label}→v{c.version}
          </KindBadge>
        ))}
      </div>
    ),
  },
  {
    accessorKey: "updatedAt",
    header: "Updated",
    cell: ({ row }) => row.original.updatedAt.slice(0, 19).replace("T", " "),
  },
];

function PromptsPage() {
  const {
    data: prompts,
    isLoading,
    error,
  } = useQuery({
    queryKey: ["prompts"],
    queryFn: () => api.listPrompts(),
    refetchInterval: 10_000,
  });

  return (
    <div>
      <PageHeader
        title="Prompts"
        description="Versioned prompt templates with deployment channels."
        help="Store prompt templates as versioned history and point named channels at specific versions so you can roll releases forward and back without changing code."
      />
      {isLoading ? (
        <Skeleton className="h-64 w-full" />
      ) : error ? (
        <EmptyState title="Failed to load prompts" description={String(error)} />
      ) : !prompts || prompts.length === 0 ? (
        <EmptyState icon={FileText} title="No prompts yet" description="Create one with POST /v1/prompts or the SDK." />
      ) : (
        <div className="space-y-6">
          <div className="grid grid-cols-3 gap-4 sm:max-w-xl">
            <StatTile label="Prompts" value={prompts.length} icon={FileText} />
            <StatTile label="Versions" value={prompts.reduce((a, p) => a + Number(p.versions), 0)} icon={GitBranch} />
            <StatTile label="Channels" value={prompts.reduce((a, p) => a + p.channels.length, 0)} icon={Radio} />
          </div>
          <DataTable columns={columns} data={prompts} filterColumn="name" filterPlaceholder="Filter prompts…" />
        </div>
      )}
    </div>
  );
}
