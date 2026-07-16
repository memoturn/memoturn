import { describe, expect, it } from "vitest";
import { kmeans2d, pca2d, pickDominantSpace } from "./embeddings.js";

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

  it("handles empty + tiny inputs without throwing", () => {
    expect(pca2d([])).toEqual([]);
    expect(kmeans2d([], 3)).toEqual([]);
    expect(kmeans2d([[1, 1]], 3)).toEqual([0]);
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
