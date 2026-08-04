import { describe, expect, it } from "vitest";
import { kmeans, kmeans2d, pca2d, pca3d, pickDominantSpace, reduce3d, umap3d } from "./embeddings.js";

describe("embedding reduction", () => {
  it("pca2d returns 2D coords, deterministically, one per input", () => {
    const vectors = [
      [1, 0, 0, 0],
      [0.9, 0.1, 0, 0],
      [0, 0, 1, 1],
      [0.1, 0, 0.9, 1],
    ];
    const a = pca2d(vectors);
    const b = pca2d(vectors);
    expect(a).toHaveLength(4);
    expect(a[0]).toHaveLength(2);
    // Deterministic (no RNG) — same input yields identical output.
    expect(a).toEqual(b);
  });

  it("kmeans2d separates two well-separated groups", () => {
    const points: [number, number][] = [
      [0, 0],
      [0.2, 0.1],
      [10, 10],
      [10.1, 9.9],
    ];
    const clusters = kmeans2d(points, 2);
    expect(clusters).toHaveLength(4);
    // The two near-origin points share a cluster; the two far points share the other.
    expect(clusters[0]).toBe(clusters[1]);
    expect(clusters[2]).toBe(clusters[3]);
    expect(clusters[0]).not.toBe(clusters[2]);
  });

  it("pca3d returns 3D coords, deterministically, one per input", () => {
    const vectors = [
      [1, 0, 0, 0],
      [0.9, 0.1, 0, 0],
      [0, 0, 1, 1],
      [0.1, 0, 0.9, 1],
    ];
    const a = pca3d(vectors);
    expect(a).toHaveLength(4);
    expect(a[0]).toHaveLength(3);
    expect(a).toEqual(pca3d(vectors)); // deterministic
  });

  it("kmeans (N-dim) separates two well-separated 3D groups", () => {
    const clusters = kmeans(
      [
        [0, 0, 0],
        [0.1, 0.1, 0.1],
        [9, 9, 9],
        [9.1, 8.9, 9],
      ],
      2,
    );
    expect(clusters[0]).toBe(clusters[1]);
    expect(clusters[2]).toBe(clusters[3]);
    expect(clusters[0]).not.toBe(clusters[2]);
  });

  it("handles empty + tiny inputs without throwing", () => {
    expect(pca2d([])).toEqual([]);
    expect(pca3d([])).toEqual([]);
    expect(kmeans2d([], 3)).toEqual([]);
    expect(kmeans([], 3)).toEqual([]);
    expect(kmeans2d([[1, 1]], 3)).toEqual([0]);
    expect(kmeans([[1, 1, 1]], 3)).toEqual([0]);
  });
});

describe("pickDominantSpace", () => {
  it("picks the (model, dim) most represented among a trace's vectors", () => {
    expect(
      pickDominantSpace([
        { model: "big", dim: 1536 },
        { model: "big", dim: 1536 },
        { model: "small", dim: 384 },
      ]),
    ).toEqual({ model: "big", dim: 1536 });
  });

  it("treats same model but different dim as distinct spaces", () => {
    const space = pickDominantSpace([
      { model: "m", dim: 3 },
      { model: "m", dim: 4 },
      { model: "m", dim: 4 },
    ]);
    expect(space).toEqual({ model: "m", dim: 4 });
  });

  it("returns null for no vectors", () => {
    expect(pickDominantSpace([])).toBeNull();
  });
});

/** Two well-separated blobs in 8 dims — deterministic pseudo-noise (no RNG in the suite). */
function blobs(n: number): number[][] {
  const out: number[][] = [];
  for (let i = 0; i < n; i++) {
    const centre = i % 2 === 0 ? 0 : 10;
    out.push(Array.from({ length: 8 }, (_, d) => centre + Math.sin(i * 13.37 + d * 7.7) * 0.5));
  }
  return out;
}

describe("umap3d", () => {
  it("is deterministic: identical input produces an identical layout (seeded RNG)", () => {
    const data = blobs(60);
    const a = umap3d(data);
    const b = umap3d(data);
    expect(a).toEqual(b);
    expect(a).toHaveLength(60);
    for (const p of a) expect(p.every(Number.isFinite)).toBe(true);
  });

  it("separates well-separated clusters", () => {
    const coords = umap3d(blobs(60));
    const centroid = (idx: number[]) =>
      idx
        .map((i) => coords[i] as [number, number, number])
        .reduce(
          (acc, c) => [acc[0] + c[0] / idx.length, acc[1] + c[1] / idx.length, acc[2] + c[2] / idx.length],
          [0, 0, 0],
        );
    const even = centroid([...Array(60).keys()].filter((i) => i % 2 === 0));
    const odd = centroid([...Array(60).keys()].filter((i) => i % 2 === 1));
    const dist = Math.hypot(even[0] - odd[0], even[1] - odd[1], even[2] - odd[2]);
    // Intra-blob noise is ±0.5; the two blob centroids must end far apart in the embedding.
    expect(dist).toBeGreaterThan(1);
  });
});

describe("reduce3d", () => {
  it("uses UMAP at/above the minimum point count and reports the method", () => {
    const r = reduce3d(blobs(60));
    expect(r.method).toBe("umap3d");
    expect(r.coords).toHaveLength(60);
  });

  it("falls back to PCA below the minimum point count", () => {
    const small = blobs(10);
    const r = reduce3d(small);
    expect(r.method).toBe("pca3d");
    expect(r.coords).toEqual(pca3d(small));
  });
});
