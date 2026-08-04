import { describe, expect, it } from "vitest";
import { elkLayoutGraph, NODE_H, NODE_W } from "./elk-layout";

const node = (id: string) => ({ id, label: id, type: "SPAN", observationIds: [], count: 1, layer: 0, index: 0 });

describe("elkLayoutGraph", () => {
  it("positions every node within the reported canvas, children below parents", async () => {
    const layout = await elkLayoutGraph({
      nodes: [node("a"), node("b"), node("c"), node("d")],
      edges: [
        { from: "a", to: "b" },
        { from: "a", to: "c" },
        { from: "b", to: "d" },
        { from: "c", to: "d" },
      ],
    });
    expect(layout.positions.size).toBe(4);
    for (const p of layout.positions.values()) {
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.y).toBeGreaterThanOrEqual(0);
      expect(p.x + NODE_W).toBeLessThanOrEqual(layout.width + 1);
      expect(p.y + NODE_H).toBeLessThanOrEqual(layout.height + 1);
    }
    const y = (id: string) => layout.positions.get(id)?.y ?? Number.NaN;
    expect(y("a")).toBeLessThan(y("b"));
    expect(y("b")).toBeLessThan(y("d"));
    // b and c share a layer in a layered DOWN layout.
    expect(y("b")).toBe(y("c"));
  });

  it("handles cycles without throwing (aggregated loops)", async () => {
    const layout = await elkLayoutGraph({
      nodes: [node("x"), node("y")],
      edges: [
        { from: "x", to: "y" },
        { from: "y", to: "x" },
      ],
    });
    expect(layout.positions.size).toBe(2);
  });
});
