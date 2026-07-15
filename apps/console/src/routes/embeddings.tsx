import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { RefreshCw } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { EmptyState } from "../components/empty-state";
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
const PAD = 24;

function EmbeddingsPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const readOnly = useIsReadOnly();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [colorBy, setColorBy] = useState<string>("__cluster__");

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

  // Precompute canvas coordinates from the projection extents.
  const laid = useMemo(() => {
    if (points.length === 0) return [];
    const xs = points.map((p) => p.x);
    const ys = points.map((p) => p.y);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    const sx = maxX - minX || 1;
    const sy = maxY - minY || 1;
    return points.map((p) => ({
      p,
      cx: PAD + ((p.x - minX) / sx) * (CANVAS_W - 2 * PAD),
      cy: PAD + ((p.y - minY) / sy) * (CANVAS_H - 2 * PAD),
    }));
  }, [points]);

  const scoreExtent = useMemo(() => {
    const vals = points.map((p) => p.color_value).filter((v): v is number => v != null);
    return vals.length ? { min: Math.min(...vals), max: Math.max(...vals) } : null;
  }, [points]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);
    for (const { p, cx, cy } of laid) {
      let color: string;
      if (colorBy === "__cluster__") {
        color =
          CLUSTER_COLORS[((p.cluster_id % CLUSTER_COLORS.length) + CLUSTER_COLORS.length) % CLUSTER_COLORS.length]!;
      } else if (p.color_value != null && scoreExtent) {
        const t =
          scoreExtent.max === scoreExtent.min
            ? 0.5
            : (p.color_value - scoreExtent.min) / (scoreExtent.max - scoreExtent.min);
        color = ramp(t);
      } else {
        color = "rgba(148,163,184,0.5)"; // no score — muted grey
      }
      ctx.beginPath();
      ctx.arc(cx, cy, 3.5, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.globalAlpha = 0.8;
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }, [laid, colorBy, scoreExtent]);

  function onCanvasClick(e: React.MouseEvent<HTMLCanvasElement>) {
    const canvas = canvasRef.current;
    if (!canvas || laid.length === 0) return;
    const rect = canvas.getBoundingClientRect();
    const mx = ((e.clientX - rect.left) / rect.width) * CANVAS_W;
    const my = ((e.clientY - rect.top) / rect.height) * CANVAS_H;
    let best: (typeof laid)[number] | null = null;
    let bestD = 12 * 12; // hit radius²
    for (const l of laid) {
      const d = (l.cx - mx) ** 2 + (l.cy - my) ** 2;
      if (d < bestD) {
        bestD = d;
        best = l;
      }
    }
    if (best?.p.trace_id) navigate({ to: "/traces/$id", params: { id: best.p.trace_id } });
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Embeddings"
        description="2D projection of observation embeddings — clusters surface outliers; color by a score to find problem areas."
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
      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
          <CardTitle>Projection {data?.run_id ? `(${data.points.length} points)` : ""}</CardTitle>
          <Select value={colorBy} onValueChange={setColorBy}>
            <SelectTrigger className="w-[200px]">
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
                onClick={onCanvasClick}
                className="max-w-full cursor-pointer rounded-md border bg-card"
                style={{ aspectRatio: `${CANVAS_W} / ${CANVAS_H}` }}
              />
              <p className="mt-2 text-xs text-muted-foreground">Click a point to open its trace.</p>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
