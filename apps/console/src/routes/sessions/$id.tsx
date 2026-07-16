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

interface SessionSearch {
  peek?: string;
}

export const Route = createFileRoute("/sessions/$id")({
  validateSearch: (s: Record<string, unknown>): SessionSearch => ({
    peek: typeof s.peek === "string" && s.peek ? s.peek : undefined,
  }),
  component: SessionDetailPage,
});

function fmtCost(n: number): string {
  return n > 0 ? `$${n.toFixed(6)}` : "—";
}

function SessionDetailPage() {
  const { id } = Route.useParams();
  const { peek } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const setPeek = (pid: string | undefined) => navigate({ search: (prev) => ({ ...prev, peek: pid }) });

  const { data, isLoading, error } = useQuery({
    queryKey: ["session-traces", id],
    queryFn: () => api.listTracesPage({ sessionId: id, pageSize: 500 }),
  });
  const traces = data?.data;
  const scores = data?.scores ?? {};

  // Show the session as a conversation — oldest trace first (the list query returns newest-first).
  const ordered = traces ? [...traces].sort((a, b) => a.timestamp.localeCompare(b.timestamp)) : undefined;
  const totalTokens = ordered?.reduce((a, t) => a + Number(t.total_tokens), 0) ?? 0;
  const totalCost = ordered?.reduce((a, t) => a + Number(t.total_cost), 0) ?? 0;

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
            <BreadcrumbPage className="max-w-[40ch] truncate">{id}</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>

      <PageHeader
        title={`Session ${id}`}
        description="Traces sharing this session id — click a row to preview."
        help="All traces that share this session id, ordered oldest-first so the session reads like a conversation."
      />

      {isLoading ? (
        <Skeleton className="h-64 w-full" />
      ) : error ? (
        <EmptyState title="Failed to load traces" description={String(error)} />
      ) : !ordered || ordered.length === 0 ? (
        <EmptyState icon={Activity} title="No traces in this session" description="This session has no traces yet." />
      ) : (
        <div className="space-y-4">
          <div className="grid grid-cols-3 gap-4 sm:max-w-xl">
            <StatTile label="Traces" value={ordered.length} icon={Activity} help="Number of traces in this session." />
            <StatTile
              label="Tokens"
              value={totalTokens}
              icon={Coins}
              help="Total input plus output tokens across this session's traces."
            />
            <StatTile
              label="Cost"
              value={fmtCost(totalCost)}
              icon={DollarSign}
              help="Estimated spend for this session, from the model price table."
            />
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
                {ordered.map((t) => (
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

      <TracePeekDrawer traces={ordered} peekId={peek} onPeek={setPeek} />
    </div>
  );
}
