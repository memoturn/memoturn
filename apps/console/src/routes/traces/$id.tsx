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

function ms(t: string | null): number | null {
  if (!t) return null;
  const v = Date.parse(t);
  return Number.isNaN(v) ? null : v;
}

interface Laid extends ObservationDetail {
  depth: number;
  offsetPct: number;
  widthPct: number;
}

/** Compute waterfall layout: depth from parent chain, bar offset/width from times. */
function layout(observations: ObservationDetail[]): Laid[] {
  const byId = new Map(observations.map((o) => [o.id, o]));
  const depthOf = (o: ObservationDetail): number => {
    let d = 0;
    let cur: ObservationDetail | undefined = o;
    const seen = new Set<string>();
    while (cur?.parent_observation_id && byId.has(cur.parent_observation_id) && !seen.has(cur.id)) {
      seen.add(cur.id);
      cur = byId.get(cur.parent_observation_id);
      d++;
    }
    return d;
  };

  const starts = observations.map((o) => ms(o.start_time) ?? 0);
  const ends = observations.map((o, i) => ms(o.end_time) ?? starts[i]! + Number(o.latency_ms));
  const traceStart = Math.min(...starts);
  const total = Math.max(1, Math.max(...ends) - traceStart);

  return observations
    .map((o, i) => ({
      ...o,
      depth: depthOf(o),
      offsetPct: ((starts[i]! - traceStart) / total) * 100,
      widthPct: Math.max(1.5, (Number(o.latency_ms) / total) * 100),
    }))
    .sort((a, b) => (ms(a.start_time) ?? 0) - (ms(b.start_time) ?? 0));
}

function WaterfallRow({ obs }: { obs: Laid }) {
  return (
    <div className="wf-row">
      <div className="wf-label" style={{ paddingLeft: `${obs.depth * 16}px` }}>
        <span className={badgeClass(obs.type)}>{obs.type.toLowerCase()}</span>{" "}
        <span className="obs-name">{obs.name || obs.id.slice(0, 8)}</span>
        {obs.model && <span className="obs-meta"> · {obs.model}</span>}
      </div>
      <div className="wf-track">
        <div
          className={`wf-bar ${obs.type === "GENERATION" ? "gen" : obs.type === "SPAN" ? "span" : "event"}`}
          style={{ left: `${obs.offsetPct}%`, width: `${obs.widthPct}%` }}
          title={`${obs.latency_ms} ms`}
        />
        <span className="wf-dur" style={{ left: `min(${obs.offsetPct}%, 80%)` }}>
          {obs.latency_ms} ms
        </span>
      </div>
    </div>
  );
}

function ObservationDetailRow({ obs }: { obs: ObservationDetail }) {
  if (!obs.input && !obs.output && obs.level === "DEFAULT") return null;
  return (
    <details className="obs-detail">
      <summary>
        <span className={badgeClass(obs.type)}>{obs.type.toLowerCase()}</span> {obs.name || obs.id.slice(0, 8)}
        {obs.total_tokens > 0 && <span className="obs-meta"> · {obs.total_tokens} tok</span>}
        {Number(obs.total_cost) > 0 && <span className="obs-meta"> · ${Number(obs.total_cost).toFixed(6)}</span>}
        {obs.level !== "DEFAULT" && <span className="obs-meta"> · {obs.level}</span>}
      </summary>
      {obs.input && <pre>{pretty(obs.input)}</pre>}
      {obs.output && <pre>{pretty(obs.output)}</pre>}
      {obs.status_message && <pre>{obs.status_message}</pre>}
    </details>
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

      {trace.scores.length > 0 && (
        <>
          <h2>Scores ({trace.scores.length})</h2>
          <div className="scores">
            {trace.scores.map((s, i) => (
              <div className="score-chip" key={i} title={s.comment}>
                <span className={`badge ${s.source === "EVAL" ? "gen" : s.source === "ANNOTATION" ? "span" : "event"}`}>
                  {s.source.toLowerCase()}
                </span>
                <span className="score-name">{s.name}</span>
                <span className="score-val">{s.value != null ? s.value : s.string_value || "—"}</span>
                {s.comment && <span className="obs-meta score-comment">{s.comment}</span>}
              </div>
            ))}
          </div>
        </>
      )}

      <h2>Timeline ({trace.observation_count})</h2>
      <div className="waterfall">
        {layout(trace.observations).map((obs) => (
          <WaterfallRow key={obs.id} obs={obs} />
        ))}
      </div>

      <h2>Payloads</h2>
      <div className="tree">
        {trace.observations.map((obs) => (
          <ObservationDetailRow key={obs.id} obs={obs} />
        ))}
      </div>
    </div>
  );
}
