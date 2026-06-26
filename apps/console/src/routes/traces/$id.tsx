import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
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

// ── Multimodal media: render attachments referenced in input/output ───────────────
const MEDIA_BASE = import.meta.env.VITE_API_BASE ?? "/api";
const MEDIA_RE = /memoturn-media:\/\/[A-Za-z0-9/_.-]+/g;
const DATA_IMG_RE = /data:image\/[A-Za-z0-9.+-]+;base64,[A-Za-z0-9+/=]+/g;
const IMG_EXT = /\.(png|jpe?g|webp|gif|svg)$/i;

function MediaPreview({ raw }: { raw: string }) {
  if (!raw) return null;
  const markers = raw.match(MEDIA_RE) ?? [];
  const dataImgs = raw.match(DATA_IMG_RE) ?? [];
  if (markers.length === 0 && dataImgs.length === 0) return null;
  return (
    <div className="media-row">
      {markers.map((m) => {
        const key = m.slice("memoturn-media://".length);
        const url = `${MEDIA_BASE}/v1/media/${key}`;
        return IMG_EXT.test(key) ? (
          <img key={m} className="media-thumb" src={url} alt="attachment" />
        ) : (
          <a key={m} href={url} className="badge" target="_blank" rel="noreferrer">
            download
          </a>
        );
      })}
      {dataImgs.map((d) => (
        <img key={d.slice(0, 48)} className="media-thumb" src={d} alt="inline attachment" />
      ))}
    </div>
  );
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

// ── Agent graph: nodes = observations, edges = parent links, layered by depth ─────
const GRAPH_COLOR: Record<string, string> = { GENERATION: "#6d8bff", SPAN: "#4ade80", EVENT: "#fbbf24" };
const NODE_W = 172;
const NODE_H = 34;
const HGAP = 48;
const VGAP = 14;

function AgentGraph({ observations }: { observations: ObservationDetail[] }) {
  if (observations.length === 0) return <div className="empty">No observations to graph.</div>;

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

  const ordered = [...observations].sort((a, b) => (ms(a.start_time) ?? 0) - (ms(b.start_time) ?? 0));
  const layers = new Map<number, ObservationDetail[]>();
  for (const o of ordered) {
    const d = depthOf(o);
    const arr = layers.get(d) ?? [];
    arr.push(o);
    layers.set(d, arr);
  }

  const pos = new Map<string, { x: number; y: number }>();
  for (const [depth, arr] of layers) {
    arr.forEach((o, row) => {
      pos.set(o.id, { x: depth * (NODE_W + HGAP), y: row * (NODE_H + VGAP) });
    });
  }

  const maxDepth = Math.max(0, ...[...layers.keys()]);
  const maxRows = Math.max(1, ...[...layers.values()].map((a) => a.length));
  const width = (maxDepth + 1) * NODE_W + maxDepth * HGAP;
  const height = maxRows * (NODE_H + VGAP);

  const edges = observations.flatMap((o) => {
    if (!o.parent_observation_id) return [];
    const from = pos.get(o.parent_observation_id);
    const to = pos.get(o.id);
    return from && to ? [{ from, to }] : [];
  });

  return (
    <div className="agraph">
      <svg width={width} height={height} role="img" aria-label="Agent run graph">
        <title>Agent run graph</title>
        {edges.map((e, i) => {
          const x1 = e.from.x + NODE_W;
          const y1 = e.from.y + NODE_H / 2;
          const x2 = e.to.x;
          const y2 = e.to.y + NODE_H / 2;
          const mx = (x1 + x2) / 2;
          return (
            <path
              key={i}
              d={`M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`}
              fill="none"
              stroke="#232a36"
              strokeWidth={1.5}
            />
          );
        })}
        {observations.map((o) => {
          const p = pos.get(o.id);
          if (!p) return null;
          const color = GRAPH_COLOR[o.type] ?? "#8b94a7";
          const label = o.name || o.id.slice(0, 8);
          return (
            <g key={o.id} transform={`translate(${p.x}, ${p.y})`}>
              <title>{`${o.type} · ${o.name || o.id}${o.model ? ` · ${o.model}` : ""} · ${o.latency_ms} ms`}</title>
              <rect width={NODE_W} height={NODE_H} rx={7} fill="#141821" stroke={color} strokeWidth={1.5} />
              <circle cx={14} cy={NODE_H / 2} r={4} fill={color} />
              <text x={26} y={NODE_H / 2 + 4} fill="#e6e9ef" fontSize={12}>
                {label.length > 20 ? `${label.slice(0, 19)}…` : label}
              </text>
            </g>
          );
        })}
      </svg>
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
      <MediaPreview raw={obs.input} />
      <MediaPreview raw={obs.output} />
      {obs.input && <pre>{pretty(obs.input)}</pre>}
      {obs.output && <pre>{pretty(obs.output)}</pre>}
      {obs.status_message && <pre>{obs.status_message}</pre>}
    </details>
  );
}

function TraceDetailPage() {
  const { id } = Route.useParams();
  const [view, setView] = useState<"timeline" | "graph">("timeline");
  const {
    data: trace,
    isLoading,
    error,
  } = useQuery({
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

      <MediaPreview raw={trace.input} />
      <MediaPreview raw={trace.output} />

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

      <div style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
        <h2>
          {view === "timeline" ? "Timeline" : "Graph"} ({trace.observation_count})
        </h2>
        <div className="seg">
          <button type="button" className={view === "timeline" ? "active" : ""} onClick={() => setView("timeline")}>
            timeline
          </button>
          <button type="button" className={view === "graph" ? "active" : ""} onClick={() => setView("graph")}>
            graph
          </button>
        </div>
      </div>
      {view === "timeline" ? (
        <div className="waterfall">
          {layout(trace.observations).map((obs) => (
            <WaterfallRow key={obs.id} obs={obs} />
          ))}
        </div>
      ) : (
        <AgentGraph observations={trace.observations} />
      )}

      <h2>Payloads</h2>
      <div className="tree">
        {trace.observations.map((obs) => (
          <ObservationDetailRow key={obs.id} obs={obs} />
        ))}
      </div>

      <Comments traceId={trace.id} />
    </div>
  );
}

function Comments({ traceId }: { traceId: string }) {
  const qc = useQueryClient();
  const { data: comments } = useQuery({
    queryKey: ["comments", traceId],
    queryFn: () => api.listComments("TRACE", traceId),
  });
  const [text, setText] = useState("");
  const add = useMutation({
    mutationFn: () => api.createComment("TRACE", traceId, text),
    onSuccess: () => {
      setText("");
      qc.invalidateQueries({ queryKey: ["comments", traceId] });
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.deleteComment(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["comments", traceId] }),
  });

  return (
    <>
      <h2>Comments ({comments?.length ?? 0})</h2>
      <ul className="tree">
        {comments?.map((cm) => (
          <li key={cm.id}>
            <div className="obs-meta">
              {cm.author} · {cm.createdAt.slice(0, 19).replace("T", " ")}{" "}
              <button className="link-btn" onClick={() => remove.mutate(cm.id)}>
                delete
              </button>
            </div>
            <div>{cm.content}</div>
          </li>
        ))}
      </ul>
      <div className="filters">
        <input
          placeholder="Add a comment…"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && text && add.mutate()}
          style={{ width: 420 }}
        />
        <button disabled={!text || add.isPending} onClick={() => add.mutate()}>
          {add.isPending ? "Posting…" : "Comment"}
        </button>
      </div>
    </>
  );
}
