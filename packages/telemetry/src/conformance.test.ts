import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { telemetry } from "./index.js";
import type { ObservationRow, ScoreWriteRow, TraceRow } from "./types.js";

/**
 * Behavioral conformance suite for the telemetry store — the contract every engine
 * implementation must satisfy: insert → read-back, last-writer-wins overwrite by
 * event_ts, stale-write rejection, filters, on-the-fly metrics, and deletes.
 * Skipped when no store is reachable (so the default `bun run test` stays infra-free).
 */
const store = telemetry();
const reachable = await store.ping();

const P = `conf-${Date.now()}`;
const now = Date.now();
const iso = (offsetMs = 0) => new Date(now + offsetMs).toISOString();

const trace = (over: Partial<TraceRow> = {}): TraceRow => ({
  id: "t1",
  project_id: P,
  timestamp: iso(-3_600_000),
  name: "Conformance Trace",
  user_id: "u1",
  session_id: "s1",
  release: "",
  version: "",
  environment: "default",
  public: 0,
  tags: ["alpha", 'tricky "quoted", comma'],
  metadata: "{}",
  input: '{"q":"hi"}',
  output: '{"a":"bye"}',
  event_ts: iso(),
  ...over,
});

const observation = (over: Partial<ObservationRow> = {}): ObservationRow => ({
  id: "o1",
  trace_id: "t1",
  project_id: P,
  type: "GENERATION",
  parent_observation_id: "",
  name: "gen",
  start_time: iso(-3_600_000),
  end_time: iso(-3_600_000 + 1234),
  environment: "default",
  level: "DEFAULT",
  status_message: "",
  model: "gpt-x",
  provider: "openai",
  model_parameters: "{}",
  prompt_tokens: 100,
  completion_tokens: 200,
  total_tokens: 300,
  input_cost: 0.001,
  output_cost: 0.002,
  total_cost: 0.003,
  prompt_id: "",
  prompt_version: "",
  input: "in",
  output: "out",
  metadata: "{}",
  latency_ms: 1234,
  event_ts: iso(),
  ...over,
});

const score = (over: Partial<ScoreWriteRow> = {}): ScoreWriteRow => ({
  id: "sc1",
  project_id: P,
  trace_id: "t1",
  observation_id: "",
  name: "quality",
  timestamp: iso(-3_600_000),
  environment: "default",
  source: "API",
  data_type: "NUMERIC",
  value: 0.8,
  string_value: "",
  comment: "first",
  config_id: "",
  event_ts: iso(),
  ...over,
});

describe.skipIf(!reachable)("telemetry store conformance", () => {
  beforeAll(async () => {
    await store.insertRows("traces", [trace()]);
    await store.insertRows("observations", [
      observation(),
      observation({ id: "o2", type: "SPAN", end_time: null, model: "", total_tokens: 0, total_cost: 0, latency_ms: 0 }),
    ]);
    await store.insertRows("scores", [score()]);
  });

  afterAll(async () => {
    await store.deleteProjectData(P);
  });

  it("lists traces with rollups, tag + search filters, and ISO timestamps", async () => {
    const rows = await store.listTraces(P, { tag: "alpha", search: "conform" });
    expect(rows).toHaveLength(1);
    const t = rows[0]!;
    expect(t.observation_count).toBe(2);
    expect(t.total_tokens).toBe(300);
    expect(t.latency_ms).toBe(1234);
    expect(t.tags).toEqual(["alpha", 'tricky "quoted", comma']);
    expect(t.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    // Non-matching filters exclude the trace.
    expect(await store.listTraces(P, { tag: "nope" })).toHaveLength(0);
    expect(await store.listTraces(P, { search: "nope" })).toHaveLength(0);
    expect(await store.listTraces(P, { userId: "u1" })).toHaveLength(1);
  });

  it("returns trace header, observations (null end_time preserved), and scores", async () => {
    const header = await store.getTraceHeader(P, "t1");
    expect(header?.name).toBe("Conformance Trace");
    expect(await store.getTraceHeader(P, "missing")).toBeNull();

    const obs = await store.listObservationsByTrace(P, "t1");
    expect(obs).toHaveLength(2);
    const gen = obs.find((o) => o.id === "o1")!;
    expect(gen.latency_ms).toBe(1234);
    expect(gen.total_cost).toBeCloseTo(0.003, 6);
    expect(gen.end_time).not.toBeNull();
    expect(obs.find((o) => o.id === "o2")!.end_time).toBeNull();

    const scores = await store.listScoresByTrace(P, "t1");
    expect(scores).toHaveLength(1);
    expect(scores[0]!.value).toBeCloseTo(0.8);
  });

  it("overwrites on same id + newer event_ts and rejects stale writes (LWW)", async () => {
    await store.insertRows("scores", [score({ value: 0.95, comment: "corrected", event_ts: iso(60_000) })]);
    let s = await store.getScoreById(P, "sc1");
    expect(s?.value).toBeCloseTo(0.95);
    expect(s?.comment).toBe("corrected");
    expect(await store.listScoresByTrace(P, "t1")).toHaveLength(1); // no duplicate

    await store.insertRows("scores", [score({ value: 0.1, comment: "stale", event_ts: iso(-120_000) })]);
    s = await store.getScoreById(P, "sc1");
    expect(s?.value).toBeCloseTo(0.95); // stale write must not win
  });

  it("computes on-the-fly metrics, widget series, and evaluator analytics", async () => {
    const byDay = await store.metricsByDay(P, 7);
    expect(byDay).toHaveLength(1);
    expect(byDay[0]!.generations).toBe(1); // SPAN rows excluded
    expect(byDay[0]!.total_tokens).toBe(300);
    expect(byDay[0]!.p95_latency_ms).toBeGreaterThan(1000);

    const byModel = await store.metricsByModel(P, 7);
    expect(byModel).toHaveLength(1);
    expect(byModel[0]!.model).toBe("gpt-x");

    expect(await store.countTracesSince(P, 7)).toBe(1);

    const widget = await store.widgetSeries(P, "tokens", "by_model", 7);
    expect(widget).toHaveLength(1);
    expect(widget[0]!.value).toBe(300);

    await store.insertRows("scores", [
      score({ id: "sc-eval", source: "EVAL", name: "judge", value: 0.5, event_ts: iso(1000) }),
    ]);
    const summary = await store.evaluatorScoreSummary(P, 7);
    expect(summary).toEqual([{ name: "judge", count: 1, avgValue: 0.5 }]);
    const trend = await store.evaluatorScoreTrend(P, 7);
    expect(trend).toHaveLength(1);
    await store.deleteScore(P, "sc-eval");
  });

  it("returns write-shaped rows for read-merge bases (ms-precision event_ts)", async () => {
    const [t] = await store.getTraceRowsByIds(P, ["t1", "missing"]);
    expect(t?.id).toBe("t1");
    expect(t?.public).toBe(0);
    expect(t?.tags).toEqual(["alpha", 'tricky "quoted", comma']);
    // event_ts round-trips as a parseable timestamp with sub-second precision intact.
    expect(new Date(t!.event_ts).getTime()).toBe(new Date(iso()).getTime());

    const obs = await store.getObservationRowsByIds(P, ["o1", "o2"]);
    expect(obs).toHaveLength(2);
    const gen = obs.find((o) => o.id === "o1")!;
    expect(gen.trace_id).toBe("t1");
    expect(gen.model).toBe("gpt-x");
    expect(gen.prompt_tokens).toBe(100);
    expect(gen.total_cost).toBeCloseTo(0.003, 6);
    expect(gen.end_time).not.toBeNull();
    expect(obs.find((o) => o.id === "o2")!.end_time).toBeNull();
  });

  it("exports traces with nested observations and counts project rows", async () => {
    const exported = await store.exportTraces(P, {});
    expect(exported).toHaveLength(1);
    expect(exported[0]!.observations).toHaveLength(2);

    const counts = await store.countProjectRows(P);
    expect(counts).toEqual({ traces: 1, observations: 2, scores: 1 });

    const io = await store.getTraceIO(P, ["t1", "missing"]);
    expect(io).toHaveLength(1);
    expect(await store.getScoresByTraceIds(P, ["t1"])).toHaveLength(1);
  });

  it("deletes by score id, by retention cutoff, and by trace ids", async () => {
    await store.insertRows("scores", [score({ id: "sc-del", event_ts: iso(2000) })]);
    await store.deleteScore(P, "sc-del");
    expect(await store.getScoreById(P, "sc-del")).toBeNull();

    // A 30-day cutoff deletes nothing (rows are ~1h old)...
    await store.deleteOlderThan(P, 30);
    expect(await store.countTracesOlderThan(P, 30)).toBe(0);
    expect((await store.countProjectRows(P)).traces).toBe(1);

    // ...and deleting the trace removes its observations and scores too.
    await store.deleteTraces(P, ["t1"]);
    expect(await store.countProjectRows(P)).toEqual({ traces: 0, observations: 0, scores: 0 });
  });
});
