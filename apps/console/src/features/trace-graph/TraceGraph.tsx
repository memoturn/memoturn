import type { ObservationDetail } from "@memoturn/contracts";
import { useMemo, useState } from "react";
import { EmptyState } from "../../components/empty-state";
import { Button } from "../../components/ui/button";
import { buildGraph, END, type GraphMode, type GraphObs, START } from "./build-graph";

/**
 * Agent-flow graph for a trace — a layered node/edge diagram derived from the observation tree
 * (see build-graph.ts). Aggregated collapses repeated node names (×N, loops render as cycles);
 * Expanded shows one node per observation as an acyclic DAG. Rendered as HTML node boxes over an
 * SVG edge layer (no external graph library); node color tracks observation type.
 */

const NODE_W = 150;
const NODE_H = 40;
const GAP_X = 28;
const GAP_Y = 52;
// Above this, a hand-rolled layered layout gets unreadable — steer to the other mode / waterfall.
const MAX_NODES = 300;

const NODE_TONE: Record<string, string> = {
  GENERATION: "border-blue-500/40 bg-blue-500/10 text-blue-700 dark:text-blue-300",
  SPAN: "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  TOOL: "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  AGENT: "border-violet-500/40 bg-violet-500/10 text-violet-700 dark:text-violet-300",
  RETRIEVER: "border-cyan-500/40 bg-cyan-500/10 text-cyan-700 dark:text-cyan-300",
  RERANKER: "border-teal-500/40 bg-teal-500/10 text-teal-700 dark:text-teal-300",
  EMBEDDING: "border-indigo-500/40 bg-indigo-500/10 text-indigo-700 dark:text-indigo-300",
  GUARDRAIL: "border-rose-500/40 bg-rose-500/10 text-rose-700 dark:text-rose-300",
  SYSTEM: "border-border bg-muted font-medium text-muted-foreground",
};
const toneFor = (t: string) => NODE_TONE[t] ?? "border-slate-400/40 bg-slate-400/10 text-slate-600 dark:text-slate-300";

const ms = (s: string | null): number => (s ? Date.parse(s) : 0);

function toGraphObs(observations: ObservationDetail[]): GraphObs[] {
  return observations.map((o) => {
    const start = ms(o.start_time);
    return {
      id: o.id,
      parentId: o.parent_observation_id || "",
      type: o.type,
      name: o.name,
      startMs: start,
      // end_time can be coarser than latency; trust whichever runs longer (matches the waterfall).
      endMs: Math.max(ms(o.end_time), start + Number(o.latency_ms)),
    };
  });
}

export function TraceGraph({ observations }: { observations: ObservationDetail[] }) {
  const [mode, setMode] = useState<GraphMode>("aggregated");
  const graph = useMemo(() => buildGraph(toGraphObs(observations), mode), [observations, mode]);

  // Pixel layout: layers stack top→bottom; nodes within a layer spread left→right and are centered.
  const { positions, width, height } = useMemo(() => {
    const byLayer = new Map<number, typeof graph.nodes>();
    for (const n of graph.nodes) {
      const arr = byLayer.get(n.layer) ?? [];
      arr.push(n);
      byLayer.set(n.layer, arr);
    }
    for (const arr of byLayer.values()) arr.sort((a, b) => a.index - b.index);
    const rowWidth = (k: number) => k * NODE_W + Math.max(0, k - 1) * GAP_X;
    const maxRow = Math.max(NODE_W, ...[...byLayer.values()].map((a) => rowWidth(a.length)));
    const pos = new Map<string, { x: number; y: number }>();
    for (const [layer, arr] of byLayer) {
      const startX = (maxRow - rowWidth(arr.length)) / 2;
      arr.forEach((n, i) => {
        pos.set(n.id, { x: startX + i * (NODE_W + GAP_X), y: layer * (NODE_H + GAP_Y) });
      });
    }
    const layers = Math.max(0, ...graph.nodes.map((n) => n.layer)) + 1;
    return { positions: pos, width: maxRow, height: layers * (NODE_H + GAP_Y) - GAP_Y };
  }, [graph]);

  if (observations.length === 0) {
    return <EmptyState title="No observations to graph." />;
  }
  if (graph.nodes.length > MAX_NODES) {
    return (
      <EmptyState
        title="Graph too large to render"
        description={`This trace has ${graph.nodes.length} nodes in ${mode} mode. Switch modes or use the timeline.`}
      />
    );
  }

  const center = (id: string) => {
    const p = positions.get(id);
    return p ? { x: p.x + NODE_W / 2, y: p.y + NODE_H / 2 } : null;
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-1">
        {(["aggregated", "expanded"] as const).map((m) => (
          <Button
            key={m}
            variant={mode === m ? "secondary" : "ghost"}
            size="sm"
            className="h-7"
            onClick={() => setMode(m)}
          >
            {m === "aggregated" ? "Aggregated" : "Expanded"}
          </Button>
        ))}
        <span className="ml-1 text-xs text-muted-foreground">
          {mode === "aggregated" ? "repeated nodes collapse (×N); loops show as cycles" : "one node per observation"}
        </span>
      </div>

      <div className="overflow-auto rounded-lg border bg-muted/20 p-6">
        <div className="relative mx-auto" style={{ width, height }}>
          <svg
            className="pointer-events-none absolute inset-0 overflow-visible"
            width={width}
            height={height}
            role="img"
            aria-label="Trace flow edges"
          >
            <title>Trace flow edges</title>
            <defs>
              <marker
                id="tg-arrow"
                viewBox="0 0 10 10"
                refX="9"
                refY="5"
                markerWidth="6"
                markerHeight="6"
                orient="auto-start-reverse"
              >
                <path d="M 0 0 L 10 5 L 0 10 z" className="fill-border" />
              </marker>
            </defs>
            {graph.edges.map((e, i) => {
              const a = center(e.from);
              const b = center(e.to);
              if (!a || !b) return null;
              const sy = a.y + NODE_H / 2;
              const ty = b.y - NODE_H / 2;
              const back = b.y <= a.y; // cycle / upward edge
              const midY = (sy + ty) / 2;
              const d = back
                ? `M ${a.x} ${sy} C ${a.x + 80} ${sy + 40}, ${b.x + 80} ${ty - 40}, ${b.x} ${ty}`
                : `M ${a.x} ${sy} C ${a.x} ${midY}, ${b.x} ${midY}, ${b.x} ${ty}`;
              return (
                <path
                  key={`${e.from}-${e.to}-${i}`}
                  d={d}
                  className={back ? "stroke-amber-500/50" : "stroke-border"}
                  strokeWidth={1.5}
                  fill="none"
                  markerEnd="url(#tg-arrow)"
                />
              );
            })}
          </svg>

          {graph.nodes.map((n) => {
            const p = positions.get(n.id);
            if (!p) return null;
            const isSentinel = n.id === START || n.id === END;
            return (
              <div
                key={n.id}
                className={`absolute flex items-center justify-center gap-1 rounded-md border px-2 text-center text-xs shadow-xs ${toneFor(n.type)}`}
                style={{ left: p.x, top: p.y, width: NODE_W, height: NODE_H }}
                title={
                  isSentinel ? n.label : `${n.label}${n.count > 1 ? ` ×${n.count}` : ""} · ${n.type.toLowerCase()}`
                }
              >
                <span className="truncate">{isSentinel ? n.label : n.label}</span>
                {n.count > 1 && (
                  <span className="shrink-0 rounded bg-background/70 px-1 text-[0.625rem] tabular-nums">
                    ×{n.count}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
