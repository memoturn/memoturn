import { describe, expect, it } from "vitest";
import { kmeans2d, pca2d } from "./embeddings.js";

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
