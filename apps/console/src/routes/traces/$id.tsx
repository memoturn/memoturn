import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Download, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { EmptyState } from "../../components/empty-state";
import { KindBadge, type KindBadgeTone, toneForKind } from "../../components/kind-badge";
import { PageHeader } from "../../components/page-header";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "../../components/ui/accordion";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "../../components/ui/breadcrumb";
import { Button } from "../../components/ui/button";
import { Skeleton } from "../../components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../components/ui/tabs";
import { Textarea } from "../../components/ui/textarea";
import { api, type ObservationDetail } from "../../lib/api";
import { useIsReadOnly } from "../../lib/role";

export const Route = createFileRoute("/traces/$id")({ component: TraceDetailPage });

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

/** Tone for a trace score source (EVAL / ANNOTATION / other). */
function toneForSource(source: string): KindBadgeTone {
  if (source === "EVAL") return "blue";
  if (source === "ANNOTATION") return "green";
  return "amber";
}

const PRE_CLASS = "overflow-auto rounded-md border bg-muted/50 p-3 text-xs max-h-80";

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
    <div className="my-2 flex flex-wrap gap-2">
      {markers.map((m) => {
        const key = m.slice("memoturn-media://".length);
        const url = `${MEDIA_BASE}/v1/media/${key}`;
        return IMG_EXT.test(key) ? (
          <img key={m} className="h-24 rounded-md border object-cover" src={url} alt="attachment" />
        ) : (
          <Button key={m} asChild variant="outline" size="sm">
            <a href={url} target="_blank" rel="noreferrer">
              <Download className="size-3.5" /> download
            </a>
          </Button>
        );
      })}
      {dataImgs.map((d) => (
        <img key={d.slice(0, 48)} className="h-24 rounded-md border object-cover" src={d} alt="inline attachment" />
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

function barColor(type: string): string {
  if (type === "GENERATION") return "bg-primary";
  if (type === "SPAN") return "bg-emerald-500";
  return "bg-amber-500";
}

function WaterfallRow({ obs }: { obs: Laid }) {
  return (
    <div className="grid grid-cols-[280px_1fr] items-center border-b last:border-b-0 hover:bg-muted/50">
      <div
        className="overflow-hidden text-ellipsis whitespace-nowrap px-3 py-2"
        style={{ paddingLeft: `${obs.depth * 16}px` }}
      >
        <KindBadge tone={toneForKind(obs.type)}>{obs.type.toLowerCase()}</KindBadge>{" "}
        <span className="font-medium">{obs.name || obs.id.slice(0, 8)}</span>
        {obs.model && <span className="text-muted-foreground"> · {obs.model}</span>}
      </div>
      <div className="relative mr-3 h-7">
        <div
          className={`absolute top-[9px] h-2.5 min-w-[3px] rounded-[3px] ${barColor(obs.type)}`}
          style={{ left: `${obs.offsetPct}%`, width: `${obs.widthPct}%` }}
          title={`${obs.latency_ms} ms`}
        />
        <span
          className="pointer-events-none absolute top-1.5 translate-x-1.5 text-[11px] tabular-nums text-muted-foreground"
          style={{ left: `min(${obs.offsetPct}%, 80%)` }}
        >
          {obs.latency_ms} ms
        </span>
      </div>
    </div>
  );
}

// ── Agent graph: nodes = observations, edges = parent links, layered by depth ─────
const GRAPH_COLOR: Record<string, string> = {
  GENERATION: "text-blue-500",
  SPAN: "text-emerald-500",
  EVENT: "text-amber-500",
};
const NODE_W = 172;
const NODE_H = 34;
const HGAP = 48;
const VGAP = 14;

function AgentGraph({ observations }: { observations: ObservationDetail[] }) {
  if (observations.length === 0) return <EmptyState title="No observations to graph." />;

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
    <div className="overflow-x-auto rounded-lg border p-4">
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
              stroke="var(--border)"
              strokeWidth={1.5}
            />
          );
        })}
        {observations.map((o) => {
          const p = pos.get(o.id);
          if (!p) return null;
          const label = o.name || o.id.slice(0, 8);
          return (
            <g
              key={o.id}
              transform={`translate(${p.x}, ${p.y})`}
              className={GRAPH_COLOR[o.type] ?? "text-muted-foreground"}
            >
              <title>{`${o.type} · ${o.name || o.id}${o.model ? ` · ${o.model}` : ""} · ${o.latency_ms} ms`}</title>
              <rect width={NODE_W} height={NODE_H} rx={7} fill="var(--card)" stroke="currentColor" strokeWidth={1.5} />
              <circle cx={14} cy={NODE_H / 2} r={4} fill="currentColor" />
              <text x={26} y={NODE_H / 2 + 4} fill="var(--foreground)" fontSize={12}>
                {label.length > 20 ? `${label.slice(0, 19)}…` : label}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function visibleObservations(observations: ObservationDetail[]): ObservationDetail[] {
  return observations.filter((obs) => obs.input || obs.output || obs.level !== "DEFAULT");
}

function ObservationDetailItem({ obs }: { obs: ObservationDetail }) {
  return (
    <AccordionItem value={obs.id}>
      <AccordionTrigger>
        <div className="flex flex-wrap items-center gap-2">
          <KindBadge tone={toneForKind(obs.type)}>{obs.type.toLowerCase()}</KindBadge>
          <span className="font-medium">{obs.name || obs.id.slice(0, 8)}</span>
          {obs.total_tokens > 0 && <span className="text-muted-foreground">· {obs.total_tokens} tok</span>}
          {Number(obs.total_cost) > 0 && (
            <span className="text-muted-foreground">· ${Number(obs.total_cost).toFixed(6)}</span>
          )}
          {obs.level !== "DEFAULT" && <span className="text-muted-foreground">· {obs.level}</span>}
        </div>
      </AccordionTrigger>
      <AccordionContent className="space-y-3">
        <MediaPreview raw={obs.input} />
        <MediaPreview raw={obs.output} />
        {obs.input && <pre className={PRE_CLASS}>{pretty(obs.input)}</pre>}
        {obs.output && <pre className={PRE_CLASS}>{pretty(obs.output)}</pre>}
        {obs.status_message && <pre className={PRE_CLASS}>{obs.status_message}</pre>}
      </AccordionContent>
    </AccordionItem>
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

  if (isLoading) return <Skeleton className="h-64 w-full" />;
  if (error) return <EmptyState title="Failed to load trace" description={String(error)} />;
  if (!trace) return <EmptyState title="Trace not found" />;

  const payloadObs = visibleObservations(trace.observations);

  return (
    <div className="space-y-6">
      <Breadcrumb>
        <BreadcrumbList>
          <BreadcrumbItem>
            <BreadcrumbLink asChild>
              <Link to="/traces">Traces</Link>
            </BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbPage>{trace.name || trace.id}</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>

      <PageHeader title={trace.name || trace.id} />

      <dl className="grid grid-cols-[160px_1fr] gap-x-4 gap-y-2 text-sm">
        <dt className="text-muted-foreground">Trace ID</dt>
        <dd>{trace.id}</dd>
        <dt className="text-muted-foreground">Timestamp</dt>
        <dd>{trace.timestamp}</dd>
        <dt className="text-muted-foreground">Environment</dt>
        <dd>{trace.environment}</dd>
        {trace.user_id && (
          <>
            <dt className="text-muted-foreground">User</dt>
            <dd>{trace.user_id}</dd>
          </>
        )}
        {trace.session_id && (
          <>
            <dt className="text-muted-foreground">Session</dt>
            <dd>{trace.session_id}</dd>
          </>
        )}
        <dt className="text-muted-foreground">Total tokens</dt>
        <dd>{trace.total_tokens}</dd>
        <dt className="text-muted-foreground">Total cost</dt>
        <dd>{Number(trace.total_cost) > 0 ? `$${Number(trace.total_cost).toFixed(6)}` : "—"}</dd>
        <dt className="text-muted-foreground">Latency</dt>
        <dd>{trace.latency_ms} ms</dd>
      </dl>

      <MediaPreview raw={trace.input} />
      <MediaPreview raw={trace.output} />

      {trace.scores.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-lg font-semibold tracking-tight">Scores ({trace.scores.length})</h2>
          <div className="flex flex-wrap gap-2">
            {trace.scores.map((s, i) => (
              <div
                key={i}
                title={s.comment}
                className="inline-flex items-center gap-1.5 border bg-card px-2 py-1 text-sm"
              >
                <KindBadge tone={toneForSource(s.source)}>{s.source.toLowerCase()}</KindBadge>
                <span className="text-muted-foreground">{s.name}</span>
                <span className="font-medium">{s.value != null ? s.value : s.string_value || "—"}</span>
                {s.comment && <span className="text-muted-foreground">{s.comment}</span>}
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="space-y-3">
        <Tabs value={view} onValueChange={(v) => setView(v as "timeline" | "graph")}>
          <div className="flex flex-wrap items-baseline justify-between gap-3">
            <h2 className="text-lg font-semibold tracking-tight">
              {view === "timeline" ? "Timeline" : "Graph"} ({trace.observation_count})
            </h2>
            <TabsList>
              <TabsTrigger value="timeline">timeline</TabsTrigger>
              <TabsTrigger value="graph">graph</TabsTrigger>
            </TabsList>
          </div>
          <TabsContent value="timeline">
            <div className="overflow-hidden rounded-lg border">
              {layout(trace.observations).map((obs) => (
                <WaterfallRow key={obs.id} obs={obs} />
              ))}
            </div>
          </TabsContent>
          <TabsContent value="graph">
            <AgentGraph observations={trace.observations} />
          </TabsContent>
        </Tabs>
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold tracking-tight">Payloads</h2>
        {payloadObs.length === 0 ? (
          <EmptyState title="No payloads to show." />
        ) : (
          <Accordion type="multiple" className="rounded-lg border px-4">
            {payloadObs.map((obs) => (
              <ObservationDetailItem key={obs.id} obs={obs} />
            ))}
          </Accordion>
        )}
      </section>

      <Comments traceId={trace.id} />
    </div>
  );
}

function Comments({ traceId }: { traceId: string }) {
  const qc = useQueryClient();
  const readOnly = useIsReadOnly();
  const { data: comments } = useQuery({
    queryKey: ["comments", traceId],
    queryFn: () => api.listComments("TRACE", traceId),
  });
  const [text, setText] = useState("");
  const add = useMutation({
    mutationFn: () => api.createComment("TRACE", traceId, text),
    onSuccess: () => {
      setText("");
      toast.success("Comment posted");
      qc.invalidateQueries({ queryKey: ["comments", traceId] });
    },
    onError: (e) => toast.error(`Failed to post comment: ${String(e)}`),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.deleteComment(id),
    onSuccess: () => {
      toast.success("Comment deleted");
      qc.invalidateQueries({ queryKey: ["comments", traceId] });
    },
    onError: (e) => toast.error(`Failed to delete comment: ${String(e)}`),
  });

  return (
    <section className="space-y-3">
      <h2 className="text-lg font-semibold tracking-tight">Comments ({comments?.length ?? 0})</h2>
      <ul className="space-y-3">
        {comments?.map((cm) => (
          <li key={cm.id} className="rounded-lg border p-3">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span>
                {cm.author} · {cm.createdAt.slice(0, 19).replace("T", " ")}
              </span>
              <Button
                variant="ghost"
                size="icon"
                className="size-6 text-muted-foreground hover:text-destructive"
                disabled={readOnly || remove.isPending}
                onClick={() => remove.mutate(cm.id)}
                aria-label="Delete comment"
              >
                <Trash2 className="size-3.5" />
              </Button>
            </div>
            <div className="mt-1 text-sm">{cm.content}</div>
          </li>
        ))}
      </ul>
      <div className="space-y-2">
        <Textarea
          placeholder="Add a comment…"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && text) add.mutate();
          }}
          rows={3}
        />
        <Button disabled={readOnly || !text || add.isPending} onClick={() => add.mutate()}>
          {add.isPending ? "Posting…" : "Comment"}
        </Button>
      </div>
    </section>
  );
}
