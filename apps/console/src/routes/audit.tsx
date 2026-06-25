import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { api } from "../lib/api";

export const Route = createFileRoute("/audit")({ component: AuditPage });

function AuditPage() {
  const { data: logs, isLoading, error } = useQuery({
    queryKey: ["audit"],
    queryFn: () => api.listAuditLogs(),
    refetchInterval: 10_000,
  });

  return (
    <div>
      <h1>Audit log</h1>
      {isLoading && <div className="empty">Loading…</div>}
      {error && <div className="empty">Failed to load: {String(error)}</div>}
      {logs && logs.length === 0 && <div className="empty">No audit entries yet.</div>}
      {logs && logs.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>Time</th>
              <th>Actor</th>
              <th>Action</th>
              <th>Target</th>
            </tr>
          </thead>
          <tbody>
            {logs.map((l, i) => (
              <tr key={i}>
                <td>{l.createdAt.slice(0, 19).replace("T", " ")}</td>
                <td>{l.actor}</td>
                <td>
                  <span className="badge gen">{l.action}</span>
                </td>
                <td>{l.target}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
