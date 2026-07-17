import { filterState, type SingleFilter } from "@memoturn/contracts";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@memoturn/ui";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import {
  Activity,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Coins,
  Columns3,
  DollarSign,
  Download,
  GitCompare,
  Rows2,
  Rows3,
  Save,
  SlidersHorizontal,
  X,
} from "lucide-react";
import { Fragment, type ReactNode, useMemo, useState } from "react";
import { toast } from "sonner";
import { EmptyState } from "../../components/empty-state";
import { FilterBuilder } from "../../components/filter-builder";
import { HelpTip } from "../../components/help-tip";
import { KindBadge, toneForKind } from "../../components/kind-badge";
import { PageHeader } from "../../components/page-header";
import { ScoreBadges } from "../../components/score-badges";
import { StatTile } from "../../components/stat-tile";
import { TracePeekDrawer } from "../../components/trace-peek-drawer";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Checkbox } from "../../components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../../components/ui/dropdown-menu";
import { Input } from "../../components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../components/ui/select";
import { Skeleton } from "../../components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../components/ui/table";
import { VolumeHistogram } from "../../components/volume-histogram";
import { api, downloadTracesExport, type FacetCount, type TraceSummary } from "../../lib/api";
import { useIsReadOnly } from "../../lib/role";
import { useRangeDays } from "../../lib/timeRange";
import { cn } from "../../lib/utils";

interface TraceSearch {
  search?: string;
  environment?: string;
  userId?: string;
  tag?: string;
  scoreName?: string;
  level?: string;
  type?: string;
  // JSON-encoded structured filter set (the power-path FilterBuilder). Kept as a string in the
  // URL; decoded to SingleFilter[] for the builder and passed verbatim to the API as `filter`.
  filter?: string;
  // Open trace id — drives the deep-linkable peek drawer, separate from filters.
  peek?: string;
  // Pagination (1-based). Defaults (page 1 / size 50) are kept out of the URL to keep it clean.
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

export const Route = createFileRoute("/traces/")({
  // Filters live in the URL so they're shareable/bookmarkable (deep linkable).
  validateSearch: (s: Record<string, unknown>): TraceSearch => ({
    search: str(s.search),
    environment: str(s.environment),
    userId: str(s.userId),
    tag: str(s.tag),
    scoreName: str(s.scoreName),
    level: str(s.level),
    type: str(s.type),
    filter: str(s.filter),
    peek: str(s.peek),
    page: posInt(s.page),
    pageSize: posInt(s.pageSize),
  }),
  component: TracesPage,
});

function fmtCost(n: number): string {
  return n > 0 ? `$${n.toFixed(6)}` : "—";
}

// Toggleable + reorderable trace columns (Name is the identity column and always shown first).
const TRACE_COLUMNS = [
  { key: "timestamp", label: "Timestamp", cellClass: "text-muted-foreground" },
  { key: "obs", label: "Obs", cellClass: "tabular-nums" },
  { key: "tokens", label: "Tokens", cellClass: "tabular-nums" },
  { key: "cost", label: "Cost", cellClass: "tabular-nums" },
  { key: "latency", label: "Latency", cellClass: "tabular-nums" },
  { key: "scores", label: "Scores" },
  { key: "env", label: "Env" },
  { key: "tags", label: "Tags" },
] as const;
type ColKey = (typeof TRACE_COLUMNS)[number]["key"];
const COL_KEYS = TRACE_COLUMNS.map((c) => c.key) as ColKey[];
const COL_LABEL = Object.fromEntries(TRACE_COLUMNS.map((c) => [c.key, c.label])) as Record<ColKey, string>;
const COL_CLASS = Object.fromEntries(
  TRACE_COLUMNS.map((c) => [c.key, "cellClass" in c ? c.cellClass : undefined]),
) as Record<ColKey, string | undefined>;
const COL_STORAGE = "memoturn.traces.columns.v2"; // persisted { hidden, order }

/** Column visibility + order, persisted to localStorage. New columns append in their default slot. */
function useColumnPrefs() {
  const [prefs, setPrefs] = useState<{ hidden: ColKey[]; order: ColKey[] }>(() => {
    try {
      const raw = localStorage.getItem(COL_STORAGE);
      if (raw) {
        const p = JSON.parse(raw);
        return { hidden: Array.isArray(p.hidden) ? p.hidden : [], order: Array.isArray(p.order) ? p.order : [] };
      }
    } catch {
      /* ignore malformed prefs */
    }
    return { hidden: [], order: [] };
  });
  const persist = (next: { hidden: ColKey[]; order: ColKey[] }) => {
    try {
      localStorage.setItem(COL_STORAGE, JSON.stringify(next));
    } catch {
      /* storage unavailable */
    }
    setPrefs(next);
  };
  // Effective order: stored (valid) keys first, then any columns not yet in the stored order.
  const stored = prefs.order.filter((k): k is ColKey => COL_KEYS.includes(k));
  const order = [...stored, ...COL_KEYS.filter((k) => !stored.includes(k))];
  const hidden = new Set(prefs.hidden.filter((k): k is ColKey => COL_KEYS.includes(k)));

  const toggle = (key: ColKey) => {
    const h = new Set(hidden);
    if (h.has(key)) h.delete(key);
    else h.add(key);
    persist({ hidden: [...h], order });
  };
  const move = (key: ColKey, dir: -1 | 1) => {
    const i = order.indexOf(key);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= order.length) return;
    const next = [...order];
    [next[i], next[j]] = [next[j] as ColKey, next[i] as ColKey];
    persist({ hidden: [...hidden], order: next });
  };
  return { order, hidden, toggle, move };
}

/** localStorage-backed view preference (compact density, grouping), persisted across sessions. */
function usePersisted<T>(key: string, initial: T): [T, (v: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw != null ? (JSON.parse(raw) as T) : initial;
    } catch {
      return initial;
    }
  });
  const set = (v: T) => {
    try {
      localStorage.setItem(key, JSON.stringify(v));
    } catch {
      /* storage unavailable */
    }
    setValue(v);
  };
  return [value, set];
}

type GroupKey = "none" | "name" | "userId" | "environment" | "session_id";
const GROUP_LABEL: Record<GroupKey, string> = {
  none: "No grouping",
  name: "Group by name",
  userId: "Group by user",
  environment: "Group by environment",
  session_id: "Group by session",
};
/** Group-key value for a trace (empty string bucket rendered as a placeholder). */
function groupValue(t: TraceSummary, by: GroupKey): string {
  if (by === "name") return t.name || "(unnamed)";
  if (by === "userId") return t.user_id || "(no user)";
  if (by === "environment") return t.environment || "(none)";
  if (by === "session_id") return t.session_id || "(no session)";
  return "";
}

/** Columns dropdown: toggle visibility + reorder (▲/▼) per column. */
function ColumnsMenu({
  order,
  hidden,
  toggle,
  move,
}: {
  order: ColKey[];
  hidden: Set<ColKey>;
  toggle: (k: ColKey) => void;
  move: (k: ColKey, dir: -1 | 1) => void;
}) {
  const shown = order.length - hidden.size;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="gap-2">
          <Columns3 />
          Columns
          <span className="tabular-nums text-muted-foreground">
            {shown}/{order.length}
          </span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        <DropdownMenuLabel>Columns — toggle &amp; reorder</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {order.map((key, i) => (
          <div key={key} className="flex items-center gap-2 px-2 py-1 text-sm">
            <Checkbox
              checked={!hidden.has(key)}
              onCheckedChange={() => toggle(key)}
              aria-label={`Toggle ${COL_LABEL[key]}`}
            />
            <span className="flex-1">{COL_LABEL[key]}</span>
            <button
              type="button"
              disabled={i === 0}
              onClick={() => move(key, -1)}
              className="text-muted-foreground hover:text-foreground disabled:opacity-30"
              aria-label={`Move ${COL_LABEL[key]} up`}
            >
              <ChevronUp className="size-3.5" />
            </button>
            <button
              type="button"
              disabled={i === order.length - 1}
              onClick={() => move(key, 1)}
              className="text-muted-foreground hover:text-foreground disabled:opacity-30"
              aria-label={`Move ${COL_LABEL[key]} down`}
            >
              <ChevronDown className="size-3.5" />
            </button>
          </div>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** One facet dimension: a labeled list of value/count rows; the active value is highlighted. */
function FacetSection({
  title,
  items,
  active,
  onPick,
}: {
  title: string;
  items: FacetCount[] | undefined;
  active?: string;
  onPick: (value: string) => void;
}) {
  return (
    <div>
      <div className="mb-1 text-[0.6875rem] font-medium tracking-wide text-muted-foreground uppercase">{title}</div>
      {!items ? (
        <div className="space-y-1">
          <Skeleton className="h-5 w-full" />
          <Skeleton className="h-5 w-3/4" />
        </div>
      ) : items.length === 0 ? (
        <div className="px-2 py-1 text-xs text-muted-foreground">None</div>
      ) : (
        <div className="space-y-0.5">
          {items.map((it) => {
            const on = active === it.value;
            return (
              <button
                key={it.value}
                type="button"
                onClick={() => onPick(it.value)}
                title={`${it.value} · ${it.count}`}
                className={cn(
                  "flex w-full items-center justify-between gap-2 rounded px-2 py-1 text-left text-xs transition-colors",
                  on
                    ? "bg-primary/10 font-medium text-foreground"
                    : "text-muted-foreground hover:bg-muted hover:text-foreground",
                )}
              >
                <span className="truncate">{it.value}</span>
                <span className="shrink-0 tabular-nums text-muted-foreground">{it.count}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

type FacetProps = {
  days: number;
  environment?: string;
  search?: string;
  userId?: string;
  tag?: string;
  scoreName?: string;
  level?: string;
  type?: string;
  onPick: (key: "environment" | "search" | "tag" | "scoreName" | "level" | "type", value: string) => void;
};

/** The facet sections — shared by the desktop rail and the mobile Filters sheet. */
function FacetSections({ days, environment, search, userId, tag, scoreName, level, type, onPick }: FacetProps) {
  // Counts are facet-excluding server-side; passing the active filters makes them narrow live.
  const { data } = useQuery({
    queryKey: ["trace-facets", days, environment, search, userId, tag, scoreName, level, type],
    queryFn: () => api.traceFacets({ days, limit: 25, environment, search, userId, tag, scoreName, level, type }),
    refetchInterval: 15_000,
    // Keep the current counts on screen while the next set loads — no skeleton flash on select.
    placeholderData: keepPreviousData,
  });
  return (
    <div className="space-y-4">
      <FacetSection
        title="Environment"
        items={data?.environments}
        active={environment}
        onPick={(v) => onPick("environment", v)}
      />
      <FacetSection title="Type" items={data?.types} active={type} onPick={(v) => onPick("type", v)} />
      <FacetSection title="Level" items={data?.levels} active={level} onPick={(v) => onPick("level", v)} />
      <FacetSection title="Name" items={data?.names} active={search} onPick={(v) => onPick("search", v)} />
      <FacetSection title="Scores" items={data?.scores} active={scoreName} onPick={(v) => onPick("scoreName", v)} />
      <FacetSection title="Tags" items={data?.tags} active={tag} onPick={(v) => onPick("tag", v)} />
    </div>
  );
}

/** Desktop filter rail — sticky so it stays put while the table scrolls. */
function FacetPanel(props: FacetProps) {
  return (
    <aside className="sticky top-4 hidden max-h-[calc(100svh-2rem)] w-56 shrink-0 self-start overflow-y-auto lg:block">
      <div className="mb-3 flex items-center gap-1.5 text-sm font-medium">
        Filters
        <HelpTip>
          Click a value in any section to narrow the list; counts update to reflect the other active filters.
        </HelpTip>
      </div>
      <FacetSections {...props} />
    </aside>
  );
}

function TracesPage() {
  const filters = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const days = useRangeDays();
  const readOnly = useIsReadOnly();
  const qc = useQueryClient();
  const { order, hidden, toggle: toggleColumn, move: moveColumn } = useColumnPrefs();
  const [compact, setCompact] = usePersisted("memoturn.traces.compact", false);
  const [groupBy, setGroupBy] = usePersisted<GroupKey>("memoturn.traces.groupBy", "none");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const toggleCollapse = (k: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  const visibleCols = order.filter((k) => !hidden.has(k));

  // `peek`/`page`/`pageSize` are view state, not filters — keep them out of the list query's
  // filter object (so facets/saved views use only real filters), but page/size do drive the query.
  const { peek, page: pageRaw, pageSize: pageSizeRaw, ...listFilters } = filters;
  const page = pageRaw ?? 1;
  const pageSize = pageSizeRaw ?? DEFAULT_PAGE_SIZE;

  const {
    data: pageData,
    isLoading,
    error,
  } = useQuery({
    queryKey: ["traces", listFilters, days, page, pageSize],
    queryFn: () => api.listTracesPage({ ...listFilters, days, page, pageSize }),
    refetchInterval: 5_000,
    // Keep the prior page/filter results on screen while the next loads — no blank flash on paging.
    placeholderData: keepPreviousData,
  });
  const traces = pageData?.data;
  const total = pageData?.total ?? 0;
  const scores = pageData?.scores ?? {};

  // Group the current page's rows by the chosen field (first-seen order). "none" → one implicit group.
  const grouped = useMemo(() => {
    if (!traces) return [];
    if (groupBy === "none") return [{ key: "", rows: traces }];
    const m = new Map<string, TraceSummary[]>();
    for (const t of traces) {
      const k = groupValue(t, groupBy);
      const arr = m.get(k);
      if (arr) arr.push(t);
      else m.set(k, [t]);
    }
    return [...m.entries()].map(([key, rows]) => ({ key, rows }));
  }, [traces, groupBy]);
  const pageCount = Math.max(1, Math.ceil(total / pageSize));

  // Changing a filter resets to page 1 (the old offset would point past the new result set).
  const setFilter = (key: keyof TraceSearch, value: string) => {
    navigate({ search: (prev) => ({ ...prev, [key]: value || undefined, page: undefined }) });
  };

  // Structured (power-path) filter set — stored JSON-encoded in the URL, re-validated on decode.
  const filterSet = useMemo<SingleFilter[]>(() => {
    if (!filters.filter) return [];
    try {
      const parsed = filterState.safeParse(JSON.parse(filters.filter));
      return parsed.success ? parsed.data : [];
    } catch {
      return [];
    }
  }, [filters.filter]);
  const setFilterSet = (next: SingleFilter[]) =>
    navigate({
      search: (prev) => ({ ...prev, filter: next.length ? JSON.stringify(next) : undefined, page: undefined }),
    });

  // Per-column cell renderers — the table header/body iterate `visibleCols` in the persisted order.
  const cellContent: Record<ColKey, (t: TraceSummary) => ReactNode> = {
    timestamp: (t) => t.timestamp,
    obs: (t) => Number(t.observation_count).toLocaleString(),
    tokens: (t) => Number(t.total_tokens).toLocaleString(),
    cost: (t) => fmtCost(Number(t.total_cost)),
    latency: (t) => `${t.latency_ms} ms`,
    scores: (t) => <ScoreBadges scores={scores[t.id] ?? []} onPick={(name) => setFilter("scoreName", name)} />,
    env: (t) => <Badge variant="secondary">{t.environment}</Badge>,
    tags: (t) => (
      <div className="flex flex-wrap gap-1">
        {t.tags.map((tag) => (
          <button
            key={tag}
            type="button"
            className="border bg-muted px-1.5 py-0.5 text-xs text-muted-foreground hover:text-foreground"
            onClick={(e) => {
              e.stopPropagation();
              setFilter("tag", tag);
            }}
            title="Filter by tag"
          >
            {tag}
          </button>
        ))}
      </div>
    ),
  };
  const setPage = (p: number) => navigate({ search: (prev) => ({ ...prev, page: p > 1 ? p : undefined }) });
  const setPageSize = (s: number) =>
    navigate({ search: (prev) => ({ ...prev, pageSize: s !== DEFAULT_PAGE_SIZE ? s : undefined, page: undefined }) });
  const hasFilters = Boolean(
    filters.search ||
      filters.environment ||
      filters.userId ||
      filters.tag ||
      filters.scoreName ||
      filters.level ||
      filters.type ||
      filters.filter,
  );

  // Facet click toggles the matching filter (name facet maps to the `search`/name filter).
  const pickFacet = (key: "environment" | "search" | "tag" | "scoreName" | "level" | "type", value: string) => {
    const current = filters[key];
    setFilter(key, current === value ? "" : value);
  };

  // Peek drawer: open a trace inline over the list, deep-linkable via ?peek= (drawer owns J/K nav).
  const setPeek = (id: string | undefined) => navigate({ search: (prev) => ({ ...prev, peek: id }) });

  const { data: savedViews } = useQuery({
    queryKey: ["saved-views", "traces"],
    queryFn: () => api.listSavedViews("traces"),
  });
  const saveView = useMutation({
    mutationFn: (name: string) => api.createSavedView({ name, table: "traces", filters: listFilters }),
    onSuccess: () => {
      toast.success("View saved");
      qc.invalidateQueries({ queryKey: ["saved-views", "traces"] });
    },
    onError: (e) => toast.error(`Failed to save view: ${String(e)}`),
  });
  const removeView = useMutation({
    mutationFn: (id: string) => api.deleteSavedView(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["saved-views", "traces"] }),
    onError: (e) => toast.error(`Failed to delete view: ${String(e)}`),
  });
  const applyView = (f: Record<string, unknown>) => navigate({ search: f as TraceSearch });
  const promptSaveView = () => {
    const name = window.prompt("Name this view");
    if (name) saveView.mutate(name);
  };

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [action, setAction] = useState("add-to-dataset");
  const [target, setTarget] = useState("");
  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const allShown = traces?.map((t) => t.id) ?? [];
  const allSelected = allShown.length > 0 && allShown.every((id) => selected.has(id));

  const runBatch = useMutation({
    mutationFn: async () => {
      if (action === "add-tag") {
        // Append the tag to each selected trace's existing tags (setTraceTags replaces the full set).
        const tag = target.trim();
        await Promise.all(
          [...selected].map((id) => {
            const t = traces?.find((x) => x.id === id);
            return api.setTraceTags(id, [...new Set([...(t?.tags ?? []), tag])]);
          }),
        );
        return;
      }
      await api.batchTraces({
        action,
        traceIds: [...selected],
        datasetName: action === "add-to-dataset" ? target : undefined,
        queueName: action === "review" ? target : undefined,
      });
    },
    onSuccess: () => {
      toast.success("Batch applied");
      setSelected(new Set());
      setTarget("");
      qc.invalidateQueries({ queryKey: ["traces"] });
      qc.invalidateQueries({ queryKey: ["trace-facets"] });
    },
    onError: (e) => toast.error(`Batch failed: ${String(e)}`),
  });
  const needsTarget = action === "add-to-dataset" || action === "review" || action === "add-tag";

  return (
    <div className="space-y-4">
      <PageHeader
        title="Traces"
        help="A trace is one end-to-end request through your app, with all of its nested spans, tokens, cost, and scores."
        actions={
          <>
            <Select value={groupBy} onValueChange={(v) => setGroupBy(v as GroupKey)}>
              <SelectTrigger size="sm" className="h-8 w-auto gap-1.5">
                <Rows3 className="size-4 text-muted-foreground" />
                <SelectValue />
              </SelectTrigger>
              <SelectContent align="end">
                {(Object.keys(GROUP_LABEL) as GroupKey[]).map((k) => (
                  <SelectItem key={k} value={k}>
                    {GROUP_LABEL[k]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <HelpTip>Cluster the rows on this page by name, user, environment, or session.</HelpTip>
            <Button
              variant={compact ? "default" : "outline"}
              size="sm"
              onClick={() => setCompact(!compact)}
              className="gap-2"
              title="Toggle compact row density"
            >
              <Rows2 />
              Compact
            </Button>
            <HelpTip>Toggle denser rows to fit more traces on screen.</HelpTip>
            <ColumnsMenu order={order} hidden={hidden} toggle={toggleColumn} move={moveColumn} />
            <Button variant="outline" size="sm" onClick={promptSaveView} disabled={readOnly} className="gap-2">
              <Save />
              Save view
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" className="gap-2">
                  <Download />
                  Export
                  <ChevronDown className="size-3.5 opacity-60" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuLabel>
                  Download {Math.min(total, 1000).toLocaleString()}
                  {total > 1000 ? ` of ${total.toLocaleString()}` : ""} traces
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => void downloadTracesExport("jsonl", { ...listFilters, days })}>
                  JSONL
                  <span className="ml-auto text-xs text-muted-foreground">.jsonl</span>
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => void downloadTracesExport("csv", { ...listFilters, days })}>
                  CSV
                  <span className="ml-auto text-xs text-muted-foreground">.csv</span>
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => void downloadTracesExport("parquet", { ...listFilters, days })}>
                  Parquet
                  <span className="ml-auto text-xs text-muted-foreground">.parquet</span>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        }
      />

      {(isLoading || (traces && traces.length > 0)) && (
        <div className="grid grid-cols-3 gap-4 sm:max-w-xl">
          <StatTile
            label="Traces"
            value={traces ? total : <Skeleton className="h-6 w-16" />}
            icon={Activity}
            help="Total traces matching the current filters and time range."
          />
          <StatTile
            label="Tokens (page)"
            value={traces ? traces.reduce((a, t) => a + Number(t.total_tokens), 0) : <Skeleton className="h-6 w-16" />}
            icon={Coins}
            help="Sum of tokens for the traces shown on this page only."
          />
          <StatTile
            label="Cost (page)"
            value={
              traces ? fmtCost(traces.reduce((a, t) => a + Number(t.total_cost), 0)) : <Skeleton className="h-6 w-16" />
            }
            icon={DollarSign}
            help="Estimated spend for the traces on this page, from the model price table."
          />
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {/* Mobile: the facet rail is hidden on small screens, so expose it via a sheet. */}
        <Sheet>
          <SheetTrigger asChild>
            <Button variant="outline" size="sm" className="gap-2 lg:hidden">
              <SlidersHorizontal />
              Filters
            </Button>
          </SheetTrigger>
          <SheetContent side="left" className="w-72 gap-0 overflow-y-auto p-0">
            <SheetHeader className="border-b">
              <SheetTitle>Filters</SheetTitle>
            </SheetHeader>
            <div className="p-4">
              <FacetSections
                days={days}
                environment={filters.environment}
                search={filters.search}
                userId={filters.userId}
                tag={filters.tag}
                scoreName={filters.scoreName}
                level={filters.level}
                type={filters.type}
                onPick={pickFacet}
              />
            </div>
          </SheetContent>
        </Sheet>
        <Input
          type="search"
          placeholder="Search name or content…"
          defaultValue={filters.search ?? ""}
          onChange={(e) => setFilter("search", e.target.value)}
          className="h-9 max-w-xs"
        />
        {/* Active-filter chips (environment / user / tag / score / level all set via the facet rail). */}
        {filters.environment && (
          <button type="button" onClick={() => setFilter("environment", "")} title="Clear environment filter">
            <KindBadge tone="neutral">env: {filters.environment} ✕</KindBadge>
          </button>
        )}
        {filters.userId && (
          <button type="button" onClick={() => setFilter("userId", "")} title="Clear user filter">
            <KindBadge tone="violet">user: {filters.userId} ✕</KindBadge>
          </button>
        )}
        {filters.tag && (
          <button type="button" onClick={() => setFilter("tag", "")} title="Clear tag filter">
            <KindBadge tone="blue">tag: {filters.tag} ✕</KindBadge>
          </button>
        )}
        {filters.scoreName && (
          <button type="button" onClick={() => setFilter("scoreName", "")} title="Clear score filter">
            <KindBadge tone="green">score: {filters.scoreName} ✕</KindBadge>
          </button>
        )}
        {filters.level && (
          <button type="button" onClick={() => setFilter("level", "")} title="Clear level filter">
            <KindBadge tone="amber">level: {filters.level} ✕</KindBadge>
          </button>
        )}
        {filters.type && (
          <button type="button" onClick={() => setFilter("type", "")} title="Clear type filter">
            <KindBadge tone={toneForKind(filters.type)}>type: {filters.type} ✕</KindBadge>
          </button>
        )}
        {hasFilters && (
          <Button variant="ghost" size="sm" onClick={() => navigate({ search: {} })}>
            Clear
          </Button>
        )}
      </div>

      {/* Quick-filter presets — one-click level filters. Slow/Costly presets await the Phase 2
          latency/cost filter builder (the current filter set has no numeric range fields). */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm text-muted-foreground">Quick filters:</span>
        <Button
          variant={filters.level === "ERROR" ? "secondary" : "outline"}
          size="sm"
          className="h-7"
          onClick={() => setFilter("level", filters.level === "ERROR" ? "" : "ERROR")}
        >
          <KindBadge tone="red" className="border-0 bg-transparent px-0">
            ●
          </KindBadge>
          Errors
        </Button>
        <Button
          variant={filters.level === "WARNING" ? "secondary" : "outline"}
          size="sm"
          className="h-7"
          onClick={() => setFilter("level", filters.level === "WARNING" ? "" : "WARNING")}
        >
          <KindBadge tone="amber" className="border-0 bg-transparent px-0">
            ●
          </KindBadge>
          Warnings
        </Button>
        <span className="mx-1 h-4 w-px bg-border" aria-hidden />
        <FilterBuilder value={filterSet} onChange={setFilterSet} />
      </div>

      {savedViews && savedViews.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm text-muted-foreground">Saved views:</span>
          {savedViews.map((v) => (
            <span key={v.id} className="inline-flex items-center gap-1 border bg-muted px-1.5 py-0.5">
              <button
                type="button"
                className="text-xs font-medium hover:underline"
                onClick={() => applyView(v.filters)}
                title="Apply this view"
              >
                {v.name}
              </button>
              <button
                type="button"
                className="text-muted-foreground hover:text-foreground"
                onClick={() => removeView.mutate(v.id)}
                title="Delete view"
              >
                <X className="size-3" />
              </button>
            </span>
          ))}
        </div>
      )}

      {selected.size > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/40 p-2">
          <strong className="text-sm">{selected.size} selected</strong>
          {selected.size === 2 && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                const [a, b] = [...selected];
                navigate({ to: "/traces/compare", search: { a, b } });
              }}
            >
              <GitCompare />
              Compare
            </Button>
          )}
          <Select value={action} onValueChange={setAction}>
            <SelectTrigger size="sm" className="w-[200px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="add-to-dataset">Add to dataset</SelectItem>
              <SelectItem value="review">Add to review queue</SelectItem>
              <SelectItem value="add-tag">Add tag</SelectItem>
              <SelectItem value="delete">Delete</SelectItem>
            </SelectContent>
          </Select>
          {needsTarget && (
            <Input
              placeholder={
                action === "add-to-dataset" ? "dataset name" : action === "add-tag" ? "tag name" : "review queue name"
              }
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              className="h-9 w-52"
            />
          )}
          <Button
            size="sm"
            disabled={readOnly || runBatch.isPending || (needsTarget && !target)}
            onClick={() => runBatch.mutate()}
          >
            {runBatch.isPending ? "Applying…" : "Apply"}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setSelected(new Set())}>
            Clear selection
          </Button>
        </div>
      )}

      <div className="flex gap-4">
        <FacetPanel
          days={days}
          environment={filters.environment}
          search={filters.search}
          userId={filters.userId}
          tag={filters.tag}
          scoreName={filters.scoreName}
          level={filters.level}
          type={filters.type}
          onPick={pickFacet}
        />
        <div className="min-w-0 flex-1 space-y-3">
          <VolumeHistogram filters={{ ...listFilters, days }} />
          {isLoading ? (
            <Skeleton className="h-64 w-full" />
          ) : error ? (
            <EmptyState title="Failed to load traces" description={String(error)} />
          ) : !traces || traces.length === 0 ? (
            <EmptyState
              title="No traces match"
              description="Run `bun run quickstart` to emit one, or adjust your filters."
            />
          ) : (
            <div className="border">
              <Table className={cn(compact && "[&_td]:py-1 [&_th]:py-1.5")}>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-10">
                      <Checkbox
                        checked={allSelected}
                        onCheckedChange={(c) => setSelected(c ? new Set(allShown) : new Set())}
                        aria-label="Select all shown"
                      />
                    </TableHead>
                    <TableHead>Name</TableHead>
                    {visibleCols.map((k) => (
                      <TableHead key={k}>
                        {k === "scores" ? (
                          <span className="inline-flex items-center gap-1">
                            {COL_LABEL[k]}
                            <HelpTip>Evaluation scores attached to the trace by evaluators or human review.</HelpTip>
                          </span>
                        ) : (
                          COL_LABEL[k]
                        )}
                      </TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {grouped.map((g) => (
                    <Fragment key={g.key || "__all"}>
                      {groupBy !== "none" && (
                        <TableRow className="bg-muted/40 hover:bg-muted/40">
                          <TableCell colSpan={2 + visibleCols.length} className="py-1.5">
                            <button
                              type="button"
                              onClick={() => toggleCollapse(g.key)}
                              className="inline-flex items-center gap-1.5 text-xs font-medium"
                            >
                              {collapsed.has(g.key) ? (
                                <ChevronRight className="size-3.5" />
                              ) : (
                                <ChevronDown className="size-3.5" />
                              )}
                              <span>{g.key}</span>
                              <span className="text-muted-foreground">({g.rows.length})</span>
                            </button>
                          </TableCell>
                        </TableRow>
                      )}
                      {!collapsed.has(g.key) &&
                        g.rows.map((t) => (
                          <TableRow
                            key={t.id}
                            data-state={selected.has(t.id) ? "selected" : peek === t.id ? "selected" : undefined}
                            onClick={() => setPeek(t.id)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") setPeek(t.id);
                            }}
                            tabIndex={0}
                            className="cursor-pointer"
                          >
                            <TableCell onClick={(e) => e.stopPropagation()}>
                              <Checkbox
                                checked={selected.has(t.id)}
                                onCheckedChange={() => toggle(t.id)}
                                aria-label={`Select ${t.name || t.id}`}
                              />
                            </TableCell>
                            <TableCell>
                              <span className="font-medium text-primary">{t.name || t.id.slice(0, 8)}</span>
                            </TableCell>
                            {visibleCols.map((k) => (
                              <TableCell key={k} className={COL_CLASS[k]}>
                                {cellContent[k](t)}
                              </TableCell>
                            ))}
                          </TableRow>
                        ))}
                    </Fragment>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
          {traces && total > 0 && (
            <div className="flex flex-wrap items-center justify-between gap-3 pt-3 text-sm">
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
        </div>
      </div>

      <TracePeekDrawer traces={traces} peekId={peek} onPeek={setPeek} />
    </div>
  );
}
