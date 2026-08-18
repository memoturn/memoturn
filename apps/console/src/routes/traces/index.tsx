import { type FilterColumnDef, filterState, type SingleFilter, TRACE_FILTER_COLUMNS } from "@memoturn/contracts";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@memoturn/ui";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import {
  Activity,
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  ChevronDown,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  ChevronUp,
  Coins,
  Columns3,
  DollarSign,
  Download,
  GitCompare,
  RefreshCw,
  Rows2,
  Rows3,
  Save,
  ShieldAlert,
  SlidersHorizontal,
  Timer,
  X,
} from "lucide-react";
import { Fragment, type ReactNode, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Timestamp } from "@/components/timestamp";
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
import { writeTraceListContext } from "../../lib/trace-list-context";
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
  // Selected span + timeline/graph mode inside the open peek (mirrored by TraceDetailBody),
  // so a peeked span deep-links exactly like the full page.
  observation?: string;
  view?: string;
  // Pagination (1-based). Defaults (page 1 / size 50) are kept out of the URL to keep it clean.
  page?: number;
  pageSize?: number;
  // Sort key + direction — view state like page, shareable via the URL. Default (timestamp desc)
  // is kept out of the URL.
  orderBy?: TraceOrder;
  orderDir?: "asc" | "desc";
}

type TraceOrder = "timestamp" | "name" | "latency" | "cost" | "tokens";
const TRACE_ORDERS: TraceOrder[] = ["timestamp", "name", "latency", "cost", "tokens"];

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
    observation: str(s.observation),
    view: s.view === "graph" || s.view === "log" ? s.view : undefined,
    page: posInt(s.page),
    pageSize: posInt(s.pageSize),
    orderBy: TRACE_ORDERS.includes(s.orderBy as TraceOrder) ? (s.orderBy as TraceOrder) : undefined,
    orderDir: s.orderDir === "asc" || s.orderDir === "desc" ? s.orderDir : undefined,
  }),
  component: TracesPage,
});

function fmtCost(n: number): string {
  return n > 0 ? `$${n.toFixed(6)}` : "—";
}

// Toggleable + reorderable trace columns (Name is the identity column and always shown first).
const TRACE_COLUMNS = [
  { key: "timestamp", label: "Timestamp", cellClass: "text-muted-foreground" },
  { key: "input", label: "Input" },
  { key: "output", label: "Output" },
  { key: "obs", label: "Obs", cellClass: "tabular-nums" },
  { key: "tokens", label: "Tokens", cellClass: "tabular-nums" },
  { key: "cost", label: "Cost", cellClass: "tabular-nums" },
  { key: "latency", label: "Latency", cellClass: "tabular-nums" },
  { key: "scores", label: "Scores" },
  { key: "env", label: "Env" },
  { key: "tags", label: "Tags" },
  { key: "metadata", label: "Metadata" },
] as const;

/** Sort key behind each sortable column header (identity Name column handled separately). */
const COL_SORT: Partial<Record<(typeof TRACE_COLUMNS)[number]["key"], TraceOrder>> = {
  timestamp: "timestamp",
  tokens: "tokens",
  cost: "cost",
  latency: "latency",
};

/** Single-line payload snippet for list cells (the store pre-truncates to ~300 chars). */
function PreviewCell({ text }: { text: string }) {
  if (!text || text === "{}" || text === "null" || text === '""') return <span>—</span>;
  // Payloads offloaded to blob store a marker inline — label it instead of showing marker JSON.
  const label = text.startsWith('{"_truncated"') ? "(large payload)" : text;
  return (
    <span className="block max-w-[18rem] truncate font-mono text-xs text-muted-foreground" title={label}>
      {label}
    </span>
  );
}
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
    // Metadata starts hidden — it's the widest, least-scanned preview column.
    return { hidden: ["metadata"], order: [] };
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

const SLOW_THRESHOLDS = [2000, 5000, 10000]; // ms
const COST_THRESHOLDS = [0.01, 0.05, 0.25]; // USD

const levelPreset = (levels: string[]): SingleFilter => ({
  type: "stringOptions",
  column: "level",
  operator: "any_of",
  value: levels,
});

/** A quick-filter preset dropdown: each option swaps in a structured filter on its column. */
function PresetMenu({
  label,
  icon: Icon,
  active,
  options,
  onClear,
}: {
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  active: boolean;
  options: { label: string; description: string; apply: () => void }[];
  onClear: () => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant={active ? "secondary" : "outline"} size="sm" className="h-7 gap-1.5">
          <Icon className="size-3.5" />
          {label}
          <ChevronDown className="size-3 opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        {options.map((o) => (
          <DropdownMenuItem key={o.label} onSelect={o.apply}>
            <div className="flex flex-col">
              <span>{o.label}</span>
              <span className="text-xs text-muted-foreground">{o.description}</span>
            </div>
          </DropdownMenuItem>
        ))}
        {active && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={onClear}>Clear {label.toLowerCase()} filter</DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Values shown per facet before the value-search input appears. */
const FACET_SEARCH_MIN = 8;

/** One facet dimension: a labeled list of value/count rows; the active value is highlighted.
 *  Long lists get a search input; an active value gets a clear (✕) in the header. */
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
  const [q, setQ] = useState("");
  const shown = q ? items?.filter((it) => it.value.toLowerCase().includes(q.toLowerCase())) : items;
  return (
    <div>
      <div className="mb-1 flex items-center justify-between text-[0.6875rem] font-medium tracking-wide text-muted-foreground uppercase">
        {title}
        {active && (
          <button
            type="button"
            onClick={() => onPick(active)}
            className="normal-case hover:text-foreground"
            title={`Clear ${title.toLowerCase()} filter`}
          >
            <X className="size-3" />
          </button>
        )}
      </div>
      {items && items.length >= FACET_SEARCH_MIN && (
        <Input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Filter values…"
          className="mb-1 h-6 px-2 text-xs"
        />
      )}
      {!items ? (
        <div className="space-y-1">
          <Skeleton className="h-5 w-full" />
          <Skeleton className="h-5 w-3/4" />
        </div>
      ) : items.length === 0 ? (
        <div className="px-2 py-1 text-xs text-muted-foreground">None</div>
      ) : shown && shown.length === 0 ? (
        <div className="px-2 py-1 text-xs text-muted-foreground">No values match</div>
      ) : (
        <div className="space-y-0.5">
          {(shown ?? []).map((it) => {
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

/** The active filter set the facet counts are computed against. */
type FacetQuery = {
  days: number;
  // Values fetched per facet (25 default; "Show more values" raises it to the server cap).
  limit?: number;
  environment?: string;
  search?: string;
  userId?: string;
  tag?: string;
  scoreName?: string;
  level?: string;
  type?: string;
  // JSON-encoded structured filter set — narrows every facet (it is not a facet dimension).
  filter?: string;
};

type FacetProps = FacetQuery & {
  onPick: (key: "environment" | "search" | "tag" | "scoreName" | "level" | "type", value: string) => void;
};

/**
 * The facets query. Callers share one fetch (identical query key): the rail renders the counts,
 * and the page reuses the score names as key suggestions for the score filter columns.
 */
function useTraceFacets({
  days,
  limit = 25,
  environment,
  search,
  userId,
  tag,
  scoreName,
  level,
  type,
  filter,
}: FacetQuery) {
  // Counts are facet-excluding server-side; passing the active filters makes them narrow live.
  return useQuery({
    queryKey: ["trace-facets", days, limit, environment, search, userId, tag, scoreName, level, type, filter],
    queryFn: () => api.traceFacets({ days, limit, environment, search, userId, tag, scoreName, level, type, filter }),
    refetchInterval: 15_000,
    // Keep the current counts on screen while the next set loads — no skeleton flash on select.
    placeholderData: keepPreviousData,
  });
}

/** Score pseudo-columns take a score NAME as their key — offer the names actually observed. */
function filterColumnsWithScoreNames(scores?: FacetCount[]): FilterColumnDef[] {
  const names = scores?.map((s) => s.value) ?? [];
  if (names.length === 0) return TRACE_FILTER_COLUMNS;
  return TRACE_FILTER_COLUMNS.map((c) =>
    c.id === "scores" || c.id === "scoreCategories" ? { ...c, keyOptions: names } : c,
  );
}

/** The facet sections — shared by the desktop rail and the mobile Filters sheet. */
function FacetSections({ onPick, onToggleMore, ...q }: FacetProps & { onToggleMore?: () => void }) {
  const { data } = useTraceFacets(q);
  const expanded = (q.limit ?? 25) > 25;
  // "Show more" only earns its row when some facet actually hit the collapsed cap.
  const atCap = !expanded && data && Object.values(data).some((items) => items.length >= 25);
  return (
    <div className="space-y-4">
      <FacetSection
        title="Environment"
        items={data?.environments}
        active={q.environment}
        onPick={(v) => onPick("environment", v)}
      />
      <FacetSection title="Type" items={data?.types} active={q.type} onPick={(v) => onPick("type", v)} />
      <FacetSection title="Level" items={data?.levels} active={q.level} onPick={(v) => onPick("level", v)} />
      <FacetSection title="Name" items={data?.names} active={q.search} onPick={(v) => onPick("search", v)} />
      <FacetSection title="Scores" items={data?.scores} active={q.scoreName} onPick={(v) => onPick("scoreName", v)} />
      <FacetSection title="Tags" items={data?.tags} active={q.tag} onPick={(v) => onPick("tag", v)} />
      {onToggleMore && (atCap || expanded) && (
        <button
          type="button"
          onClick={onToggleMore}
          className="flex items-center gap-1 px-2 text-xs text-muted-foreground hover:text-foreground"
        >
          {expanded ? <ChevronUp className="size-3" /> : <ChevronDown className="size-3" />}
          {expanded ? "Show fewer values" : "Show more values"}
        </button>
      )}
    </div>
  );
}

/** Desktop filter rail — sticky so it stays put while the table scrolls. */
function FacetPanel({ onToggleMore, ...props }: FacetProps & { onToggleMore?: () => void }) {
  return (
    <aside className="sticky top-4 hidden max-h-[calc(100svh-2rem)] w-56 shrink-0 self-start overflow-y-auto lg:block">
      <div className="mb-3 flex items-center gap-1.5 text-sm font-medium">
        Filters
        <HelpTip>
          Click a value in any section to narrow the list; counts update to reflect the other active filters.
        </HelpTip>
      </div>
      <FacetSections {...props} onToggleMore={onToggleMore} />
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

  // `peek`/`observation`/`view`/`page`/`pageSize`/`orderBy`/`orderDir` are view state, not
  // filters — keep them out of the list query's filter object (so facets/saved views use only
  // real filters); page/size/sort still drive the list query itself.
  const {
    peek,
    observation: _observation,
    view: _view,
    page: pageRaw,
    pageSize: pageSizeRaw,
    orderBy,
    orderDir,
    ...listFilters
  } = filters;
  const page = pageRaw ?? 1;
  const pageSize = pageSizeRaw ?? DEFAULT_PAGE_SIZE;
  const sortKey = orderBy ?? "timestamp";
  const sortDir = orderDir ?? "desc";

  // Auto-refresh: on by default (5s), pausable — a paused list stops shifting under investigation.
  const [autoRefresh, setAutoRefresh] = usePersisted("memoturn.traces.autoRefresh", true);
  // "Show more values" raises the per-facet value cap from 25 to the server cap (100).
  const [facetLimit, setFacetLimit] = usePersisted("memoturn.traces.facetLimit", 25);

  // The facet rail and the filter builder share this one query (identical key): the rail draws the
  // counts, the builder borrows the observed score names for its `scores.<name>` key suggestions.
  const facetQuery: FacetQuery = { ...listFilters, days, limit: facetLimit };
  const { data: facets } = useTraceFacets(facetQuery);
  const filterColumns = useMemo(() => filterColumnsWithScoreNames(facets?.scores), [facets?.scores]);

  const {
    data: pageData,
    isLoading,
    error,
  } = useQuery({
    queryKey: ["traces", listFilters, days, page, pageSize, sortKey, sortDir],
    queryFn: () => api.listTracesPage({ ...listFilters, days, page, pageSize, orderBy: sortKey, orderDir: sortDir }),
    refetchInterval: autoRefresh ? 5_000 : false,
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

  // Quick-filter presets: swap in structured filters on a column (replacing any existing filter
  // on it), so presets compose with hand-built filters and render as the builder's chips.
  const presetActive = (column: string) => filterSet.some((f) => f.column === column);
  const applyPreset = (column: string, add: SingleFilter[]) =>
    setFilterSet([...filterSet.filter((f) => f.column !== column), ...add]);
  const clearPreset = (columns: string[]) => setFilterSet(filterSet.filter((f) => !columns.includes(f.column)));

  // Per-column cell renderers — the table header/body iterate `visibleCols` in the persisted order.
  const cellContent: Record<ColKey, (t: TraceSummary) => ReactNode> = {
    timestamp: (t) => <Timestamp value={t.timestamp} />,
    input: (t) => <PreviewCell text={t.input_preview} />,
    output: (t) => <PreviewCell text={t.output_preview} />,
    metadata: (t) => <PreviewCell text={t.metadata_preview} />,
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
  // Header click: first click sorts by the column (desc for metrics, asc for name), second flips.
  // The default (timestamp desc) stays out of the URL; sorting resets to page 1.
  const setSort = (key: TraceOrder) => {
    const dir = sortKey === key ? (sortDir === "desc" ? "asc" : "desc") : key === "name" ? "asc" : "desc";
    navigate({
      search: (prev) => ({
        ...prev,
        orderBy: key === "timestamp" && dir === "desc" ? undefined : key,
        orderDir: key === "timestamp" && dir === "desc" ? undefined : dir,
        page: undefined,
      }),
    });
  };
  const SortHead = ({ label, order }: { label: string; order: TraceOrder }) => (
    <button
      type="button"
      onClick={() => setSort(order)}
      className="inline-flex items-center gap-1 hover:text-foreground"
      title={`Sort by ${label.toLowerCase()}`}
    >
      {label}
      {sortKey === order ? (
        sortDir === "desc" ? (
          <ArrowDown className="size-3.5" />
        ) : (
          <ArrowUp className="size-3.5" />
        )
      ) : (
        <ArrowUpDown className="size-3.5 opacity-40" />
      )}
    </button>
  );
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

  // Peek drawer: open a trace inline over the list, deep-linkable via ?peek= (drawer owns J/K
  // nav). Switching or closing clears the span selection — it belongs to the previous trace.
  const setPeek = (id: string | undefined) =>
    navigate({ search: (prev) => ({ ...prev, peek: id, observation: undefined, view: undefined }) });

  // Record this page of ids so the full-page trace detail can step prev/next through the list.
  useEffect(() => {
    if (traces && traces.length > 0) writeTraceListContext(traces.map((t) => t.id));
  }, [traces]);

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
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5"
              title="Refresh now"
              onClick={() => {
                qc.invalidateQueries({ queryKey: ["traces"] });
                qc.invalidateQueries({ queryKey: ["trace-facets"] });
              }}
            >
              <RefreshCw />
            </Button>
            <Button
              variant={autoRefresh ? "default" : "outline"}
              size="sm"
              onClick={() => setAutoRefresh(!autoRefresh)}
              title={
                autoRefresh ? "Auto-refresh is on (5s) — click to pause" : "Auto-refresh is paused — click to resume"
              }
            >
              {autoRefresh ? "Auto 5s" : "Paused"}
            </Button>
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
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
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
          <StatTile
            label="Observations (page)"
            value={
              traces ? traces.reduce((a, t) => a + Number(t.observation_count), 0) : <Skeleton className="h-6 w-16" />
            }
            help="Sum of observations (spans) across the traces on this page."
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
              <FacetSections {...facetQuery} onPick={pickFacet} />
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

      {/* Quick-filter presets — opinionated debugging entry points that compile to structured
          filters, so they compose with the filter builder and show up as its chips. */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm text-muted-foreground">Quick filters:</span>
        <PresetMenu
          label="Quality"
          icon={ShieldAlert}
          active={presetActive("level") || presetActive("type")}
          options={[
            {
              label: "Errors only",
              description: "Traces with at least one failing span",
              apply: () => applyPreset("level", [levelPreset(["ERROR"])]),
            },
            {
              label: "Warnings & errors",
              description: "Anything logged at WARNING or ERROR",
              apply: () => applyPreset("level", [levelPreset(["WARNING", "ERROR"])]),
            },
            {
              label: "Review output (generations)",
              description: "Traces with LLM generations, for reviewing response quality",
              apply: () =>
                applyPreset("type", [
                  { type: "stringOptions", column: "type", operator: "any_of", value: ["GENERATION"] },
                ]),
            },
          ]}
          onClear={() => clearPreset(["level", "type"])}
        />
        <PresetMenu
          label="Slow"
          icon={Timer}
          active={presetActive("latencyMs")}
          options={SLOW_THRESHOLDS.map((msVal) => ({
            label: `Slower than ${msVal / 1000}s`,
            description: "By total trace latency",
            apply: () =>
              applyPreset("latencyMs", [{ type: "number", column: "latencyMs", operator: "gt", value: msVal }]),
          }))}
          onClear={() => clearPreset(["latencyMs"])}
        />
        <PresetMenu
          label="Cost"
          icon={DollarSign}
          active={presetActive("cost")}
          options={COST_THRESHOLDS.map((usd) => ({
            label: `Over $${usd}`,
            description: "By estimated trace cost",
            apply: () => applyPreset("cost", [{ type: "number", column: "cost", operator: "gt", value: usd }]),
          }))}
          onClear={() => clearPreset(["cost"])}
        />
        <span className="mx-1 h-4 w-px bg-border" aria-hidden />
        <FilterBuilder value={filterSet} onChange={setFilterSet} columns={filterColumns} />
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
        <FacetPanel {...facetQuery} onPick={pickFacet} onToggleMore={() => setFacetLimit(facetLimit > 25 ? 25 : 100)} />
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
                    <TableHead>
                      <SortHead label="Name" order="name" />
                    </TableHead>
                    {visibleCols.map((k) => (
                      <TableHead key={k}>
                        {k === "scores" ? (
                          <span className="inline-flex items-center gap-1">
                            {COL_LABEL[k]}
                            <HelpTip>Evaluation scores attached to the trace by evaluators or human review.</HelpTip>
                          </span>
                        ) : COL_SORT[k] ? (
                          <SortHead label={COL_LABEL[k]} order={COL_SORT[k]} />
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
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page <= 1}
                  onClick={() => setPage(1)}
                  aria-label="First page"
                >
                  <ChevronsLeft />
                </Button>
                <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>
                  Prev
                </Button>
                <span className="flex items-center gap-1.5 tabular-nums text-muted-foreground">
                  Page
                  <Input
                    key={page}
                    type="number"
                    min={1}
                    max={pageCount}
                    defaultValue={page}
                    aria-label="Page number"
                    className="h-8 w-16 text-center tabular-nums"
                    onKeyDown={(e) => {
                      if (e.key !== "Enter") return;
                      const p = Math.floor(Number(e.currentTarget.value));
                      if (Number.isFinite(p)) setPage(Math.min(Math.max(1, p), pageCount));
                    }}
                    onBlur={(e) => {
                      const p = Math.floor(Number(e.currentTarget.value));
                      if (Number.isFinite(p) && p !== page) setPage(Math.min(Math.max(1, p), pageCount));
                    }}
                  />
                  / {pageCount}
                </span>
                <Button variant="outline" size="sm" disabled={page >= pageCount} onClick={() => setPage(page + 1)}>
                  Next
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page >= pageCount}
                  onClick={() => setPage(pageCount)}
                  aria-label="Last page"
                >
                  <ChevronsRight />
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
