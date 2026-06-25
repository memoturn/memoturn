import { useQuery } from "@tanstack/react-query";
import { Link, createFileRoute } from "@tanstack/react-router";
import { api, type ObservationDetail } from "../../lib/api";

export const Route = createFileRoute("/traces/$id")({ component: TraceDetailPage });

function badgeClass(type: string): string {
  if (type === "GENERATION") return "badge gen";
  if (type === "SPAN") return "badge span";
  return "badge event";
}

function pretty(value: string): string {
  if (!value) return "—";
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
}

function ObservationNode({ obs }: { obs: ObservationDetail }) {
  return (
    <li>
      <div>
        <span className={badgeClass(obs.type)}>{obs.type.toLowerCase()}</span>{" "}
        <span className="obs-name">{obs.name || obs.id.slice(0, 8)}</span>
      </div>
      <div className="obs-meta">
        {obs.model && <>model: {obs.model} · </>}
        {obs.total_tokens > 0 && <>{obs.total_tokens} tok · </>}
        {Number(obs.total_cost) > 0 && <>${Number(obs.total_cost).toFixed(6)} · </>}
        {obs.latency_ms} ms
        {obs.level !== "DEFAULT" && <> · {obs.level}</>}
      </div>
      {(obs.input || obs.output) && (
        <details>
          <summary className="obs-meta">payload</summary>
          {obs.input && <pre>{pretty(obs.input)}</pre>}
          {obs.output && <pre>{pretty(obs.output)}</pre>}
        </details>
      )}
    </li>
  );
}

function TraceDetailPage() {
  const { id } = Route.useParams();
  const { data: trace, isLoading, error } = useQuery({
    queryKey: ["trace", id],
    queryFn: () => api.getTrace(id),
  });

  if (isLoading) return <div className="empty">Loading…</div>;
  if (error) return <div className="empty">Failed to load: {String(error)}</div>;
  if (!trace) return <div className="empty">Trace not found.</div>;

  return (
    <div>
      <p>
        <Link to="/traces">← Traces</Link>
      </p>
      <h1>{trace.name || trace.id}</h1>

      <dl className="kv">
        <dt>Trace ID</dt>
        <dd>{trace.id}</dd>
        <dt>Timestamp</dt>
        <dd>{trace.timestamp}</dd>
        <dt>Environment</dt>
        <dd>{trace.environment}</dd>
        {trace.user_id && (
          <>
            <dt>User</dt>
            <dd>{trace.user_id}</dd>
          </>
        )}
        {trace.session_id && (
          <>
            <dt>Session</dt>
            <dd>{trace.session_id}</dd>
          </>
        )}
        <dt>Total tokens</dt>
        <dd>{trace.total_tokens}</dd>
        <dt>Total cost</dt>
        <dd>{Number(trace.total_cost) > 0 ? `$${Number(trace.total_cost).toFixed(6)}` : "—"}</dd>
        <dt>Latency</dt>
        <dd>{trace.latency_ms} ms</dd>
      </dl>

      <h2>Observations ({trace.observation_count})</h2>
      <ul className="tree">
        {trace.observations.map((obs) => (
          <ObservationNode key={obs.id} obs={obs} />
        ))}
      </ul>
    </div>
  );
}
