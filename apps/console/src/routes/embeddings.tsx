import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { RefreshCw, Rotate3d } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { EmptyState } from "../components/empty-state";
import { HelpTip } from "../components/help-tip";
import { PageHeader } from "../components/page-header";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { Skeleton } from "../components/ui/skeleton";
import { api } from "../lib/api";
import { useIsReadOnly } from "../lib/role";

export const Route = createFileRoute("/embeddings")({ component: EmbeddingsPage });

// Categorical cluster palette (theme-neutral, readable in light + dark).
const CLUSTER_COLORS = [
  "#4fb8b2",
  "#e0803a",
  "#6a8ec9",
  "#c065c0",
  "#79b356",
  "#d6605e",
  "#c9a227",
  "#8a7bd8",
  "#4aa3a3",
  "#b1743b",
];

const clusterColor = (id: number): string =>
  CLUSTER_COLORS[((id % CLUSTER_COLORS.length) + CLUSTER_COLORS.length) % CLUSTER_COLORS.length]!;

// Sequential ramp for color-by-score (low → high). Interpolated in RGB.
function ramp(t: number): string {
  const clamp = Math.max(0, Math.min(1, t));
  const lo = [214, 96, 94]; // red-ish (low score)
  const hi = [79, 184, 178]; // teal (high score)
  const c = lo.map((l, i) => Math.round(l + (hi[i]! - l) * clamp));
  return `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
}

const CANVAS_W = 900;
const CANVAS_H = 560;
const PAD = 32;
const SCALE = (Math.min(CANVAS_W, CANVAS_H) / 2 - PAD) / 1.25;

/** Rotate a centered/normalized point around Y (yaw) then X (pitch); returns screen coords + camera depth. */
function project(nx: number, ny: number, nz: number, yaw: number, pitch: number) {
  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);
  const x1 = nx * cy + nz * sy;
  const z1 = -nx * sy + nz * cy;
  const cp = Math.cos(pitch);
  const sp = Math.sin(pitch);
  const y2 = ny * cp - z1 * sp;
  const z2 = ny * sp + z1 * cp;
  return {
    cx: CANVAS_W / 2 + x1 * SCALE,
    cy: CANVAS_H / 2 - y2 * SCALE,
    depth: z2, // larger = closer to the viewer
  };
}

interface Projected {
  cx: number;
  cy: number;
  depth: number;
  color: string;
  traceId: string | null;
}

function EmbeddingsPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const readOnly = useIsReadOnly();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const projectedRef = useRef<Projected[]>([]);
  const [colorBy, setColorBy] = useState<string>("__cluster__");
  const [yaw, setYaw] = useState(0.6);
  const [pitch, setPitch] = useState(0.35);
  const [autoRotate, setAutoRotate] = useState(true);
  const dragRef = useRef<{ x: number; y: number } | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["embedding-projection", colorBy],
    queryFn: () => api.getEmbeddingProjection({ colorBy: colorBy === "__cluster__" ? undefined : colorBy }),
  });

  const runProjection = useMutation({
    mutationFn: () => api.runEmbeddingProjection(),
    onSuccess: (r) => {
      if (r.points > 0) {
        toast.success(`Projected ${r.points} points`);
        qc.invalidateQueries({ queryKey: ["embedding-projection"] });
      } else {
        toast.message("Need at least 2 observations with embeddings to project.");
      }
    },
    onError: (e) => toast.error(String(e)),
  });
  // Score names to color by (from the trace facets).
  const { data: facets } = useQuery({
    queryKey: ["trace-facets-scores"],
    queryFn: () => api.traceFacets({ days: 30 }),
  });

  const points = data?.points ?? [];

  const scoreExtent = useMemo(() => {
    const vals = points.map((p) => p.color_value).filter((v): v is number => v != null);
    return vals.length ? { min: Math.min(...vals), max: Math.max(...vals) } : null;
  }, [points]);

  // Normalize the projection into a centered unit cube once; rotation happens per-frame at draw time.
  const normalized = useMemo(() => {
    if (points.length === 0) return [];
    const axis = (get: (p: (typeof points)[number]) => number) => {
      const vals = points.map(get);
      const min = Math.min(...vals);
      const max = Math.max(...vals);
      const center = (min + max) / 2;
      const half = (max - min) / 2 || 1;
      return { center, half };
    };
    const ax = axis((p) => p.x);
    const ay = axis((p) => p.y);
    const az = axis((p) => p.z ?? 0);
    return points.map((p) => {
      let color: string;
      if (colorBy === "__cluster__") {
        color = clusterColor(p.cluster_id);
      } else if (p.color_value != null && scoreExtent) {
        const t =
          scoreExtent.max === scoreExtent.min
            ? 0.5
            : (p.color_value - scoreExtent.min) / (scoreExtent.max - scoreExtent.min);
        color = ramp(t);
      } else {
        color = "rgba(148,163,184,0.5)"; // no score — muted grey
      }
      return {
        nx: (p.x - ax.center) / ax.half,
        ny: (p.y - ay.center) / ay.half,
        nz: ((p.z ?? 0) - az.center) / az.half,
        color,
        traceId: p.trace_id,
      };
    });
  }, [points, colorBy, scoreExtent]);

  // Per-cluster analysis: count + mean of the active color-by score.
  const clusterStats = useMemo(() => {
    const by = new Map<number, { count: number; sum: number; scored: number }>();
    for (const p of points) {
      const s = by.get(p.cluster_id) ?? { count: 0, sum: 0, scored: 0 };
      s.count++;
      if (p.color_value != null) {
        s.sum += p.color_value;
        s.scored++;
      }
      by.set(p.cluster_id, s);
    }
    return [...by.entries()]
      .map(([id, s]) => ({ id, count: s.count, avg: s.scored ? s.sum / s.scored : null }))
      .sort((a, b) => b.count - a.count);
  }, [points]);

  const draw = useCallback(
    (curYaw: number, curPitch: number) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);
      const proj: Projected[] = normalized.map((n) => {
        const { cx, cy, depth } = project(n.nx, n.ny, n.nz, curYaw, curPitch);
        return { cx, cy, depth, color: n.color, traceId: n.traceId };
      });
      // Painter's algorithm: draw far points first so near points sit on top.
      proj.sort((a, b) => a.depth - b.depth);
      projectedRef.current = proj;
      for (const pt of proj) {
        // Depth cue: nearer points are larger and more opaque (depth ∈ ~[-1.7, 1.7]).
        const d = (pt.depth + 1.7) / 3.4;
        const r = 2 + d * 3.5;
        ctx.beginPath();
        ctx.arc(pt.cx, pt.cy, r, 0, Math.PI * 2);
        ctx.fillStyle = pt.color;
        ctx.globalAlpha = 0.4 + d * 0.5;
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    },
    [normalized],
  );

  // Redraw whenever the layout, coloring, or rotation changes.
  useEffect(() => {
    draw(yaw, pitch);
  }, [draw, yaw, pitch]);

  // Auto-rotate (paused while dragging or when toggled off).
  useEffect(() => {
    if (!autoRotate || normalized.length === 0) return;
    let raf = 0;
    const tick = () => {
      setYaw((y) => y + 0.005);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [autoRotate, normalized.length]);

  function onPointerDown(e: React.PointerEvent<HTMLCanvasElement>) {
    dragRef.current = { x: e.clientX, y: e.clientY };
    setAutoRotate(false);
    e.currentTarget.setPointerCapture(e.pointerId);
  }
  function onPointerMove(e: React.PointerEvent<HTMLCanvasElement>) {
    const start = dragRef.current;
    if (!start) return;
    const dx = e.clientX - start.x;
    const dy = e.clientY - start.y;
    dragRef.current = { x: e.clientX, y: e.clientY };
    setYaw((y) => y + dx * 0.01);
    setPitch((p) => Math.max(-1.4, Math.min(1.4, p + dy * 0.01)));
  }
  function onPointerUp(e: React.PointerEvent<HTMLCanvasElement>) {
    // A click without meaningful drag opens the nearest point's trace.
    const start = dragRef.current;
    dragRef.current = null;
    e.currentTarget.releasePointerCapture(e.pointerId);
    if (!start) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const mx = ((e.clientX - rect.left) / rect.width) * CANVAS_W;
    const my = ((e.clientY - rect.top) / rect.height) * CANVAS_H;
    let best: Projected | null = null;
    let bestD = 12 * 12; // hit radius²
    for (const pt of projectedRef.current) {
      const dd = (pt.cx - mx) ** 2 + (pt.cy - my) ** 2;
      if (dd < bestD) {
        bestD = dd;
        best = pt;
      }
    }
    if (best?.traceId) navigate({ to: "/traces/$id", params: { id: best.traceId } });
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Embeddings"
        description="3D projection of observation embeddings — rotate to explore clusters and outliers; color by a score to find problem areas."
        help="Flattens the high-dimensional embedding vectors your app logs (for retrieval and RAG) onto a 3D map so nearby points mean similar content and clusters reveal outliers. Drag to rotate."
        actions={
          !readOnly ? (
            <Button
              size="sm"
              variant="outline"
              disabled={runProjection.isPending}
              onClick={() => runProjection.mutate()}
            >
              <RefreshCw className={`mr-1.5 size-4 ${runProjection.isPending ? "animate-spin" : ""}`} />
              {runProjection.isPending ? "Projecting…" : "Run projection"}
            </Button>
          ) : undefined
        }
      />
      <div className="grid gap-6 lg:grid-cols-[1fr_260px]">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
            <CardTitle className="inline-flex items-center gap-1">
              Projection {data?.run_id ? `(${data.points.length} points)` : ""}
              <HelpTip>
                Each dot is one observation's embedding placed by similarity in 3D; points are grouped into clusters,
                and coloring by a score highlights where quality drops. Drag to rotate.
              </HelpTip>
            </CardTitle>
            <div className="flex items-center gap-2">
              <Button size="sm" variant={autoRotate ? "secondary" : "outline"} onClick={() => setAutoRotate((v) => !v)}>
                <Rotate3d className="mr-1.5 size-4" />
                {autoRotate ? "Spinning" : "Rotate"}
              </Button>
              <Select value={colorBy} onValueChange={setColorBy}>
                <SelectTrigger className="w-[180px]">
                  <SelectValue placeholder="Color by" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__cluster__">Color by cluster</SelectItem>
                  {(facets?.scores ?? []).map((s) => (
                    <SelectItem key={s.value} value={s.value}>
                      Color by {s.value}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <Skeleton className="h-[560px] w-full" />
            ) : points.length === 0 ? (
              <EmptyState
                title="No projection yet"
                description="Ingest observations with embeddings, then run the projection (or wait for the daily job) to compute the layout."
                action={
                  !readOnly ? (
                    <Button size="sm" disabled={runProjection.isPending} onClick={() => runProjection.mutate()}>
                      <RefreshCw className={`mr-1.5 size-4 ${runProjection.isPending ? "animate-spin" : ""}`} />
                      Run projection
                    </Button>
                  ) : undefined
                }
              />
            ) : (
              <div className="overflow-x-auto">
                <canvas
                  ref={canvasRef}
                  width={CANVAS_W}
                  height={CANVAS_H}
                  onPointerDown={onPointerDown}
                  onPointerMove={onPointerMove}
                  onPointerUp={onPointerUp}
                  className="max-w-full cursor-grab touch-none rounded-md border bg-card active:cursor-grabbing"
                  style={{ aspectRatio: `${CANVAS_W} / ${CANVAS_H}` }}
                />
                <p className="mt-2 text-xs text-muted-foreground">Drag to rotate · click a point to open its trace.</p>
              </div>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="inline-flex items-center gap-1 text-sm">
              Clusters
              <HelpTip>
                Points grouped by embedding similarity. The average is the mean of the currently selected score across
                each cluster — a low-scoring cluster is a pocket of similar content that's underperforming.
              </HelpTip>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {clusterStats.length === 0 ? (
              <p className="text-xs text-muted-foreground">No clusters yet.</p>
            ) : (
              clusterStats.map((c) => (
                <div key={c.id} className="flex items-center justify-between gap-2 text-sm">
                  <span className="inline-flex items-center gap-2">
                    <span
                      className="inline-block size-3 shrink-0 rounded-full"
                      style={{ backgroundColor: clusterColor(c.id) }}
                    />
                    <span className="text-muted-foreground">Cluster {c.id}</span>
                  </span>
                  <span className="tabular-nums">
                    {c.count}
                    {c.avg != null ? <span className="ml-2 text-muted-foreground">avg {c.avg.toFixed(2)}</span> : null}
                  </span>
                </div>
              ))
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
