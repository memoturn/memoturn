import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { api } from "../../lib/api";

export const Route = createFileRoute("/prompts/")({ component: PromptsPage });

function PromptsPage() {
  const {
    data: prompts,
    isLoading,
    error,
  } = useQuery({
    queryKey: ["prompts"],
    queryFn: () => api.listPrompts(),
    refetchInterval: 10_000,
  });

  return (
    <div>
      <h1>Prompts</h1>
      {isLoading && <div className="empty">Loading…</div>}
      {error && <div className="empty">Failed to load: {String(error)}</div>}
      {prompts && prompts.length === 0 && (
        <div className="empty">
          No prompts yet. Create one with <code>POST /v1/prompts</code> or the SDK.
        </div>
      )}
      {prompts && prompts.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Latest</th>
              <th>Versions</th>
              <th>Channels</th>
              <th>Updated</th>
            </tr>
          </thead>
          <tbody>
            {prompts.map((p) => (
              <tr key={p.name}>
                <td>
                  <Link to="/prompts/$name" params={{ name: p.name }}>
                    {p.folder ? `${p.folder}/` : ""}
                    {p.name}
                  </Link>
                </td>
                <td>v{p.latestVersion}</td>
                <td>{p.versions}</td>
                <td>
                  {p.channels.map((c) => (
                    <span key={c.label} className="badge gen" style={{ marginRight: 4 }}>
                      {c.label}→v{c.version}
                    </span>
                  ))}
                </td>
                <td>{p.updatedAt.slice(0, 19).replace("T", " ")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
