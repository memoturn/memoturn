import { useQuery } from "@tanstack/react-query";
import { Link, createFileRoute } from "@tanstack/react-router";
import { api } from "../../lib/api";

export const Route = createFileRoute("/datasets/")({ component: DatasetsPage });

function DatasetsPage() {
  const { data: datasets, isLoading, error } = useQuery({
    queryKey: ["datasets"],
    queryFn: () => api.listDatasets(),
    refetchInterval: 10_000,
  });

  return (
    <div>
      <h1>Datasets</h1>
      {isLoading && <div className="empty">Loading…</div>}
      {error && <div className="empty">Failed to load: {String(error)}</div>}
      {datasets && datasets.length === 0 && (
        <div className="empty">
          No datasets yet. Create one with <code>POST /v1/datasets</code> or the SDK.
        </div>
      )}
      {datasets && datasets.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Items</th>
              <th>Runs</th>
              <th>Description</th>
            </tr>
          </thead>
          <tbody>
            {datasets.map((d) => (
              <tr key={d.name}>
                <td>
                  <Link to="/datasets/$name" params={{ name: d.name }}>
                    {d.name}
                  </Link>
                </td>
                <td>{d.items}</td>
                <td>{d.runs}</td>
                <td>{d.description || "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
