import { ingestRequest } from "@memoturn/core";
import { describe, expect, it } from "vitest";
import { demoDayWindow, generateDemoBatches, generateDemoDay, packBatches, tracesForDay } from "./demodata.js";

// A pinned clock keeps every assertion deterministic — the day window (and therefore the
// current day's cutoff) is derived from `now`.
const NOW = 1784900000000;
const cfg = { days: 5, tracesPerDay: 12, seed: "test-seed", now: NOW };

describe("determinism", () => {
  it("produces identical events for the same config", () => {
    expect(JSON.stringify(generateDemoDay(cfg, 2))).toBe(JSON.stringify(generateDemoDay(cfg, 2)));
  });

  it("produces different events for a different seed", () => {
    const a = JSON.stringify(generateDemoDay(cfg, 2));
    const b = JSON.stringify(generateDemoDay({ ...cfg, seed: "other-seed" }, 2));
    expect(a).not.toBe(b);
  });

  it("is stable across separate calls with an explicit `now` (no hidden module clock)", () => {
    const first = generateDemoBatches({ days: 2, tracesPerDay: 5, seed: "s", now: NOW });
    const second = generateDemoBatches({ days: 2, tracesPerDay: 5, seed: "s", now: NOW });
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });
});

describe("day windows", () => {
  it("anchors each day to UTC midnight, oldest day furthest back", () => {
    const today = demoDayWindow(cfg, 0);
    const older = demoDayWindow(cfg, 3);
    expect(today.dayStartMs - older.dayStartMs).toBe(3 * 24 * 60 * 60 * 1000);
    expect(new Date(today.dayStartMs).toISOString()).toMatch(/T00:00:00\.000Z$/);
  });

  it("never generates into the future — today's cutoff is clamped below `now`", () => {
    expect(demoDayWindow(cfg, 0).dayCutoffMs).toBeLessThan(NOW);
  });

  it("keeps every event timestamp within its day window", () => {
    const { dayStartMs, dayCutoffMs } = demoDayWindow(cfg, 1);
    for (const e of generateDemoDay(cfg, 1)) {
      const t = Date.parse(e.timestamp);
      expect(t).toBeGreaterThanOrEqual(dayStartMs);
      expect(t).toBeLessThanOrEqual(dayCutoffMs);
    }
  });
});

describe("volume", () => {
  it("scales with tracesPerDay and always emits at least one trace", () => {
    const small = generateDemoDay({ ...cfg, tracesPerDay: 2 }, 1).filter((e) => e.type === "trace-create").length;
    const large = generateDemoDay({ ...cfg, tracesPerDay: 50 }, 1).filter((e) => e.type === "trace-create").length;
    expect(small).toBeGreaterThanOrEqual(1);
    expect(large).toBeGreaterThan(small);
  });

  it("tracesForDay dips on weekends", () => {
    // Find a Saturday and the following Tuesday within the window.
    const c = { days: 14, tracesPerDay: 100, seed: "wk", now: NOW };
    const counts = Array.from({ length: 14 }, (_, d) => {
      const { dayStartMs } = demoDayWindow(c, d);
      return { dow: new Date(dayStartMs).getUTCDay(), n: tracesForDay(c, d, dayStartMs) };
    });
    const weekend = counts.filter((x) => x.dow === 0 || x.dow === 6).map((x) => x.n);
    const weekday = counts.filter((x) => x.dow !== 0 && x.dow !== 6).map((x) => x.n);
    expect(Math.max(...weekend)).toBeLessThan(Math.max(...weekday));
  });
});

describe("batching", () => {
  it("caps batches at 1000 events", () => {
    for (const batch of generateDemoBatches({ days: 3, tracesPerDay: 200, seed: "b", now: NOW })) {
      expect(batch.length).toBeLessThanOrEqual(1000);
    }
  });

  it("preserves every event across batching, in order", () => {
    const events = generateDemoDay(cfg, 1);
    const flat = packBatches(events).flat();
    expect(flat).toHaveLength(events.length);
    expect(flat.map((e) => e.id)).toEqual(events.map((e) => e.id));
  });

  it("returns no empty batches", () => {
    for (const b of generateDemoBatches(cfg)) expect(b.length).toBeGreaterThan(0);
  });
});

describe("wire contract", () => {
  it("every generated batch validates against the ingest schema", () => {
    for (const batch of generateDemoBatches({ days: 3, tracesPerDay: 10, seed: "wire", now: NOW })) {
      expect(() => ingestRequest.parse({ batch })).not.toThrow();
    }
  });

  it("emits the full entity mix a demo should showcase", () => {
    const types = new Set(
      generateDemoBatches(cfg)
        .flat()
        .map((e) => e.type),
    );
    expect(types.has("trace-create")).toBe(true);
    expect(types.has("generation-create")).toBe(true);
    expect(types.has("span-create")).toBe(true);
    expect(types.has("score-create")).toBe(true);
  });

  it("every observation/score references a trace emitted in the same run", () => {
    const events = generateDemoBatches(cfg).flat();
    const traceIds = new Set(events.filter((e) => e.type === "trace-create").map((e) => e.body.id));
    for (const e of events) {
      if (e.type === "trace-create") continue;
      expect(traceIds.has((e.body as { traceId: string }).traceId)).toBe(true);
    }
  });
});

describe("enriched archetypes", () => {
  // A big single day so every weighted scenario appears.
  const bigCfg = { days: 1, tracesPerDay: 400, seed: "archetype-seed", now: NOW };
  const events = generateDemoDay(bigCfg, 0);
  const traces = events.filter((e) => e.type === "trace-create");
  const names = new Set(traces.map((e) => (e.body as { name: string }).name));

  it("every generated event validates against the ingest wire schema", () => {
    for (const batch of packBatches(events)) {
      const parsed = ingestRequest.safeParse({ batch });
      if (!parsed.success)
        throw new Error(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
    }
  });

  it("covers all scenario archetypes", () => {
    for (const n of [
      "chat-completion",
      "support-thread",
      "rag-pipeline",
      "rag-rerank",
      "agent-loop",
      "guardrail-check",
      "image-generation",
    ]) {
      expect(names.has(n), `missing scenario ${n}`).toBe(true);
    }
  });

  it("agent-loop traces are real trees (steps nested under an AGENT parent)", () => {
    const agentTrace = traces.find((e) => (e.body as { name: string }).name === "agent-loop");
    expect(agentTrace).toBeDefined();
    const tid = (agentTrace?.body as { id: string }).id;
    const obs = events.filter(
      (e) => e.type !== "trace-create" && e.type !== "score-create" && (e.body as { traceId: string }).traceId === tid,
    );
    const parents = new Set(obs.map((o) => (o.body as { parentObservationId?: string }).parentObservationId ?? ""));
    parents.delete("");
    expect(parents.size).toBeGreaterThanOrEqual(2); // agent span + at least one step parent
    const kinds = new Set(obs.map((o) => (o.body as { observationType?: string }).observationType ?? ""));
    expect(kinds.has("AGENT")).toBe(true);
    expect(kinds.has("TOOL")).toBe(true);
    expect(kinds.has("THOUGHT")).toBe(true);
  });

  it("support threads share a session across multiple turn traces", () => {
    const threads = traces.filter((e) => (e.body as { name: string }).name === "support-thread");
    expect(threads.length).toBeGreaterThan(0);
    const bySession = new Map<string, number>();
    for (const t of threads) {
      const sid = (t.body as { sessionId: string }).sessionId;
      bySession.set(sid, (bySession.get(sid) ?? 0) + 1);
    }
    expect([...bySession.values()].some((n) => n >= 2)).toBe(true);
    expect(
      threads.every((t) => String((t.body as { sessionPath?: string }).sessionPath ?? "").startsWith("/support/")),
    ).toBe(true);
  });

  it("emits span-scoped corrections and reranked document sets", () => {
    const scores = events.filter((e) => e.type === "score-create");
    const corrections = scores.filter((e) => (e.body as { dataType?: string }).dataType === "CORRECTION");
    expect(corrections.length).toBeGreaterThan(0);
    expect(corrections.every((c) => Boolean((c.body as { observationId?: string }).observationId))).toBe(true);
    const rerank = events.find((e) => (e.body as { name?: string }).name === "rerank-docs");
    expect(rerank).toBeDefined();
    expect(((rerank?.body as { retrievedDocuments?: unknown[] }).retrievedDocuments ?? []).length).toBeGreaterThan(0);
  });

  it("reports reasoning and cache-read token usage somewhere in the set", () => {
    const usages = events
      .map((e) => (e.body as { usage?: { reasoningTokens?: number; cacheReadTokens?: number } }).usage)
      .filter(Boolean) as { reasoningTokens?: number; cacheReadTokens?: number }[];
    expect(usages.some((u) => (u.reasoningTokens ?? 0) > 0)).toBe(true);
    expect(usages.some((u) => (u.cacheReadTokens ?? 0) > 0)).toBe(true);
  });
});
