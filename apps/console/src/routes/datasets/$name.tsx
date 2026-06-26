import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { api } from "../../lib/api";

export const Route = createFileRoute("/datasets/$name")({ component: DatasetDetailPage });

function j(value: unknown): string {
  if (value == null) return "—";
  return typeof value === "string" ? value : JSON.stringify(value);
}

function trunc(s: string, n = 100): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
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

      {data.runs.length > 0 && <Comparison name={name} />}

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

function Comparison({ name }: { name: string }) {
  const { data } = useQuery({
    queryKey: ["dataset-compare", name],
    queryFn: () => api.getDatasetComparison(name),
  });
  if (!data || data.runs.length === 0) return null;

  return (
    <>
      <h2>Run comparison</h2>
      <div style={{ overflowX: "auto" }}>
        <table>
          <thead>
            <tr>
              <th>Input</th>
              <th>Expected</th>
              {data.runs.map((r) => (
                <th key={r}>{r}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.items.map((it) => (
              <tr key={it.id}>
                <td className="obs-meta">{trunc(j(it.input), 80)}</td>
                <td className="obs-meta">{trunc(j(it.expectedOutput), 80)}</td>
                {it.cells.map((cell, i) => (
                  <td key={data.runs[i] ?? i}>
                    {cell ? (
                      <>
                        <Link to="/traces/$id" params={{ id: cell.traceId }}>
                          {trunc(cell.output, 80) || "view trace"}
                        </Link>
                        {cell.scores.length > 0 && (
                          <div className="scores" style={{ marginTop: 4 }}>
                            {cell.scores.map((s, k) => (
                              <span className="score-chip" key={`${s.name}:${k}`}>
                                <span className="score-name">{s.name}</span>
                                <span className="score-val">{s.value != null ? s.value : s.stringValue || "—"}</span>
                              </span>
                            ))}
                          </div>
                        )}
                      </>
                    ) : (
                      <span className="obs-meta">—</span>
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
