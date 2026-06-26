import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { api, downloadTracesExport } from "../../lib/api";
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

  const qc = useQueryClient();

  const { data: savedViews } = useQuery({
    queryKey: ["saved-views", "traces"],
    queryFn: () => api.listSavedViews("traces"),
  });
  const saveView = useMutation({
    mutationFn: (name: string) => api.createSavedView({ name, table: "traces", filters }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["saved-views", "traces"] }),
  });
  const removeView = useMutation({
    mutationFn: (id: string) => api.deleteSavedView(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["saved-views", "traces"] }),
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
      setSelected(new Set());
      setTarget("");
      qc.invalidateQueries({ queryKey: ["traces"] });
    },
  });
  const needsTarget = action === "add-to-dataset" || action === "review";

  return (
    <div>
      <h1>Traces</h1>

      <div className="filters">
        <input
          type="search"
          placeholder="Search name…"
          defaultValue={filters.search ?? ""}
          onChange={(e) => setFilter("search", e.target.value)}
        />
        <input
          type="text"
          placeholder="Environment"
          defaultValue={filters.environment ?? ""}
          onChange={(e) => setFilter("environment", e.target.value)}
        />
        <input
          type="text"
          placeholder="User ID"
          defaultValue={filters.userId ?? ""}
          onChange={(e) => setFilter("userId", e.target.value)}
        />
        {filters.tag && <span className="badge gen">tag: {filters.tag}</span>}
        {(filters.search || filters.environment || filters.userId || filters.tag) && (
          <button onClick={() => navigate({ search: {} })}>Clear</button>
        )}
        <div style={{ flex: 1 }} />
        <button onClick={promptSaveView} title="Save the current filters as a view">
          Save view
        </button>
        <button onClick={() => void downloadTracesExport()} title="Export traces as NDJSON">
          Export JSONL
        </button>
      </div>

      {savedViews && savedViews.length > 0 && (
        <div className="filters" style={{ alignItems: "center" }}>
          <span className="obs-meta">Saved views:</span>
          {savedViews.map((v) => (
            <span key={v.id} className="badge gen" style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>
              <button className="link-btn" onClick={() => applyView(v.filters)} title="Apply this view">
                {v.name}
              </button>
              <button className="link-btn" onClick={() => removeView.mutate(v.id)} title="Delete view">
                ×
              </button>
            </span>
          ))}
        </div>
      )}

      {selected.size > 0 && (
        <div className="filters" style={{ alignItems: "center" }}>
          <strong>{selected.size} selected</strong>
          <select value={action} onChange={(e) => setAction(e.target.value)}>
            <option value="add-to-dataset">Add to dataset</option>
            <option value="review">Add to review queue</option>
            <option value="delete">Delete</option>
          </select>
          {needsTarget && (
            <input
              placeholder={action === "add-to-dataset" ? "dataset name" : "review queue name"}
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              style={{ width: 200 }}
            />
          )}
          <button disabled={runBatch.isPending || (needsTarget && !target)} onClick={() => runBatch.mutate()}>
            {runBatch.isPending ? "Applying…" : "Apply"}
          </button>
          <button className="link-btn" onClick={() => setSelected(new Set())}>
            Clear selection
          </button>
          {runBatch.isError && <span className="obs-meta">Failed: {String(runBatch.error)}</span>}
        </div>
      )}

      {isLoading && <div className="empty">Loading…</div>}
      {error && <div className="empty">Failed to load: {String(error)}</div>}
      {traces && traces.length === 0 && (
        <div className="empty">
          No traces match. Run <code>bun run quickstart</code> to emit one.
        </div>
      )}
      {traces && traces.length > 0 && (
        <table>
          <thead>
            <tr>
              <th style={{ width: 24 }}>
                <input
                  type="checkbox"
                  checked={allSelected}
                  onChange={(e) => setSelected(e.target.checked ? new Set(allShown) : new Set())}
                  title="Select all shown"
                />
              </th>
              <th>Name</th>
              <th>Timestamp</th>
              <th>Obs</th>
              <th>Tokens</th>
              <th>Cost</th>
              <th>Latency</th>
              <th>Env</th>
              <th>Tags</th>
            </tr>
          </thead>
          <tbody>
            {traces.map((t) => (
              <tr key={t.id}>
                <td>
                  <input type="checkbox" checked={selected.has(t.id)} onChange={() => toggle(t.id)} />
                </td>
                <td>
                  <Link to="/traces/$id" params={{ id: t.id }}>
                    {t.name || t.id.slice(0, 8)}
                  </Link>
                </td>
                <td>{t.timestamp}</td>
                <td>{t.observation_count}</td>
                <td>{t.total_tokens}</td>
                <td>{fmtCost(Number(t.total_cost))}</td>
                <td>{t.latency_ms} ms</td>
                <td>
                  <span className="badge">{t.environment}</span>
                </td>
                <td>
                  {t.tags.map((tag) => (
                    <button key={tag} className="tag-chip" onClick={() => setFilter("tag", tag)} title="Filter by tag">
                      {tag}
                    </button>
                  ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
