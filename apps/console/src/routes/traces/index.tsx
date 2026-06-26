import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { Activity, Coins, DollarSign, Download, Save, X } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { EmptyState } from "../../components/empty-state";
import { KindBadge } from "../../components/kind-badge";
import { PageHeader } from "../../components/page-header";
import { StatTile } from "../../components/stat-tile";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Checkbox } from "../../components/ui/checkbox";
import { Input } from "../../components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../components/ui/select";
import { Skeleton } from "../../components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../components/ui/table";
import { api, downloadTracesExport } from "../../lib/api";
import { useIsReadOnly } from "../../lib/role";
import { useRangeDays } from "../../lib/timeRange";

interface TraceSearch {
  search?: string;
  environment?: string;
  userId?: string;
  tag?: string;
}

const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);

export const Route = createFileRoute("/traces/")({
  // Filters live in the URL so they're shareable/bookmarkable (deep linkable).
  validateSearch: (s: Record<string, unknown>): TraceSearch => ({
    search: str(s.search),
    environment: str(s.environment),
    userId: str(s.userId),
    tag: str(s.tag),
  }),
  component: TracesPage,
});

function fmtCost(n: number): string {
  return n > 0 ? `$${n.toFixed(6)}` : "—";
}

function TracesPage() {
  const filters = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const days = useRangeDays();
  const readOnly = useIsReadOnly();
  const qc = useQueryClient();

  const {
    data: traces,
    isLoading,
    error,
  } = useQuery({
    queryKey: ["traces", filters, days],
    queryFn: () => api.listTraces({ ...filters, days }),
    refetchInterval: 5_000,
  });

  const setFilter = (key: keyof TraceSearch, value: string) => {
    navigate({ search: (prev) => ({ ...prev, [key]: value || undefined }) });
  };
  const hasFilters = Boolean(filters.search || filters.environment || filters.userId || filters.tag);

  const { data: savedViews } = useQuery({
    queryKey: ["saved-views", "traces"],
    queryFn: () => api.listSavedViews("traces"),
  });
  const saveView = useMutation({
    mutationFn: (name: string) => api.createSavedView({ name, table: "traces", filters }),
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
    mutationFn: () =>
      api.batchTraces({
        action,
        traceIds: [...selected],
        datasetName: action === "add-to-dataset" ? target : undefined,
        queueName: action === "review" ? target : undefined,
      }),
    onSuccess: () => {
      toast.success("Batch applied");
      setSelected(new Set());
      setTarget("");
      qc.invalidateQueries({ queryKey: ["traces"] });
    },
    onError: (e) => toast.error(`Batch failed: ${String(e)}`),
  });
  const needsTarget = action === "add-to-dataset" || action === "review";

  return (
    <div className="space-y-4">
      <PageHeader
        title="Traces"
        actions={
          <>
            <Button variant="outline" size="sm" onClick={promptSaveView} disabled={readOnly} className="gap-2">
              <Save />
              Save view
            </Button>
            <Button variant="outline" size="sm" onClick={() => void downloadTracesExport()} className="gap-2">
              <Download />
              Export JSONL
            </Button>
          </>
        }
      />

      {traces && traces.length > 0 && (
        <div className="grid grid-cols-3 gap-4 sm:max-w-xl">
          <StatTile label="Traces" value={traces.length} icon={Activity} />
          <StatTile label="Tokens" value={traces.reduce((a, t) => a + Number(t.total_tokens), 0)} icon={Coins} />
          <StatTile
            label="Cost"
            value={fmtCost(traces.reduce((a, t) => a + Number(t.total_cost), 0))}
            icon={DollarSign}
          />
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Input
          type="search"
          placeholder="Search name…"
          defaultValue={filters.search ?? ""}
          onChange={(e) => setFilter("search", e.target.value)}
          className="h-9 max-w-xs"
        />
        <Input
          placeholder="Environment"
          defaultValue={filters.environment ?? ""}
          onChange={(e) => setFilter("environment", e.target.value)}
          className="h-9 w-40"
        />
        <Input
          placeholder="User ID"
          defaultValue={filters.userId ?? ""}
          onChange={(e) => setFilter("userId", e.target.value)}
          className="h-9 w-40"
        />
        {filters.tag && <KindBadge tone="blue">tag: {filters.tag}</KindBadge>}
        {hasFilters && (
          <Button variant="ghost" size="sm" onClick={() => navigate({ search: {} })}>
            Clear
          </Button>
        )}
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
          <Select value={action} onValueChange={setAction}>
            <SelectTrigger size="sm" className="w-[200px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="add-to-dataset">Add to dataset</SelectItem>
              <SelectItem value="review">Add to review queue</SelectItem>
              <SelectItem value="delete">Delete</SelectItem>
            </SelectContent>
          </Select>
          {needsTarget && (
            <Input
              placeholder={action === "add-to-dataset" ? "dataset name" : "review queue name"}
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
          <Table>
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
                <TableHead>Timestamp</TableHead>
                <TableHead>Obs</TableHead>
                <TableHead>Tokens</TableHead>
                <TableHead>Cost</TableHead>
                <TableHead>Latency</TableHead>
                <TableHead>Env</TableHead>
                <TableHead>Tags</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {traces.map((t) => (
                <TableRow key={t.id} data-state={selected.has(t.id) ? "selected" : undefined}>
                  <TableCell>
                    <Checkbox
                      checked={selected.has(t.id)}
                      onCheckedChange={() => toggle(t.id)}
                      aria-label={`Select ${t.name || t.id}`}
                    />
                  </TableCell>
                  <TableCell>
                    <Link to="/traces/$id" params={{ id: t.id }} className="font-medium text-primary hover:underline">
                      {t.name || t.id.slice(0, 8)}
                    </Link>
                  </TableCell>
                  <TableCell className="text-muted-foreground">{t.timestamp}</TableCell>
                  <TableCell>{t.observation_count}</TableCell>
                  <TableCell>{t.total_tokens}</TableCell>
                  <TableCell>{fmtCost(Number(t.total_cost))}</TableCell>
                  <TableCell>{t.latency_ms} ms</TableCell>
                  <TableCell>
                    <Badge variant="secondary">{t.environment}</Badge>
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      {t.tags.map((tag) => (
                        <button
                          key={tag}
                          type="button"
                          className="border bg-muted px-1.5 py-0.5 text-xs text-muted-foreground hover:text-foreground"
                          onClick={() => setFilter("tag", tag)}
                          title="Filter by tag"
                        >
                          {tag}
                        </button>
                      ))}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
