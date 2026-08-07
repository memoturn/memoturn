import type { EmbeddingProjection, RetrievalAnalytics, SimilarTrace } from "@memoturn/contracts";
import { isoNow, newId } from "@memoturn/core";
import { prisma } from "@memoturn/db";
import { type EmbeddingProjectionRow, telemetry } from "@memoturn/telemetry";
import { UMAP } from "umap-js";

/**
 * Embeddings analysis. The worker reduces high-dimensional observation vectors to 3D and
 * clusters them into a scatter/cluster view that surfaces outliers. Reduction runs offline
 * (a daily worker cron) and writes coordinates to the telemetry store; the console reads
 * them back and can color points by an eval score to find problematic clusters.
 *
 * Reduction defaults to UMAP (umap-js) with an INJECTED SEEDED RNG, so identical inputs
 * produce an identical layout run-to-run — the historical objection to UMAP here. Small
 * point sets (< MIN_UMAP_POINTS, where neighbor structure is meaningless) and
 * `EMBEDDING_PROJECTION_METHOD=pca` fall back to the dependency-free PCA (top principal
 * components via power iteration). Clustering is a small deterministic k-means. Each row
 * records which method produced it (`umap3d` / `pca3d`).
 */

const DEFAULT_DAYS = Number(process.env.EMBEDDING_PROJECTION_DAYS ?? 30);
const MAX_POINTS = Number(process.env.EMBEDDING_PROJECTION_MAX_POINTS ?? 5000);
const CLUSTERS = Number(process.env.EMBEDDING_PROJECTION_CLUSTERS ?? 8);
/** `umap` (default) or `pca`. */
const METHOD = (process.env.EMBEDDING_PROJECTION_METHOD ?? "umap").toLowerCase();
/** Below this, UMAP's neighbor graph is meaningless — PCA reads better and is instant. */
const MIN_UMAP_POINTS = 30;

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

/** Project vectors to 3D via PCA (top-3 principal components). One [x, y, z] per input row. */
export function pca3d(vectors: number[][]): [number, number, number][] {
  if (vectors.length === 0) return [];
  const dim = vectors[0]?.length ?? 0;
  if (dim === 0) return vectors.map(() => [0, 0, 0]);
  const mean = new Array(dim).fill(0);
  for (const v of vectors) for (let i = 0; i < dim; i++) mean[i] += (v[i] ?? 0) / vectors.length;
  const centered = vectors.map((v) => v.map((x, i) => x - (mean[i] ?? 0)));
  const pc1 = principalComponent(centered, dim);
  const pc2 = principalComponent(centered, dim, [pc1]);
  const pc3 = principalComponent(centered, dim, [pc1, pc2]);
  return centered.map((row) => [dot(row, pc1), dot(row, pc2), dot(row, pc3)]);
}

/** Deterministic k-means over N-dimensional points → cluster id per point (evenly-spaced seeds). */
export function kmeans(points: number[][], k: number): number[] {
  const n = points.length;
  if (n === 0) return [];
  const dim = points[0]?.length ?? 0;
  const kk = Math.max(1, Math.min(k, n));
  let centers = Array.from({ length: kk }, (_, i) => [...(points[Math.floor((i * n) / kk)] ?? new Array(dim).fill(0))]);
  const assign = new Array(n).fill(0);
  for (let iter = 0; iter < 20; iter++) {
    let moved = false;
    for (let i = 0; i < n; i++) {
      const p = points[i] ?? [];
      let best = 0;
      let bestD = Infinity;
      for (let c = 0; c < kk; c++) {
        const cc = centers[c] ?? [];
        let d = 0;
        for (let j = 0; j < dim; j++) d += ((p[j] ?? 0) - (cc[j] ?? 0)) ** 2;
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
    const sums = Array.from({ length: kk }, () => new Array(dim).fill(0));
    const counts = new Array(kk).fill(0);
    for (let i = 0; i < n; i++) {
      const c = assign[i];
      const p = points[i] ?? [];
      for (let j = 0; j < dim; j++) sums[c]![j] += p[j] ?? 0;
      counts[c]++;
    }
    centers = centers.map((old, c) => (counts[c] > 0 ? sums[c]!.map((s) => s / counts[c]) : old));
    if (!moved) break;
  }
  return assign;
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

/** Deterministic PRNG (mulberry32) — injected into UMAP so layouts are stable across runs. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** UMAP → 3D with a seeded RNG (deterministic for identical inputs). One [x,y,z] per row. */
export function umap3d(vectors: number[][]): [number, number, number][] {
  const umap = new UMAP({
    nComponents: 3,
    nNeighbors: Math.min(15, vectors.length - 1),
    minDist: 0.1,
    random: mulberry32(42),
  });
  return umap.fit(vectors).map((c) => [c[0] ?? 0, c[1] ?? 0, c[2] ?? 0]);
}

/**
 * Reduce vectors to 3D, choosing the method: UMAP by default (seeded → deterministic),
 * PCA when configured or when the set is too small for a meaningful neighbor graph.
 */
export function reduce3d(vectors: number[][]): { coords: [number, number, number][]; method: string } {
  if (METHOD !== "pca" && vectors.length >= MIN_UMAP_POINTS) {
    return { coords: umap3d(vectors), method: "umap3d" };
  }
  return { coords: pca3d(vectors), method: "pca3d" };
}

/** Compute a fresh projection run for one project. Returns the run id + point count. */
export async function runProjectionForProject(projectId: string): Promise<{ runId: string; points: number } | null> {
  const store = telemetry();
  const vectors = await store.listEmbeddingsForProjection(projectId, { days: DEFAULT_DAYS, limit: MAX_POINTS });
  if (vectors.length < 2) return null; // nothing meaningful to project

  const { coords, method } = reduce3d(vectors.map((v) => v.vector));
  const clusters = kmeans(coords, CLUSTERS);
  const runId = newId().slice(0, 36);
  const ts = isoNow();
  const rows: EmbeddingProjectionRow[] = vectors.map((v, i) => ({
    project_id: projectId,
    run_id: runId,
    observation_id: v.observation_id,
    trace_id: v.trace_id,
    x: coords[i]?.[0] ?? 0,
    y: coords[i]?.[1] ?? 0,
    z: coords[i]?.[2] ?? 0,
    cluster_id: clusters[i] ?? -1,
    method,
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

// ── Semantic "find similar traces" (query-by-example) ───────────────────────────────
//
// memoturn never computes embeddings — customers send their own vectors, so the stored
// (model, dim) varies per row and comparison is only valid inside ONE embedding space.
// Given a seed trace, we take its dominant space and rank other traces by EXACT cosine
// similarity computed IN Doris (`cosine_distance`, no ANN index — Doris allows ANN indexes
// only on DUPLICATE KEY tables, and they're approximate and cosine-less anyway). Pushing the
// scan to the engine keeps it parallel on the BEs and returns only the top-k ids, never the
// raw vectors. Upgrade path if a single project's space grows past ~100k vectors and p95 gets
// slow: a DUPLICATE KEY ANN mirror rebuilt off ingest (trading exactness for latency).

// A trace can have many embedded observations; cap how many seed vectors we compare with (each
// adds a cosine_distance term to the query). A handful captures the trace; more is diminishing.
const SEED_VECTOR_CAP = Number(process.env.SIMILAR_TRACES_SEED_CAP ?? 8);

export interface EmbeddingSpace {
  model: string;
  dim: number;
}

/**
 * Pick the (model, dim) embedding space most represented among a trace's vectors — similarity
 * is only meaningful inside a single space, and a trace may mix models. Pure → unit-tested.
 */
export function pickDominantSpace(rows: { model: string; dim: number }[]): EmbeddingSpace | null {
  const spaces = new Map<string, { model: string; dim: number; count: number }>();
  for (const r of rows) {
    const key = `${r.model}::${r.dim}`;
    const s = spaces.get(key) ?? { model: r.model, dim: r.dim, count: 0 };
    s.count += 1;
    spaces.set(key, s);
  }
  const top = [...spaces.values()].sort((a, b) => b.count - a.count)[0];
  return top ? { model: top.model, dim: top.dim } : null;
}

/**
 * Find traces semantically similar to `traceId` using stored embeddings. Returns trace
 * summaries (ranked, most-similar first) with a `similarity` score in [-1, 1] (1 = identical).
 * Empty if the seed trace has no embeddings.
 */
export async function findSimilarTraces(
  projectId: string,
  traceId: string,
  opts: { limit?: number; days?: number } = {},
): Promise<SimilarTrace[]> {
  const store = telemetry();
  const limit = Math.min(Math.max(Math.floor(opts.limit ?? 10), 1), 50);

  const seedRows = await store.getTraceEmbeddings(projectId, traceId);
  const space = pickDominantSpace(seedRows);
  if (!space) return [];
  const seedVectors = seedRows
    .filter((r) => r.model === space.model && r.dim === space.dim)
    .map((r) => r.vector)
    .slice(0, SEED_VECTOR_CAP);

  const ranked = await store.rankSimilarTraceIds(projectId, {
    seedVectors,
    model: space.model,
    dim: space.dim,
    excludeTraceId: traceId,
    limit,
    days: opts.days,
  });
  if (ranked.length === 0) return [];

  const summaries = await store.listTraces(projectId, {
    traceIds: ranked.map((r) => r.trace_id),
    limit: ranked.length,
  });
  const byId = new Map(summaries.map((s) => [s.id, s]));
  return ranked
    .map((r) => {
      const s = byId.get(r.trace_id);
      return s ? { ...s, similarity: Number(r.similarity.toFixed(4)) } : null;
    })
    .filter((x): x is SimilarTrace => x !== null);
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

/**
 * Cross-trace retrieval diagnostics. The trace view answers "what did THIS query retrieve?";
 * this answers "which retrievals are scoring badly?" — the question that surfaces a broken
 * index, a chunking change that regressed, or documents that dominate every result set.
 *
 * A thin pass-through to the telemetry store: all the aggregation is engine SQL, which lives
 * behind the store seam so both dialects stay equivalent (conformance covers it).
 */
export async function getRetrievalAnalytics(
  projectId: string,
  opts: { days?: number; limit?: number } = {},
): Promise<RetrievalAnalytics> {
  return telemetry().retrievalAnalytics(projectId, opts);
}
