import type { Graph } from "./build-graph";

/**
 * ELK layered layout for the trace graph — proper crossing minimization and cycle-aware
 * layer assignment, which the hand-rolled longest-path layout in build-graph.ts doesn't do
 * (it keeps insertion order within a layer, so busy agent graphs get avoidable edge
 * crossings). elkjs is ~1.4 MB, so it's loaded lazily on first use and the caller renders
 * the hand-rolled layout until this resolves (then the ELK positions snap in).
 */

export interface PixelLayout {
  positions: Map<string, { x: number; y: number }>;
  width: number;
  height: number;
}

export const NODE_W = 150;
export const NODE_H = 40;
export const GAP_X = 28;
export const GAP_Y = 52;

type ElkInstance = {
  layout(graph: object): Promise<{
    children?: { id: string; x?: number; y?: number }[];
    width?: number;
    height?: number;
  }>;
};

let elkPromise: Promise<ElkInstance> | undefined;
function elk(): Promise<ElkInstance> {
  elkPromise ??= import("elkjs/lib/elk.bundled.js").then((m) => new m.default() as ElkInstance);
  return elkPromise;
}

export async function elkLayoutGraph(graph: Pick<Graph, "nodes" | "edges">): Promise<PixelLayout> {
  const engine = await elk();
  const res = await engine.layout({
    id: "root",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": "DOWN",
      "elk.layered.spacing.nodeNodeBetweenLayers": String(GAP_Y),
      "elk.spacing.nodeNode": String(GAP_X),
      // Keep sibling order stable-ish where crossings allow — matches the execution order
      // the rest of the trace UI presents.
      "elk.layered.considerModelOrder.strategy": "PREFER_NODES",
    },
    children: graph.nodes.map((n) => ({ id: n.id, width: NODE_W, height: NODE_H })),
    edges: graph.edges.map((e, i) => ({ id: `e${i}`, sources: [e.from], targets: [e.to] })),
  });

  const positions = new Map<string, { x: number; y: number }>();
  for (const c of res.children ?? []) positions.set(c.id, { x: c.x ?? 0, y: c.y ?? 0 });
  return {
    positions,
    width: Math.max(NODE_W, Math.ceil(res.width ?? 0)),
    height: Math.max(NODE_H, Math.ceil(res.height ?? 0)),
  };
}
