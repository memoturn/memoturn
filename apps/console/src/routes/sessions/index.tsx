import { useQuery } from "@tanstack/react-query";
import { Link, createFileRoute } from "@tanstack/react-router";
import { api } from "../../lib/api";

export const Route = createFileRoute("/sessions/")({ component: SessionsPage });

function SessionsPage() {
  const { data: sessions, isLoading, error } = useQuery({
    queryKey: ["sessions"],
    queryFn: () => api.listSessions(),
    refetchInterval: 5_000,
  });

  return (
    <div>
      <h1>Sessions</h1>
      {isLoading && <div className="empty">Loading…</div>}
      {error && <div className="empty">Failed to load: {String(error)}</div>}
      {sessions && sessions.length === 0 && <div className="empty">No sessions yet.</div>}
      {sessions && sessions.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>Session</th>
              <th>Traces</th>
              <th>Cost</th>
              <th>First seen</th>
              <th>Last seen</th>
            </tr>
          </thead>
          <tbody>
            {sessions.map((s) => (
              <tr key={s.session_id}>
                <td>
                  <Link to="/sessions/$id" params={{ id: s.session_id }}>
                    {s.session_id}
                  </Link>
                </td>
                <td>{s.trace_count}</td>
                <td>{Number(s.total_cost) > 0 ? `$${Number(s.total_cost).toFixed(6)}` : "—"}</td>
                <td>{s.first_seen}</td>
                <td>{s.last_seen}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
