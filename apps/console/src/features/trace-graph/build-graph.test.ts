import { describe, expect, it } from "vitest";
import { buildGraph, END, type GraphObs, START } from "./build-graph";

const ob = (id: string, parentId: string, type: string, name: string, s: number, e: number): GraphObs => ({
  id,
  parentId,
  type,
  name,
  startMs: s,
  endMs: e,
});
const edgeSet = (g: { edges: { from: string; to: string }[] }) => new Set(g.edges.map((e) => `${e.from}->${e.to}`));

describe("buildGraph — expanded", () => {
  it("sequential chain A→B→C is transitively reduced (no A→C)", () => {
    const g = buildGraph(
      [ob("a", "", "SPAN", "A", 0, 1), ob("b", "", "SPAN", "B", 1, 2), ob("c", "", "SPAN", "C", 2, 3)],
      "expanded",
    );
    const es = edgeSet(g);
    expect(es.has(`${START}->a`)).toBe(true);
    expect(es.has("a->b")).toBe(true);
    expect(es.has("b->c")).toBe(true);
    expect(es.has(`c->${END}`)).toBe(true);
    expect(es.has("a->c")).toBe(false);
    expect(g.nodes.find((n) => n.id === "a")!.layer).toBeLessThan(g.nodes.find((n) => n.id === "c")!.layer);
  });

  it("parallel branches fork from a common predecessor and join into the next node", () => {
    const g = buildGraph(
      [
        ob("a", "", "SPAN", "A", 0, 1),
        ob("b", "", "SPAN", "B", 1, 2),
        ob("c", "", "SPAN", "C", 1, 2),
        ob("d", "", "SPAN", "D", 2, 3),
      ],
      "expanded",
    );
    const es = edgeSet(g);
    expect(es.has("a->b")).toBe(true);
    expect(es.has("a->c")).toBe(true);
    expect(es.has("b->d")).toBe(true);
    expect(es.has("c->d")).toBe(true);
    expect(es.has(`d->${END}`)).toBe(true);
  });

  it("children descend from their parent", () => {
    const g = buildGraph(
      [ob("p", "", "AGENT", "P", 0, 5), ob("x", "p", "TOOL", "X", 1, 2), ob("y", "p", "TOOL", "Y", 2, 3)],
      "expanded",
    );
    const es = edgeSet(g);
    expect(es.has(`${START}->p`)).toBe(true);
    expect(es.has("p->x")).toBe(true);
    expect(es.has("x->y")).toBe(true);
  });

  it("excludes EVENT observations", () => {
    const g = buildGraph([ob("a", "", "SPAN", "A", 0, 1), ob("e", "", "EVENT", "evt", 0, 1)], "expanded");
    expect(g.nodes.some((n) => n.id === "e")).toBe(false);
  });

  it("empty trace is a bare start→end", () => {
    expect(edgeSet(buildGraph([], "expanded")).has(`${START}->${END}`)).toBe(true);
  });
});

describe("buildGraph — aggregated", () => {
  it("collapses repeated node names (×N) and forms the tool-loop cycle", () => {
    const g = buildGraph(
      [
        ob("ag1", "", "AGENT", "agent", 0, 6),
        ob("t1", "ag1", "TOOL", "search", 1, 2),
        ob("ag2", "ag1", "AGENT", "agent", 2, 3),
        ob("t2", "ag1", "TOOL", "search", 3, 4),
      ],
      "aggregated",
    );
    expect(g.nodes.find((n) => n.id === "agent")?.count).toBe(2);
    expect(g.nodes.find((n) => n.id === "search")?.count).toBe(2);
    const es = edgeSet(g);
    expect(es.has("search->agent") || es.has("agent->search")).toBe(true);
    // No self-loops after aggregation.
    expect([...es].some((e) => e.split("->")[0] === e.split("->")[1])).toBe(false);
  });
});
