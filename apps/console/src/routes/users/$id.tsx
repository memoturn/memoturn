import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { Activity, Coins, DollarSign } from "lucide-react";
import { EmptyState } from "../../components/empty-state";
import { PageHeader } from "../../components/page-header";
import { ScoreBadges } from "../../components/score-badges";
import { StatTile } from "../../components/stat-tile";
import { TracePeekDrawer } from "../../components/trace-peek-drawer";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "../../components/ui/breadcrumb";
import { Skeleton } from "../../components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../components/ui/table";
import { api } from "../../lib/api";

interface UserSearch {
  peek?: string;
}

export const Route = createFileRoute("/users/$id")({
  validateSearch: (s: Record<string, unknown>): UserSearch => ({
    peek: typeof s.peek === "string" && s.peek ? s.peek : undefined,
  }),
  component: UserDetailPage,
});

function fmtCost(n: number): string {
  return n > 0 ? `$${n.toFixed(6)}` : "—";
}

function UserDetailPage() {
  const { id } = Route.useParams();
  const { peek } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const setPeek = (pid: string | undefined) => navigate({ search: (prev) => ({ ...prev, peek: pid }) });

  const { data, isLoading, error } = useQuery({
    queryKey: ["user-traces", id],
    queryFn: () => api.listTracesPage({ userId: id, pageSize: 500 }),
  });
  const traces = data?.data;
  const scores = data?.scores ?? {};

  const totalTokens = traces?.reduce((a, t) => a + Number(t.total_tokens), 0) ?? 0;
  const totalCost = traces?.reduce((a, t) => a + Number(t.total_cost), 0) ?? 0;

  return (
    <div className="space-y-4">
      <Breadcrumb>
        <BreadcrumbList>
          <BreadcrumbItem>
            <BreadcrumbLink asChild>
              <Link to="/users">Users</Link>
            </BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbPage className="max-w-[40ch] truncate">{id}</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>

      <PageHeader title={`User ${id}`} description="Traces from this end user — click a row to preview." />

      {isLoading ? (
        <Skeleton className="h-64 w-full" />
      ) : error ? (
        <EmptyState title="Failed to load traces" description={String(error)} />
      ) : !traces || traces.length === 0 ? (
        <EmptyState icon={Activity} title="No traces for this user" description="This user has no traces yet." />
      ) : (
        <div className="space-y-4">
          <div className="grid grid-cols-3 gap-4 sm:max-w-xl">
            <StatTile label="Traces" value={traces.length} icon={Activity} />
            <StatTile label="Tokens" value={totalTokens} icon={Coins} />
            <StatTile label="Cost" value={fmtCost(totalCost)} icon={DollarSign} />
          </div>

          <div className="border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Trace Name</TableHead>
                  <TableHead>Trace ID</TableHead>
                  <TableHead>Timestamp</TableHead>
                  <TableHead>Tokens</TableHead>
                  <TableHead>Cost</TableHead>
                  <TableHead>Latency</TableHead>
                  <TableHead>Scores</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {traces.map((t) => (
                  <TableRow
                    key={t.id}
                    data-state={peek === t.id ? "selected" : undefined}
                    onClick={() => setPeek(t.id)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") setPeek(t.id);
                    }}
                    tabIndex={0}
                    className="cursor-pointer"
                  >
                    <TableCell>
                      <span className="font-medium text-primary">{t.name || "(unnamed trace)"}</span>
                    </TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">{t.id}</TableCell>
                    <TableCell className="text-muted-foreground">{t.timestamp}</TableCell>
                    <TableCell className="tabular-nums">{Number(t.total_tokens).toLocaleString()}</TableCell>
                    <TableCell className="tabular-nums">{fmtCost(Number(t.total_cost))}</TableCell>
                    <TableCell className="tabular-nums">{t.latency_ms} ms</TableCell>
                    <TableCell>
                      <ScoreBadges scores={scores[t.id] ?? []} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>
      )}

      <TracePeekDrawer traces={traces} peekId={peek} onPeek={setPeek} />
    </div>
  );
}
