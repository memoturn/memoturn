import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { api } from "../../lib/api";

export const Route = createFileRoute("/sessions/$id")({ component: SessionDetailPage });

function fmtCost(n: number): string {
  return n > 0 ? `$${n.toFixed(6)}` : "—";
}

function SessionDetailPage() {
  const { id } = Route.useParams();
  const {
    data: traces,
    isLoading,
    error,
  } = useQuery({
    queryKey: ["session-traces", id],
    queryFn: () => api.listTraces({ sessionId: id }),
  });

  return (
    <div>
      <p>
        <Link to="/sessions">← Sessions</Link>
      </p>
      <h1>Session {id}</h1>
      {isLoading && <div className="empty">Loading…</div>}
      {error && <div className="empty">Failed to load: {String(error)}</div>}
      {traces && traces.length === 0 && <div className="empty">No traces in this session.</div>}
      {traces && traces.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Timestamp</th>
              <th>Tokens</th>
              <th>Cost</th>
              <th>Latency</th>
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
                <td>{t.total_tokens}</td>
                <td>{fmtCost(Number(t.total_cost))}</td>
                <td>{t.latency_ms} ms</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
