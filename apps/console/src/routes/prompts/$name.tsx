import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { api, type PromptVersionDetail } from "../../lib/api";

export const Route = createFileRoute("/prompts/$name")({ component: PromptDetailPage });

function renderContent(v: PromptVersionDetail): string {
  if (v.type === "CHAT" && Array.isArray(v.content)) {
    return (v.content as { role: string; content: string }[]).map((m) => `[${m.role}] ${m.content}`).join("\n");
  }
  return String(v.content ?? "");
}

function PromptDetailPage() {
  const { name } = Route.useParams();
  const {
    data: prompt,
    isLoading,
    error,
  } = useQuery({
    queryKey: ["prompt", name],
    queryFn: () => api.getPrompt(name),
  });

  if (isLoading) return <div className="empty">Loading…</div>;
  if (error) return <div className="empty">Failed to load: {String(error)}</div>;
  if (!prompt) return <div className="empty">Prompt not found.</div>;

  // Which channels point at each version.
  const channelsByVersion = new Map<number, string[]>();
  for (const c of prompt.channels) {
    channelsByVersion.set(c.version, [...(channelsByVersion.get(c.version) ?? []), c.label]);
  }

  return (
    <div>
      <p>
        <Link to="/prompts">← Prompts</Link>
      </p>
      <h1>{prompt.name}</h1>
      <dl className="kv">
        <dt>Folder</dt>
        <dd>{prompt.folder || "—"}</dd>
        <dt>Latest</dt>
        <dd>v{prompt.latestVersion}</dd>
        <dt>Channels</dt>
        <dd>
          {prompt.channels.map((c) => (
            <span key={c.label} className="badge gen" style={{ marginRight: 4 }}>
              {c.label} → v{c.version}
            </span>
          ))}
        </dd>
      </dl>

      <h2>Versions</h2>
      <ul className="tree">
        {prompt.allVersions.map((v) => (
          <li key={v.version}>
            <div className="obs-name">
              v{v.version} <span className="badge">{v.type.toLowerCase()}</span>{" "}
              {(channelsByVersion.get(v.version) ?? []).map((label) => (
                <span key={label} className="badge gen" style={{ marginLeft: 4 }}>
                  {label}
                </span>
              ))}
            </div>
            <div className="obs-meta">{v.createdAt.slice(0, 19).replace("T", " ")}</div>
            <pre>{renderContent(v)}</pre>
            {v.config != null && Object.keys(v.config as object).length > 0 && (
              <pre>{JSON.stringify(v.config, null, 2)}</pre>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
