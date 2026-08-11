import { filterState, OBSERVATION_FILTER_COLUMNS, type SingleFilter } from "@memoturn/contracts";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Clock, Coins, DollarSign, Layers } from "lucide-react";
import { EmptyState } from "../components/empty-state";
import { FilterBuilder } from "../components/filter-builder";
import { KindBadge, toneForKind } from "../components/kind-badge";
import { PageHeader } from "../components/page-header";
import { StatTile } from "../components/stat-tile";
import { Timestamp } from "../components/timestamp";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { Skeleton } from "../components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";
import { api, type FacetCount } from "../lib/api";
import { useRangeDays } from "../lib/timeRange";

/**
 * The span-level explorer. The traces list answers "which runs went wrong"; this answers
 * "which spans are slow / erroring / on model X", across every trace in the project — the
 * question you can't ask when an observation is only reachable through its parent trace.
 *
 * Filters are URL state (shareable), and every predicate resolves against the observation row.
 */

interface ObservationSearch {
  search?: string;
  type?: string;
  level?: string;
  model?: string;
  environment?: string;
  traceId?: string;
  /** JSON-encoded structured filter set (the power-path FilterBuilder). */
  filter?: string;
  page?: number;
  pageSize?: number;
}

const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
const posInt = (v: unknown) => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n > 0 ? n : undefined;
};

const PAGE_SIZES = [25, 50, 100];
const DEFAULT_PAGE_SIZE = 50;

export const Route = createFileRoute("/observations")({
  validateSearch: (s: Record<string, unknown>): ObservationSearch => ({
    search: str(s.search),
    type: str(s.type),
    level: str(s.level),
    model: str(s.model),
    environment: str(s.environment),
    traceId: str(s.traceId),
    filter: str(s.filter),
    page: posInt(s.page),
    pageSize: posInt(s.pageSize),
  }),
  component: ObservationsPage,
});

const money = (n: number) => (n > 0 ? `$${n.toFixed(6)}` : "—");
const ms = (n: number) => (n > 0 ? `${n.toLocaleString()} ms` : "—");

/** A facet-backed dropdown: "any" clears the filter, every other option narrows it. */
function FacetSelect({
  label,
  value,
  items,
  onChange,
}: {
  label: string;
  value?: string;
  items?: FacetCount[];
  onChange: (v: string) => void;
}) {
  return (
    <Select value={value ?? "__any"} onValueChange={(v) => onChange(v === "__any" ? "" : v)}>
      <SelectTrigger size="sm" className="w-[10rem]">
        <SelectValue placeholder={label} />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="__any">{label}: any</SelectItem>
        {(items ?? []).map((it) => (
          <SelectItem key={it.value} value={it.value}>
            {it.value} ({it.count})
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function ObservationsPage() {
  const filters = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const days = useRangeDays();

  const { page: pageRaw, pageSize: pageSizeRaw, ...listFilters } = filters;
  const page = pageRaw ?? 1;
  const pageSize = pageSizeRaw ?? DEFAULT_PAGE_SIZE;

  const {
    data: pageData,
    isLoading,
    error,
  } = useQuery({
    queryKey: ["observations", listFilters, days, page, pageSize],
    queryFn: () => api.listObservationsPage({ ...listFilters, days, page, pageSize }),
    refetchInterval: 10_000,
    placeholderData: keepPreviousData,
  });
  // Counts are facet-excluding server-side, so a selected value still shows its alternatives.
  const { data: facets } = useQuery({
    queryKey: ["observation-facets", listFilters, days],
    queryFn: () => api.observationFacets({ ...listFilters, days, limit: 25 }),
    placeholderData: keepPreviousData,
  });

  const rows = pageData?.data;
  const total = pageData?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));

  // Any filter change resets to page 1 — the old page number rarely means the same thing.
  const setFilter = (key: keyof ObservationSearch, value: string) =>
    navigate({ search: (prev) => ({ ...prev, [key]: value || undefined, page: undefined }) });
  const setPage = (p: number) => navigate({ search: (prev) => ({ ...prev, page: p > 1 ? p : undefined }) });
  const setPageSize = (s: number) =>
    navigate({ search: (prev) => ({ ...prev, pageSize: s !== DEFAULT_PAGE_SIZE ? s : undefined, page: undefined }) });

  // The structured filter set lives in the URL as JSON; a malformed value degrades to empty.
  const filterSet: SingleFilter[] = (() => {
    if (!filters.filter) return [];
    try {
      const parsed = filterState.safeParse(JSON.parse(filters.filter));
      return parsed.success ? parsed.data : [];
    } catch {
      return [];
    }
  })();
  const setFilterSet = (next: SingleFilter[]) => setFilter("filter", next.length ? JSON.stringify(next) : "");

  return (
    <div className="space-y-4">
      <PageHeader
        title="Spans"
        description="Every observation across your traces, filtered on the span itself."
        help="A span (observation) is one step inside a trace — a generation, a tool call, a retrieval. This view searches them directly, so you can ask questions like “every retriever span over 2s this week” that the trace list can't express."
      />

      <div className="flex flex-wrap items-center gap-2">
        <Input
          type="search"
          placeholder="Search name or content…"
          defaultValue={filters.search ?? ""}
          onChange={(e) => setFilter("search", e.target.value)}
          className="h-9 max-w-xs"
        />
        <FacetSelect label="Type" value={filters.type} items={facets?.types} onChange={(v) => setFilter("type", v)} />
        <FacetSelect
          label="Level"
          value={filters.level}
          items={facets?.levels}
          onChange={(v) => setFilter("level", v)}
        />
        <FacetSelect
          label="Model"
          value={filters.model}
          items={facets?.models}
          onChange={(v) => setFilter("model", v)}
        />
        <FacetSelect
          label="Env"
          value={filters.environment}
          items={facets?.environments}
          onChange={(v) => setFilter("environment", v)}
        />
        <span className="mx-1 h-4 w-px bg-border" aria-hidden />
        <FilterBuilder value={filterSet} onChange={setFilterSet} columns={OBSERVATION_FILTER_COLUMNS} />
      </div>

      {filters.traceId && (
        <div className="flex items-center gap-2 text-sm">
          <span className="text-muted-foreground">Scoped to trace</span>
          <KindBadge tone="blue">{filters.traceId}</KindBadge>
          <Button variant="ghost" size="sm" className="h-6" onClick={() => setFilter("traceId", "")}>
            clear
          </Button>
        </div>
      )}

      {(isLoading || (rows && rows.length > 0)) && (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatTile
            label="Spans"
            value={rows ? total.toLocaleString() : <Skeleton className="h-6 w-16" />}
            icon={Layers}
            help="Total spans matching the current filters."
          />
          <StatTile
            label="Tokens (page)"
            value={rows ? rows.reduce((a, o) => a + Number(o.total_tokens), 0) : <Skeleton className="h-6 w-16" />}
            icon={Coins}
            help="Sum of tokens for the spans shown on this page only."
          />
          <StatTile
            label="Cost (page)"
            value={rows ? money(rows.reduce((a, o) => a + Number(o.total_cost), 0)) : <Skeleton className="h-6 w-16" />}
            icon={DollarSign}
            help="Estimated spend for the spans on this page, from the model price table."
          />
          <StatTile
            label="Slowest (page)"
            value={rows ? ms(Math.max(0, ...rows.map((o) => Number(o.latency_ms)))) : <Skeleton className="h-6 w-16" />}
            icon={Clock}
            help="The longest span latency on this page."
          />
        </div>
      )}

      {isLoading ? (
        <Skeleton className="h-64 w-full" />
      ) : error ? (
        <EmptyState title="Failed to load spans" description={String(error)} />
      ) : !rows || rows.length === 0 ? (
        <EmptyState
          icon={Layers}
          title="No matching spans"
          description="Widen the time range, or clear a filter. Spans appear as traces are ingested."
        />
      ) : (
        <>
          <div className="border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Level</TableHead>
                  <TableHead>Model</TableHead>
                  <TableHead className="text-right">Latency</TableHead>
                  <TableHead className="text-right">Tokens</TableHead>
                  <TableHead className="text-right">Cost</TableHead>
                  <TableHead>Start</TableHead>
                  <TableHead>Trace</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((o) => (
                  <TableRow
                    key={o.id}
                    className="cursor-pointer"
                    // Open the span in its trace — the explorer finds it, the waterfall explains it.
                    onClick={() =>
                      navigate({ to: "/traces/$id", params: { id: o.trace_id }, search: { observation: o.id } })
                    }
                  >
                    <TableCell className="max-w-[18rem] truncate font-medium">{o.name || "(unnamed)"}</TableCell>
                    <TableCell>
                      <KindBadge tone={toneForKind(o.type)}>{o.type}</KindBadge>
                    </TableCell>
                    <TableCell>
                      {o.level && o.level !== "DEFAULT" ? (
                        <KindBadge tone={toneForKind(o.level)}>{o.level}</KindBadge>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell className="max-w-[12rem] truncate text-muted-foreground">{o.model || "—"}</TableCell>
                    <TableCell className="text-right tabular-nums">{ms(Number(o.latency_ms))}</TableCell>
                    <TableCell className="text-right tabular-nums">{Number(o.total_tokens) || "—"}</TableCell>
                    <TableCell className="text-right tabular-nums">{money(Number(o.total_cost))}</TableCell>
                    <TableCell className="text-muted-foreground">
                      <Timestamp value={o.start_time} />
                    </TableCell>
                    <TableCell className="max-w-[12rem] truncate text-primary">{o.trace_name || o.trace_id}</TableCell>
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
