import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { api } from "../../lib/api";

export const Route = createFileRoute("/datasets/$name")({ component: DatasetDetailPage });

function j(value: unknown): string {
  if (value == null) return "—";
  return typeof value === "string" ? value : JSON.stringify(value);
}

function DatasetDetailPage() {
  const { name } = Route.useParams();
  const { data, isLoading, error } = useQuery({
    queryKey: ["dataset", name],
    queryFn: () => api.getDataset(name),
  });

  if (isLoading) return <div className="empty">Loading…</div>;
  if (error) return <div className="empty">Failed to load: {String(error)}</div>;
  if (!data) return <div className="empty">Dataset not found.</div>;

  return (
    <div>
      <p>
        <Link to="/datasets">← Datasets</Link>
      </p>
      <h1>{data.name}</h1>
      {data.description && <p className="obs-meta">{data.description}</p>}

      <h2>Runs ({data.runs.length})</h2>
      {data.runs.length === 0 ? (
        <div className="empty">No experiment runs yet.</div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Run</th>
              <th>Items linked</th>
              <th>Created</th>
            </tr>
          </thead>
          <tbody>
            {data.runs.map((r) => (
              <tr key={r.name}>
                <td>
                  <span className="badge gen">{r.name}</span>
                </td>
                <td>{r.itemCount}</td>
                <td>{r.createdAt.slice(0, 19).replace("T", " ")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2>Items ({data.items.length})</h2>
      {data.items.length === 0 ? (
        <div className="empty">No items yet.</div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Input</th>
              <th>Expected output</th>
            </tr>
          </thead>
          <tbody>
            {data.items.map((it) => (
              <tr key={it.id}>
                <td>{j(it.input)}</td>
                <td>{j(it.expectedOutput)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
