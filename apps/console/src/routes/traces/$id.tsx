import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Coins, DollarSign, Download, Layers, RotateCcw, Timer, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { CopyButton } from "../../components/copy-button";
import { EmptyState } from "../../components/empty-state";
import { KindBadge, type KindBadgeTone, toneForKind } from "../../components/kind-badge";
import { StatTile } from "../../components/stat-tile";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "../../components/ui/accordion";
import { Badge } from "../../components/ui/badge";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "../../components/ui/breadcrumb";
import { Button } from "../../components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "../../components/ui/card";
import { Skeleton } from "../../components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../components/ui/tabs";
import { Textarea } from "../../components/ui/textarea";
import { api, fetchOffloadedPayload, type ObservationDetail } from "../../lib/api";
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

const PRE_CLASS = "overflow-auto border bg-muted/50 p-3 text-xs max-h-80";

/** Parse a large-payload offload marker ({_truncated, ref, preview, bytes}), else null. */
function truncatedMarker(raw: string): { ref: string; preview: string; bytes: number } | null {
  if (!raw?.includes("_truncated")) return null;
  try {
    const v = JSON.parse(raw);
    if (v && typeof v === "object" && v._truncated === true && typeof v.ref === "string") {
      return { ref: v.ref, preview: String(v.preview ?? ""), bytes: Number(v.bytes ?? 0) };
    }
  } catch {
    /* not a marker */
  }
  return null;
}

/**
 * Render an input/output payload. If it was offloaded to blob at ingest (too large for
 * ClickHouse), show the stored preview + a button to fetch the full value on demand.
 */
function PayloadView({ raw }: { raw: string }) {
  const marker = truncatedMarker(raw);
  const [full, setFull] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  if (!marker) return <pre className={PRE_CLASS}>{pretty(raw)}</pre>;
  if (full !== null) return <pre className={PRE_CLASS}>{pretty(full)}</pre>;

  const load = async () => {
    setLoading(true);
    try {
      setFull(await fetchOffloadedPayload(marker.ref));
    } catch (e) {
      toast.error(`Failed to load payload: ${String(e)}`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-2">
      <pre className={PRE_CLASS}>{pretty(marker.preview)}…</pre>
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span>Truncated · {(marker.bytes / 1024).toFixed(0)} KB offloaded to blob</span>
        <Button variant="outline" size="sm" disabled={loading} onClick={load}>
          {loading ? "Loading…" : "Load full payload"}
        </Button>
      </div>
    </div>
  );
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
    <div className="my-2 flex flex-wrap gap-2">
      {markers.map((m) => {
        const key = m.slice("memoturn-media://".length);
        const url = `${MEDIA_BASE}/v1/media/${key}`;
        return IMG_EXT.test(key) ? (
          <img key={m} className="h-24 border object-cover" src={url} alt="attachment" />
        ) : (
          <Button key={m} asChild variant="outline" size="sm">
            <a href={url} target="_blank" rel="noreferrer">
              <Download className="size-3.5" /> download
            </a>
          </Button>
        );
      })}
      {dataImgs.map((d) => (
        <img key={d.slice(0, 48)} className="h-24 border object-cover" src={d} alt="inline attachment" />
      ))}
    </div>
  );
}

interface Laid extends ObservationDetail {
  depth: number;
  offsetPct: number;
  widthPct: number;
  startOffsetMs: number;
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
  // end_time can be coarser than latency_ms (second precision), so trust whichever runs longer
  const ends = observations.map((o, i) => Math.max(ms(o.end_time) ?? 0, starts[i]! + Number(o.latency_ms)));
  const traceStart = Math.min(...starts);
  const total = Math.max(1, Math.max(...ends) - traceStart);

  return observations
    .map((o, i) => {
      const offsetPct = Math.min(((starts[i]! - traceStart) / total) * 100, 98.5);
      const widthPct = Math.max(1.5, Math.min((Number(o.latency_ms) / total) * 100, 100 - offsetPct));
      return { ...o, depth: depthOf(o), offsetPct, widthPct, startOffsetMs: starts[i]! - traceStart };
    })
    .sort((a, b) => (ms(a.start_time) ?? 0) - (ms(b.start_time) ?? 0));
}

/** Bar hues match the KindBadge tones (blue = generation, emerald = span, amber = event). */
function barColor(type: string): string {
  if (type === "GENERATION") return "bg-blue-500";
  if (type === "SPAN") return "bg-emerald-500";
  return "bg-amber-500";
}

const WATERFALL_COLS = "grid-cols-[320px_1fr_5.5rem]";

function WaterfallRow({ obs }: { obs: Laid }) {
  const label = `${obs.name || obs.id.slice(0, 8)}${obs.model ? ` · ${obs.model}` : ""}`;
  return (
    <div className={`grid ${WATERFALL_COLS} items-center border-b last:border-b-0 hover:bg-muted/50`}>
      <div
        className="overflow-hidden text-ellipsis whitespace-nowrap py-2 pr-3"
        style={{ paddingLeft: `${12 + obs.depth * 16}px` }}
        title={label}
      >
        <KindBadge tone={toneForKind(obs.type)}>{obs.type.toLowerCase()}</KindBadge>{" "}
        <span className="font-medium">{obs.name || obs.id.slice(0, 8)}</span>
        {obs.model && <span className="text-muted-foreground"> · {obs.model}</span>}
      </div>
      <div className="relative mr-4 h-7" title={`+${Math.round(obs.startOffsetMs)} ms → ${obs.latency_ms} ms`}>
        <div
          className={`absolute top-1/2 h-2.5 min-w-[3px] -translate-y-1/2 rounded-[3px] ${barColor(obs.type)}`}
          style={{ left: `${obs.offsetPct}%`, width: `${obs.widthPct}%` }}
        />
      </div>
      <span className="py-2 pr-3 text-right text-xs tabular-nums text-muted-foreground">{obs.latency_ms} ms</span>
    </div>
  );
}

// ── Agent graph: nodes = observations, edges = parent links, layered by depth ─────
const GRAPH_COLOR: Record<string, string> = {
  GENERATION: "text-blue-500",
  SPAN: "text-emerald-500",
  EVENT: "text-amber-500",
};
const NODE_W = 176;
const NODE_H = 44;
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
    <div className="overflow-x-auto py-2">
      <svg width={width + 3} height={height + 3} role="img" aria-label="Agent run graph">
        <title>Agent run graph</title>
        <g transform="translate(1.5, 1.5)">
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
            const meta = [o.model, `${o.latency_ms} ms`].filter(Boolean).join(" · ");
            return (
              <g
                key={o.id}
                transform={`translate(${p.x}, ${p.y})`}
                className={GRAPH_COLOR[o.type] ?? "text-muted-foreground"}
              >
                <title>{`${o.type} · ${o.name || o.id}${o.model ? ` · ${o.model}` : ""} · ${o.latency_ms} ms`}</title>
                <rect
                  width={NODE_W}
                  height={NODE_H}
                  rx={0}
                  fill="currentColor"
                  fillOpacity={0.06}
                  stroke="currentColor"
                  strokeOpacity={0.4}
                  strokeWidth={1.5}
                />
                <circle cx={14} cy={17} r={4} fill="currentColor" />
                <text x={26} y={21} fill="var(--foreground)" fontSize={12} fontWeight={500}>
                  {label.length > 22 ? `${label.slice(0, 21)}…` : label}
                </text>
                <text x={26} y={35} fill="var(--muted-foreground)" fontSize={10}>
                  {meta.length > 28 ? `${meta.slice(0, 27)}…` : meta}
                </text>
              </g>
            );
          })}
        </g>
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
        {obs.input && (
          <div className="space-y-1">
            <div className="text-[0.6875rem] font-medium tracking-wide text-muted-foreground uppercase">Input</div>
            <PayloadView raw={obs.input} />
          </div>
        )}
        {obs.output && (
          <div className="space-y-1">
            <div className="text-[0.6875rem] font-medium tracking-wide text-muted-foreground uppercase">Output</div>
            <PayloadView raw={obs.output} />
          </div>
        )}
        {obs.status_message && (
          <div className="space-y-1">
            <div className="text-[0.6875rem] font-medium tracking-wide text-muted-foreground uppercase">Status</div>
            <pre className={PRE_CLASS}>{obs.status_message}</pre>
          </div>
        )}
      </AccordionContent>
    </AccordionItem>
  );
}

function TraceDetailPage() {
  const { id } = Route.useParams();
  const [view, setView] = useState<"timeline" | "graph">("timeline");
  const qc = useQueryClient();
  const readOnly = useIsReadOnly();
  const {
    data: trace,
    isLoading,
    error,
  } = useQuery({
    queryKey: ["trace", id],
    queryFn: () => api.getTrace(id),
  });

  const replay = useMutation({
    mutationFn: () => api.replayTrace(id),
    onSuccess: (result) => {
      toast.success(result.traceId ? `Replay recorded — trace ${result.traceId}` : "Replay complete");
      qc.invalidateQueries({ queryKey: ["traces"] });
    },
    onError: (e) => toast.error(`Replay failed: ${String(e)}`),
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
            <BreadcrumbPage className="max-w-[40ch] truncate">{trace.name || trace.id}</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <h1 className="truncate text-2xl font-semibold tracking-tight">{trace.name || trace.id}</h1>
          <div className="flex items-center gap-1 text-muted-foreground">
            <span className="font-mono text-xs">{trace.id}</span>
            <CopyButton value={trace.id} label="trace id" />
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="secondary" className="font-medium">
            {trace.environment}
          </Badge>
          <Button variant="outline" size="sm" disabled={readOnly || replay.isPending} onClick={() => replay.mutate()}>
            <RotateCcw className="size-3.5" />
            {replay.isPending ? "Replaying…" : "Replay"}
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <StatTile label="Observations" value={trace.observation_count} icon={Layers} />
        <StatTile label="Tokens" value={trace.total_tokens} icon={Coins} />
        <StatTile
          label="Cost"
          value={Number(trace.total_cost) > 0 ? `$${Number(trace.total_cost).toFixed(6)}` : "—"}
          icon={DollarSign}
        />
        <StatTile label="Latency" value={`${trace.latency_ms} ms`} icon={Timer} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Details</CardTitle>
          <CardDescription>Trace metadata and linked entities.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <dl className="grid grid-cols-[120px_1fr] gap-x-4 gap-y-2.5 text-sm">
            <dt className="text-muted-foreground">Timestamp</dt>
            <dd className="tabular-nums">{trace.timestamp.replace("T", " ").replace("Z", " UTC")}</dd>
            {trace.user_id && (
              <>
                <dt className="text-muted-foreground">User</dt>
                <dd className="font-mono text-xs">{trace.user_id}</dd>
              </>
            )}
            {trace.session_id && (
              <>
                <dt className="text-muted-foreground">Session</dt>
                <dd className="flex items-center gap-1">
                  <Link
                    to="/sessions/$id"
                    params={{ id: trace.session_id }}
                    className="truncate font-mono text-xs text-primary hover:underline"
                  >
                    {trace.session_id}
                  </Link>
                  <CopyButton value={trace.session_id} label="session id" />
                </dd>
              </>
            )}
          </dl>
          <MediaPreview raw={trace.input} />
          <MediaPreview raw={trace.output} />
          {/* Surface truncated trace payloads (otherwise the Details card shows only metadata/media). */}
          {truncatedMarker(trace.input) && <PayloadView raw={trace.input} />}
          {truncatedMarker(trace.output) && <PayloadView raw={trace.output} />}
        </CardContent>
      </Card>

      {trace.scores.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Scores ({trace.scores.length})</CardTitle>
            <CardDescription>Evaluations and annotations recorded on this trace.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-2">
              {trace.scores.map((s, i) => (
                <div
                  key={i}
                  title={s.comment}
                  className="inline-flex items-center gap-1.5 border bg-background px-2 py-1 text-sm"
                >
                  <KindBadge tone={toneForSource(s.source)}>{s.source.toLowerCase()}</KindBadge>
                  <span className="text-muted-foreground">{s.name}</span>
                  <span className="font-medium tabular-nums">{s.value != null ? s.value : s.string_value || "—"}</span>
                  {s.comment && <span className="max-w-[48ch] truncate text-muted-foreground">{s.comment}</span>}
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <Tabs value={view} onValueChange={(v) => setView(v as "timeline" | "graph")}>
          <CardHeader>
            <CardTitle>Observations ({trace.observation_count})</CardTitle>
            <CardDescription>Execution timeline and call graph for this trace.</CardDescription>
            <CardAction>
              <TabsList>
                <TabsTrigger value="timeline">Timeline</TabsTrigger>
                <TabsTrigger value="graph">Graph</TabsTrigger>
              </TabsList>
            </CardAction>
          </CardHeader>
          <CardContent className="px-0">
            <TabsContent value="timeline" className="mt-0">
              {trace.observations.length === 0 ? (
                <div className="px-6">
                  <EmptyState title="No observations." />
                </div>
              ) : (
                <div className="overflow-x-auto border-t">
                  <div
                    className={`grid ${WATERFALL_COLS} border-b bg-muted/30 py-1.5 text-[0.6875rem] font-medium tracking-wide text-muted-foreground uppercase`}
                  >
                    <span className="px-3">Observation</span>
                    <span>Timeline</span>
                    <span className="pr-3 text-right">Duration</span>
                  </div>
                  {layout(trace.observations).map((obs) => (
                    <WaterfallRow key={obs.id} obs={obs} />
                  ))}
                </div>
              )}
            </TabsContent>
            <TabsContent value="graph" className="mt-0 px-6">
              <AgentGraph observations={trace.observations} />
            </TabsContent>
          </CardContent>
        </Tabs>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Payloads</CardTitle>
          <CardDescription>Inputs and outputs captured per observation.</CardDescription>
        </CardHeader>
        <CardContent className={payloadObs.length === 0 ? undefined : "px-0"}>
          {payloadObs.length === 0 ? (
            <EmptyState title="No payloads to show." />
          ) : (
            <Accordion type="multiple" className="border-t px-6">
              {payloadObs.map((obs) => (
                <ObservationDetailItem key={obs.id} obs={obs} />
              ))}
            </Accordion>
          )}
        </CardContent>
      </Card>

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
    <Card>
      <CardHeader>
        <CardTitle>Comments ({comments?.length ?? 0})</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {comments && comments.length > 0 && (
          <ul className="space-y-3">
            {comments.map((cm) => (
              <li key={cm.id} className="border bg-background p-3">
                <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
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
        )}
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
      </CardContent>
    </Card>
  );
}
