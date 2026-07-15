import type { EmbeddingProjection } from "@memoturn/contracts";
import { isoNow, newId } from "@memoturn/core";
import { prisma } from "@memoturn/db";
import { type EmbeddingProjectionRow, telemetry } from "@memoturn/telemetry";

/**
 * Embeddings analysis. The worker reduces high-dimensional observation vectors to 2D and
 * clusters them into a scatter/cluster view that surfaces outliers. Reduction runs offline
 * (a daily worker cron) and writes coordinates to the telemetry store; the console reads
 * them back and can color points by an eval score to find problematic clusters.
 *
 * Reduction uses PCA (top-2 principal components via power iteration) — dependency-free and
 * DETERMINISTIC, so unlike UMAP the layout doesn't jump between runs. Clustering is a small
 * deterministic k-means. Both are pure TS (the stack has no Python worker).
 */

const DEFAULT_DAYS = Number(process.env.EMBEDDING_PROJECTION_DAYS ?? 30);
const MAX_POINTS = Number(process.env.EMBEDDING_PROJECTION_MAX_POINTS ?? 5000);
const CLUSTERS = Number(process.env.EMBEDDING_PROJECTION_CLUSTERS ?? 8);

function dot(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += (a[i] ?? 0) * (b[i] ?? 0);
  return s;
}

/** Top principal component of a mean-centered matrix via power iteration (fixed iters → deterministic). */
function principalComponent(rows: number[][], dim: number, exclude: number[][] = []): number[] {
  // Deterministic seed vector (no RNG): 1s, then Gram-Schmidt against already-found PCs.
  let v = new Array(dim).fill(1 / Math.sqrt(dim));
  for (let iter = 0; iter < 50; iter++) {
    // w = Cov * v  = Σ row (row·v)
    const w = new Array(dim).fill(0);
    for (const row of rows) {
      const proj = dot(row, v);
      for (let i = 0; i < dim; i++) w[i] += proj * (row[i] ?? 0);
    }
    // Deflate previously-found components so we get the NEXT one.
    for (const pc of exclude) {
      const p = dot(w, pc);
      for (let i = 0; i < dim; i++) w[i] -= p * (pc[i] ?? 0);
    }
    const norm = Math.sqrt(dot(w, w)) || 1;
    v = w.map((x) => x / norm);
  }
  return v;
}

/** Project vectors to 2D via PCA. Returns one [x, y] per input row (input order preserved). */
export function pca2d(vectors: number[][]): [number, number][] {
  if (vectors.length === 0) return [];
  const dim = vectors[0]?.length ?? 0;
  if (dim === 0) return vectors.map(() => [0, 0]);
  // Mean-center.
  const mean = new Array(dim).fill(0);
  for (const v of vectors) for (let i = 0; i < dim; i++) mean[i] += (v[i] ?? 0) / vectors.length;
  const centered = vectors.map((v) => v.map((x, i) => x - (mean[i] ?? 0)));
  const pc1 = principalComponent(centered, dim);
  const pc2 = principalComponent(centered, dim, [pc1]);
  return centered.map((row) => [dot(row, pc1), dot(row, pc2)]);
}

/** Deterministic k-means on 2D points → cluster id per point (seeded by evenly-spaced picks). */
export function kmeans2d(points: [number, number][], k: number): number[] {
  const n = points.length;
  if (n === 0) return [];
  const kk = Math.max(1, Math.min(k, n));
  // Deterministic init: evenly-spaced points as seeds.
  let centers: [number, number][] = Array.from({ length: kk }, (_, i) => points[Math.floor((i * n) / kk)] ?? [0, 0]);
  const assign = new Array(n).fill(0);
  for (let iter = 0; iter < 20; iter++) {
    let moved = false;
    for (let i = 0; i < n; i++) {
      const p = points[i] ?? [0, 0];
      let best = 0;
      let bestD = Infinity;
      for (let c = 0; c < kk; c++) {
        const cc = centers[c] ?? [0, 0];
        const d = (p[0] - cc[0]) ** 2 + (p[1] - cc[1]) ** 2;
        if (d < bestD) {
          bestD = d;
          best = c;
        }
      }
      if (assign[i] !== best) {
        assign[i] = best;
        moved = true;
      }
    }
    // Recompute centers.
    const sums: [number, number][] = Array.from({ length: kk }, () => [0, 0]);
    const counts = new Array(kk).fill(0);
    for (let i = 0; i < n; i++) {
      const c = assign[i];
      const p = points[i] ?? [0, 0];
      const s = sums[c] as [number, number];
      s[0] += p[0];
      s[1] += p[1];
      counts[c]++;
    }
    centers = centers.map((old, c) => (counts[c] > 0 ? [sums[c]![0] / counts[c], sums[c]![1] / counts[c]] : old));
    if (!moved) break;
  }
  return assign;
}

/** Compute a fresh projection run for one project. Returns the run id + point count. */
export async function runProjectionForProject(projectId: string): Promise<{ runId: string; points: number } | null> {
  const store = telemetry();
  const vectors = await store.listEmbeddingsForProjection(projectId, { days: DEFAULT_DAYS, limit: MAX_POINTS });
  if (vectors.length < 2) return null; // nothing meaningful to project

  const coords = pca2d(vectors.map((v) => v.vector));
  const clusters = kmeans2d(coords, CLUSTERS);
  const runId = newId().slice(0, 36);
  const ts = isoNow();
  const rows: EmbeddingProjectionRow[] = vectors.map((v, i) => ({
    project_id: projectId,
    run_id: runId,
    observation_id: v.observation_id,
    trace_id: v.trace_id,
    x: coords[i]?.[0] ?? 0,
    y: coords[i]?.[1] ?? 0,
    z: null,
    cluster_id: clusters[i] ?? -1,
    method: "pca",
    event_ts: ts,
  }));
  await store.insertRows("embedding_projections", rows);
  return { runId, points: rows.length };
}

/** Cron entry: compute a projection for every project that has embeddings. */
export async function runAllEmbeddingProjections(): Promise<{ projectId: string; runId: string; points: number }[]> {
  const projects = await prisma.project.findMany({ select: { id: true } });
  const results: { projectId: string; runId: string; points: number }[] = [];
  for (const p of projects) {
    try {
      const r = await runProjectionForProject(p.id);
      if (r) results.push({ projectId: p.id, ...r });
    } catch {
      // skip a project on failure — best-effort maintenance
    }
  }
  return results;
}

/** Read a projection for the scatter view, optionally coloring points by an eval score. */
export async function getEmbeddingProjection(
  projectId: string,
  opts: { runId?: string; colorBy?: string; limit?: number } = {},
): Promise<EmbeddingProjection> {
  const store = telemetry();
  const runId = opts.runId ?? (await store.latestProjectionRunId(projectId));
  const points = runId ? await store.listEmbeddingProjection(projectId, { runId, limit: opts.limit }) : [];

  if (opts.colorBy && points.length > 0) {
    // Color-by a score name: join points to their trace's scores (mean value per trace).
    const traceIds = [...new Set(points.map((p) => p.trace_id).filter(Boolean))];
    const scores = await store.getScoresByTraceIds(projectId, traceIds);
    const byTrace = new Map<string, number>();
    const acc = new Map<string, { sum: number; n: number }>();
    for (const s of scores) {
      if (s.name !== opts.colorBy || s.value == null) continue;
      const a = acc.get(s.trace_id) ?? { sum: 0, n: 0 };
      a.sum += s.value;
      a.n += 1;
      acc.set(s.trace_id, a);
    }
    for (const [t, a] of acc) byTrace.set(t, a.sum / a.n);
    for (const p of points) p.color_value = byTrace.get(p.trace_id) ?? null;
  }

  const clusterCount = new Set(points.map((p) => p.cluster_id)).size;
  return { run_id: runId ?? "", method: points[0] ? "pca" : "", cluster_count: clusterCount, points };
}
