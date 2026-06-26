import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { api, downloadTracesExport } from "../../lib/api";

interface TraceSearch {
  search?: string;
  environment?: string;
  userId?: string;
}

export const Route = createFileRoute("/traces/")({
  // Filters live in the URL so they're shareable/bookmarkable (deep linkable).
  validateSearch: (s: Record<string, unknown>): TraceSearch => ({
    search: typeof s.search === "string" && s.search ? s.search : undefined,
    environment: typeof s.environment === "string" && s.environment ? s.environment : undefined,
    userId: typeof s.userId === "string" && s.userId ? s.userId : undefined,
  }),
  component: TracesPage,
});

function fmtCost(n: number): string {
  return n > 0 ? `$${n.toFixed(6)}` : "—";
}

function TracesPage() {
  const filters = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });

  const {
    data: traces,
    isLoading,
    error,
  } = useQuery({
    queryKey: ["traces", filters],
    queryFn: () => api.listTraces(filters),
    refetchInterval: 5_000,
  });

  const setFilter = (key: keyof TraceSearch, value: string) => {
    navigate({ search: (prev) => ({ ...prev, [key]: value || undefined }) });
  };

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
        {(filters.search || filters.environment || filters.userId) && (
          <button onClick={() => navigate({ search: {} })}>Clear</button>
        )}
        <div style={{ flex: 1 }} />
        <button onClick={() => void downloadTracesExport()} title="Export traces as NDJSON">
          Export JSONL
        </button>
      </div>

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
              <th>Name</th>
              <th>Timestamp</th>
              <th>Obs</th>
              <th>Tokens</th>
              <th>Cost</th>
              <th>Latency</th>
              <th>Env</th>
            </tr>
          </thead>
          <tbody>
            {traces.map((t) => (
              <tr key={t.id}>
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
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
