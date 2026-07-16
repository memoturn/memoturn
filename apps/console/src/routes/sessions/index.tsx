import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Activity, DollarSign, MessageSquare } from "lucide-react";
import { EmptyState } from "../../components/empty-state";
import { PageHeader } from "../../components/page-header";
import { StatTile } from "../../components/stat-tile";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../components/ui/select";
import { Skeleton } from "../../components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../components/ui/table";
import { api } from "../../lib/api";
import { useRangeDays } from "../../lib/timeRange";

interface SessionSearch {
  page?: number;
  pageSize?: number;
  search?: string;
}

const posInt = (v: unknown) => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n > 0 ? n : undefined;
};

const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);

const PAGE_SIZES = [25, 50, 100];
const DEFAULT_PAGE_SIZE = 50;

export const Route = createFileRoute("/sessions/")({
  validateSearch: (s: Record<string, unknown>): SessionSearch => ({
    page: posInt(s.page),
    pageSize: posInt(s.pageSize),
    search: str(s.search),
  }),
  component: SessionsPage,
});

const money = (n: number) => (n > 0 ? `$${n.toFixed(4)}` : "—");

function SessionsPage() {
  const { page: pageRaw, pageSize: pageSizeRaw, search } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const days = useRangeDays();
  const page = pageRaw ?? 1;
  const pageSize = pageSizeRaw ?? DEFAULT_PAGE_SIZE;

  const {
    data: pageData,
    isLoading,
    error,
  } = useQuery({
    queryKey: ["sessions", page, pageSize, days, search],
    queryFn: () => api.listSessionsPage({ page, pageSize, days, search }),
    refetchInterval: 5_000,
    placeholderData: keepPreviousData,
  });
  const sessions = pageData?.data;
  const total = pageData?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));

  const setPage = (p: number) => navigate({ search: (prev) => ({ ...prev, page: p > 1 ? p : undefined }) });
  const setPageSize = (s: number) =>
    navigate({ search: (prev) => ({ ...prev, pageSize: s !== DEFAULT_PAGE_SIZE ? s : undefined, page: undefined }) });
  const setSearch = (v: string) =>
    navigate({ search: (prev) => ({ ...prev, search: v || undefined, page: undefined }) });

  return (
    <div className="space-y-4">
      <PageHeader
        title="Sessions"
        description="Grouped traces sharing a session id."
        help="A session groups every trace that shares the same session id, letting you follow a full multi-turn conversation."
      />

      <Input
        type="search"
        placeholder="Search by session id…"
        defaultValue={search ?? ""}
        onChange={(e) => setSearch(e.target.value)}
        className="h-9 max-w-xs"
      />

      {(isLoading || (sessions && sessions.length > 0)) && (
        <div className="grid grid-cols-3 gap-4 sm:max-w-xl">
          <StatTile
            label="Sessions"
            value={sessions ? total : <Skeleton className="h-6 w-16" />}
            icon={MessageSquare}
            help="Total sessions (distinct session ids) in the selected time range."
          />
          <StatTile
            label="Traces (page)"
            value={
              sessions ? sessions.reduce((a, s) => a + Number(s.trace_count), 0) : <Skeleton className="h-6 w-16" />
            }
            icon={Activity}
            help="Sum of traces across the sessions shown on this page."
          />
          <StatTile
            label="Cost (page)"
            value={
              sessions ? (
                money(sessions.reduce((a, s) => a + Number(s.total_cost), 0))
              ) : (
                <Skeleton className="h-6 w-16" />
              )
            }
            icon={DollarSign}
            help="Estimated spend for the sessions on this page, from the model price table."
          />
        </div>
      )}

      {isLoading ? (
        <Skeleton className="h-64 w-full" />
      ) : error ? (
        <EmptyState title="Failed to load sessions" description={String(error)} />
      ) : !sessions || sessions.length === 0 ? (
        <EmptyState
          icon={MessageSquare}
          title={search ? "No matching sessions" : "No sessions yet"}
          description={
            search ? `No session id matches “${search}”.` : "Sessions appear when traces share a session id."
          }
        />
      ) : (
        <>
          <div className="border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Session</TableHead>
                  <TableHead>Traces</TableHead>
                  <TableHead>Cost</TableHead>
                  <TableHead>First seen</TableHead>
                  <TableHead>Last seen</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sessions.map((s) => (
                  <TableRow
                    key={s.session_id}
                    onClick={() => navigate({ to: "/sessions/$id", params: { id: s.session_id } })}
                    className="cursor-pointer"
                  >
                    <TableCell>
                      <span className="font-medium text-primary">{s.session_id}</span>
                    </TableCell>
                    <TableCell>{s.trace_count}</TableCell>
                    <TableCell>{money(Number(s.total_cost))}</TableCell>
                    <TableCell className="text-muted-foreground">{s.first_seen}</TableCell>
                    <TableCell className="text-muted-foreground">{s.last_seen}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          {total > 0 && (
            <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
              <span className="text-muted-foreground">
                {(page - 1) * pageSize + 1}–{Math.min(page * pageSize, total)} of {total}
              </span>
              <div className="flex items-center gap-2">
                <span className="text-muted-foreground">Rows</span>
                <Select value={String(pageSize)} onValueChange={(v) => setPageSize(Number(v))}>
                  <SelectTrigger size="sm" className="w-[4.5rem]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {PAGE_SIZES.map((s) => (
                      <SelectItem key={s} value={String(s)}>
                        {s}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>
                  Prev
                </Button>
                <span className="tabular-nums text-muted-foreground">
                  Page {page} / {pageCount}
                </span>
                <Button variant="outline" size="sm" disabled={page >= pageCount} onClick={() => setPage(page + 1)}>
                  Next
                </Button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
