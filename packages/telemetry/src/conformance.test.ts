import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { telemetry } from "./index.js";
import type {
  EmbeddingProjectionRow,
  EmbeddingRow,
  ObservationRow,
  RetrievalDocumentRow,
  ScoreWriteRow,
  TraceRow,
} from "./types.js";

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
  cache_read_tokens: 40,
  cache_creation_tokens: 60,
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

const retrievalDoc = (over: Partial<RetrievalDocumentRow> = {}): RetrievalDocumentRow => ({
  project_id: P,
  observation_id: "o1",
  rank: 0,
  trace_id: "t1",
  doc_id: "docA",
  score: 0.9,
  content: "Doc A",
  metadata: '{"src":"kb"}',
  event_ts: iso(),
  ...over,
});

const embeddingRow = (over: Partial<EmbeddingRow> = {}): EmbeddingRow => ({
  project_id: P,
  observation_id: "o1",
  trace_id: "t1",
  kind: "OBSERVATION",
  model: "text-embedding-3-small",
  dim: 4,
  vector: [0.1, 0.2, 0.3, 0.4],
  event_ts: iso(),
  ...over,
});

const projectionRow = (over: Partial<EmbeddingProjectionRow> = {}): EmbeddingProjectionRow => ({
  project_id: P,
  run_id: "run1",
  observation_id: "o1",
  trace_id: "t1",
  x: 1.5,
  y: -2.5,
  z: null,
  cluster_id: 2,
  method: "pca",
  event_ts: iso(),
  ...over,
});

describe.skipIf(!reachable)("telemetry store conformance", () => {
  beforeAll(async () => {
    await store.insertRows("traces", [trace()]);
    await store.insertRows("observations", [
      observation({ prompt_id: "p1" }),
      observation({ id: "o2", type: "SPAN", end_time: null, model: "", total_tokens: 0, total_cost: 0, latency_ms: 0 }),
    ]);
    await store.insertRows("scores", [score()]);
    await store.insertRows("retrieval_documents", [
      retrievalDoc(),
      retrievalDoc({ rank: 1, doc_id: "docB", score: 0.4, content: 'tricky "quoted", comma doc' }),
    ]);
    await store.insertRows("embeddings", [
      embeddingRow(),
      embeddingRow({ observation_id: "o2", vector: [1, 1, 1, 1] }),
    ]);
    await store.insertRows("embedding_projections", [
      projectionRow(),
      projectionRow({ observation_id: "o2", x: 9, y: 9, cluster_id: 5 }),
    ]);
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
    // search matches observation input/output content, not just the trace name.
    expect(await store.listTraces(P, { search: "out" })).toHaveLength(1); // observation output = "out"
    expect(await store.listTraces(P, { userId: "u1" })).toHaveLength(1);

    // promptId filter: trace has an observation that used this prompt.
    expect(await store.listTraces(P, { promptId: "p1" })).toHaveLength(1);
    expect(await store.listTraces(P, { promptId: "nope" })).toHaveLength(0);
    expect(await store.countTraces(P, { promptId: "p1" })).toBe(1);

    // scoreName filter: trace has a score with this name.
    expect(await store.listTraces(P, { scoreName: "quality" })).toHaveLength(1);
    expect(await store.listTraces(P, { scoreName: "nope" })).toHaveLength(0);

    // level filter: trace has an observation at this level.
    expect(await store.listTraces(P, { level: "DEFAULT" })).toHaveLength(1);
    expect(await store.listTraces(P, { level: "ERROR" })).toHaveLength(0);

    // Pagination: total count honors filters; an offset past the result set yields an empty page.
    expect(await store.countTraces(P, {})).toBe(1);
    expect(await store.countTraces(P, { tag: "alpha" })).toBe(1);
    expect(await store.countTraces(P, { environment: "nope" })).toBe(0);
    expect(await store.listTraces(P, { limit: 10, offset: 1 })).toHaveLength(0);
  });

  it("buckets trace volume by day and hour for the histogram, honoring filters", async () => {
    const daily = await store.traceHistogram(P, { days: 7 }, "day");
    expect(daily).toHaveLength(1);
    expect(daily[0]!.count).toBe(1);
    expect(daily[0]!.bucket).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    const hourly = await store.traceHistogram(P, { days: 7 }, "hour");
    expect(hourly).toHaveLength(1);
    expect(hourly[0]!.bucket).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:00$/);

    // Honors the trace-list filters (non-matching tag → no buckets).
    expect(await store.traceHistogram(P, { tag: "nope" }, "day")).toHaveLength(0);
  });

  it("groups traces into sessions with counts, and paginates", async () => {
    const sessions = await store.listSessions(P, {});
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.session_id).toBe("s1");
    expect(sessions[0]!.trace_count).toBe(1);
    expect(await store.countSessions(P)).toBe(1);
    expect(await store.countSessions(P, 7)).toBe(1); // seeded trace is ~1h old, within range
    expect(await store.listSessions(P, { days: 7 })).toHaveLength(1);
    expect(await store.listSessions(P, { limit: 10, offset: 1 })).toHaveLength(0);
    // search filters by session_id substring (case-sensitive LIKE).
    expect(await store.listSessions(P, { search: "s1" })).toHaveLength(1);
    expect(await store.listSessions(P, { search: "nope" })).toHaveLength(0);
    expect(await store.countSessions(P, 0, "s1")).toBe(1);
    expect(await store.countSessions(P, 0, "nope")).toBe(0);
  });

  it("groups traces by end user with counts, and paginates", async () => {
    const users = await store.listUsers(P, {});
    expect(users).toHaveLength(1);
    expect(users[0]!.user_id).toBe("u1");
    expect(users[0]!.trace_count).toBe(1);
    expect(await store.countUsers(P)).toBe(1);
    expect(await store.countUsers(P, 7)).toBe(1);
    expect(await store.listUsers(P, { days: 7 })).toHaveLength(1);
    expect(await store.listUsers(P, { limit: 10, offset: 1 })).toHaveLength(0);
    // search filters by user_id substring (case-sensitive LIKE).
    expect(await store.listUsers(P, { search: "u1" })).toHaveLength(1);
    expect(await store.listUsers(P, { search: "nope" })).toHaveLength(0);
    expect(await store.countUsers(P, 0, "u1")).toBe(1);
    expect(await store.countUsers(P, 0, "nope")).toBe(0);
  });

  it("rolls up cost by user and session, ranked by spend", async () => {
    // Seeded: 1 trace (user u1 / session s1) with 1 GENERATION — total_cost 0.003, tokens 300.
    const byUser = await store.costByUser(P, {});
    expect(byUser).toHaveLength(1);
    expect(byUser[0]!).toMatchObject({ key: "u1", trace_count: 1, total_tokens: 300 });
    expect(byUser[0]!.total_cost).toBeCloseTo(0.003, 6);

    const bySession = await store.costBySession(P, { days: 7 });
    expect(bySession).toHaveLength(1);
    expect(bySession[0]!).toMatchObject({ key: "s1", trace_count: 1, total_tokens: 300 });

    // The limit is honored.
    expect(await store.costByUser(P, { limit: 0 })).toHaveLength(1); // floored to 1
  });

  it("attributes spend to a prompt's versions, ranked by cost", async () => {
    // Own trace + observations so this is isolated from the shared fixture (and cleaned up after).
    await store.insertRows("traces", [trace({ id: "tc", name: "Cost Trace" })]);
    await store.insertRows("observations", [
      observation({
        id: "oc1",
        trace_id: "tc",
        prompt_id: "cost-prompt",
        prompt_version: "1",
        total_cost: 0.01,
        total_tokens: 100,
      }),
      observation({
        id: "oc2",
        trace_id: "tc",
        prompt_id: "cost-prompt",
        prompt_version: "2",
        total_cost: 0.05,
        total_tokens: 200,
      }),
      observation({
        id: "oc3",
        trace_id: "tc",
        prompt_id: "cost-prompt",
        prompt_version: "2",
        total_cost: 0.02,
        total_tokens: 50,
      }),
    ]);

    const rows = await store.costByPromptVersion(P, "cost-prompt");
    expect(rows).toHaveLength(2);
    // v2 outspends v1 and aggregates its two uses; ranked by cost DESC.
    expect(rows[0]!).toMatchObject({ prompt_version: "2", observation_count: 2, total_tokens: 250 });
    expect(rows[0]!.total_cost).toBeCloseTo(0.07, 6);
    expect(rows[1]!).toMatchObject({ prompt_version: "1", observation_count: 1, total_tokens: 100 });
    // Unknown prompt → nothing.
    expect(await store.costByPromptVersion(P, "nope")).toHaveLength(0);

    await store.deleteTraces(P, ["tc"]); // restore fixture state for the delete test below
  });

  it("attributes scores to a prompt's A/B arms (per prompt_version)", async () => {
    // Each trace resolves one arm; the score on that trace attributes to that arm's version.
    await store.insertRows("traces", [trace({ id: "ta" }), trace({ id: "tb" }), trace({ id: "tc" })]);
    await store.insertRows("observations", [
      observation({ id: "oa", trace_id: "ta", prompt_id: "ab-prompt", prompt_version: "1" }),
      observation({ id: "ob", trace_id: "tb", prompt_id: "ab-prompt", prompt_version: "2" }),
      observation({ id: "oc", trace_id: "tc", prompt_id: "ab-prompt", prompt_version: "2" }),
    ]);
    await store.insertRows("scores", [
      score({ id: "sa", trace_id: "ta", name: "quality", value: 0.9 }),
      score({ id: "sb", trace_id: "tb", name: "quality", value: 0.5 }),
      score({ id: "sc", trace_id: "tc", name: "quality", value: 0.7 }),
    ]);

    const rows = await store.scoresByPromptVersion(P, "ab-prompt");
    expect(rows).toHaveLength(2); // v2, v1 (version DESC)
    expect(rows[0]).toMatchObject({ prompt_version: "2", score_name: "quality", score_count: 2 });
    expect(rows[0]!.avg_value).toBeCloseTo(0.6, 6); // (0.5 + 0.7) / 2
    expect(rows[1]).toMatchObject({ prompt_version: "1", score_name: "quality", score_count: 1 });
    expect(rows[1]!.avg_value).toBeCloseTo(0.9, 6);
    expect(await store.scoresByPromptVersion(P, "nope")).toHaveLength(0);

    await store.deleteTraces(P, ["ta", "tb", "tc"]); // restore fixture state
  });

  it("computes filter facets (environment / name / tags) with counts", async () => {
    const facets = await store.traceFacets(P, {});
    expect(facets.environments).toContainEqual({ value: "default", count: 1 });
    expect(facets.names).toContainEqual({ value: "Conformance Trace", count: 1 });
    // Tags are unnested via explode — each counted once, including the quotes/comma tag.
    expect(facets.tags).toContainEqual({ value: "alpha", count: 1 });
    expect(facets.tags).toContainEqual({ value: 'tricky "quoted", comma', count: 1 });
    // Scores facet: distinct score names among matching traces, with per-trace counts.
    expect(facets.scores).toContainEqual({ value: "quality", count: 1 });
    // Levels facet: distinct observation levels among matching traces.
    expect(facets.levels).toContainEqual({ value: "DEFAULT", count: 1 });

    // Facet-excluding: an environment filter narrows the name/tag facets, but the environment
    // facet ignores its own filter so its alternatives stay visible.
    const filtered = await store.traceFacets(P, { environment: "does-not-exist" });
    expect(filtered.names).toHaveLength(0);
    expect(filtered.tags).toHaveLength(0);
    expect(filtered.environments).toContainEqual({ value: "default", count: 1 });
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
    expect(gen.cache_read_tokens).toBe(40);
    expect(gen.cache_creation_tokens).toBe(60);
    expect(gen.end_time).not.toBeNull();
    expect(gen.prompt_id).toBe("p1"); // prompt linkage surfaced on the observation
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
    expect(byDay[0]!.errors).toBe(0); // seeded generation is DEFAULT level
    expect(byDay[0]!.total_tokens).toBe(300);
    expect(byDay[0]!.p95_latency_ms).toBeGreaterThan(1000);

    const byModel = await store.metricsByModel(P, 7);
    expect(byModel).toHaveLength(1);
    expect(byModel[0]!.model).toBe("gpt-x");

    expect(await store.countTracesSince(P, 7)).toBe(1);

    // Short-window aggregate (alert engine): the seeded generation is recent, so a wide
    // window captures it; a tiny window (future-anchored seed excluded) is empty.
    const win = await store.metricsWindow(P, 7 * 24 * 60);
    expect(win.generations).toBe(1);
    expect(win.errors).toBe(0);
    expect(win.total_tokens).toBe(300);
    expect(win.trace_count).toBe(1);
    expect(win.p95_latency_ms).toBeGreaterThan(1000);

    // Anomaly-baseline series: 2 windows of 180m each (covers 6h). The ~1h-old seeded
    // generation lands in the NEWEST bucket (last element); the older bucket is zero-filled.
    const series = await store.metricWindowSeries(P, 180, 2);
    expect(series).toHaveLength(2);
    expect(series[1]!.generations).toBe(1);
    expect(series[1]!.trace_count).toBe(1);
    expect(series[1]!.total_cost).toBeCloseTo(0.003, 6);
    expect(series[0]!.generations).toBe(0); // no data in the older window

    // Batched variant (alert cron): one grouped query for many projects. The known project
    // matches; an unknown project is present with zeroed metrics (never absent).
    const batch = await store.metricsWindowByProjects([P, "proj-absent"], 7 * 24 * 60);
    expect(batch.get(P)).toEqual(win);
    expect(batch.get("proj-absent")).toEqual({
      generations: 0,
      errors: 0,
      total_tokens: 0,
      total_cost: 0,
      p50_latency_ms: 0,
      p95_latency_ms: 0,
      trace_count: 0,
    });

    // Tool analytics: SPAN observations grouped by name (calls / error rate / latency),
    // GENERATION rows excluded. Seed under a dedicated trace and clean it up after.
    const tt = "tool-analytics-t";
    await store.insertRows("observations", [
      observation({ id: "tool-1", trace_id: tt, type: "SPAN", name: "search", level: "DEFAULT", latency_ms: 100 }),
      observation({ id: "tool-2", trace_id: tt, type: "SPAN", name: "search", level: "ERROR", latency_ms: 300 }),
      observation({ id: "tool-3", trace_id: tt, type: "SPAN", name: "calculator", level: "DEFAULT", latency_ms: 20 }),
      observation({ id: "tool-4", trace_id: tt, type: "GENERATION", name: "llm", latency_ms: 999 }),
    ]);
    const tools = Object.fromEntries((await store.toolAnalytics(P, 7)).map((r) => [r.tool, r]));
    expect(tools.search).toMatchObject({ calls: 2, errors: 1, error_rate: 0.5 });
    expect(tools.search!.p95_latency_ms).toBeGreaterThanOrEqual(100);
    expect(tools.calculator).toMatchObject({ calls: 1, errors: 0, error_rate: 0, avg_latency_ms: 20 });
    expect(tools.llm).toBeUndefined(); // GENERATION excluded
    await store.deleteTraces(P, [tt]);

    const widget = await store.widgetSeries(P, "tokens", "by_model", 7);
    expect(widget).toHaveLength(1);
    expect(widget[0]!.value).toBe(300);

    // v2: new metrics — error_rate (seeded obs is DEFAULT level) and score (avg of base score 0.8).
    expect((await store.widgetSeries(P, "error_rate", "by_day", 7))[0]!.value).toBe(0);
    const scoreDay = await store.widgetSeries(P, "score", "by_day", 7);
    expect(scoreDay).toHaveLength(1);
    // sc1 was corrected to 0.95 by the score-correction test earlier in this suite (LWW).
    expect(scoreDay[0]!.value).toBeCloseTo(0.95, 6);
    // v2: new breakdowns — cost by end user (joins observations onto traces).
    const costByUser = await store.widgetSeries(P, "cost", "by_user", 7);
    expect(costByUser[0]!.label).toBe("u1");
    expect(costByUser[0]!.value).toBeCloseTo(0.003, 6);
    // v2: per-widget filters (env / tag / model) — match vs miss.
    expect(await store.widgetSeries(P, "tokens", "by_model", 7, { environment: "default" })).toHaveLength(1);
    expect(await store.widgetSeries(P, "tokens", "by_model", 7, { environment: "nope" })).toHaveLength(0);
    expect(await store.widgetSeries(P, "tokens", "by_model", 7, { tag: "alpha" })).toHaveLength(1);
    expect(await store.widgetSeries(P, "tokens", "by_model", 7, { tag: "nope" })).toHaveLength(0);
    expect(await store.widgetSeries(P, "cost", "by_model", 7, { model: "gpt-x" })).toHaveLength(1);
    expect(await store.widgetSeries(P, "cost", "by_model", 7, { model: "nope" })).toHaveLength(0);

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
    expect(gen.cache_read_tokens).toBe(40);
    expect(gen.cache_creation_tokens).toBe(60);
    expect(gen.total_cost).toBeCloseTo(0.003, 6);
    expect(gen.end_time).not.toBeNull();
    expect(obs.find((o) => o.id === "o2")!.end_time).toBeNull();
  });

  it("exports traces with nested observations and counts project rows", async () => {
    const exported = await store.exportTraces(P, {});
    expect(exported).toHaveLength(1);
    expect(exported[0]!.observations).toHaveLength(2);

    // Export honors the same trace-list filters (matching → 1 row, non-matching → 0).
    expect(await store.exportTraces(P, { userId: "u1" })).toHaveLength(1);
    expect(await store.exportTraces(P, { userId: "nope" })).toHaveLength(0);
    expect(await store.exportTraces(P, { tag: "alpha" })).toHaveLength(1);

    const counts = await store.countProjectRows(P);
    expect(counts).toEqual({ traces: 1, observations: 2, scores: 1 });

    const io = await store.getTraceIO(P, ["t1", "missing"]);
    expect(io).toHaveLength(1);
    expect(await store.getScoresByTraceIds(P, ["t1"])).toHaveLength(1);
  });

  it("round-trips retrieval documents, embeddings, and projections", async () => {
    // Retrieval docs by observation id, ordered by rank; quotes/commas survive round-trip.
    const docs = await store.listRetrievalDocumentsByObservationIds(P, ["o1"]);
    expect(docs).toHaveLength(2);
    expect(docs[0]).toMatchObject({ observation_id: "o1", rank: 0, doc_id: "docA", content: "Doc A" });
    expect(docs[0]!.score).toBeCloseTo(0.9);
    expect(docs[0]!.metadata).toContain("kb");
    expect(docs[1]!.rank).toBe(1);
    expect(docs[1]!.content).toContain('tricky "quoted", comma');
    expect(await store.listRetrievalDocumentsByObservationIds(P, ["missing"])).toHaveLength(0);
    expect(await store.listRetrievalDocumentsByObservationIds(P, [])).toHaveLength(0);

    // Embeddings: raw ARRAY<FLOAT> vectors round-trip (per-element placeholders, no CAST corruption).
    const vecs = await store.listEmbeddingsForProjection(P, { days: 7, limit: 100 });
    expect(vecs).toHaveLength(2);
    const o1 = vecs.find((v) => v.observation_id === "o1")!;
    expect(o1.trace_id).toBe("t1");
    expect(o1.vector).toHaveLength(4);
    [0.1, 0.2, 0.3, 0.4].forEach((n, i) => {
      expect(o1.vector[i]!).toBeCloseTo(n, 5);
    });

    // Projection points + latest-run resolution.
    expect(await store.latestProjectionRunId(P)).toBe("run1");
    const points = await store.listEmbeddingProjection(P, { runId: "run1" });
    expect(points).toHaveLength(2);
    const p1 = points.find((p) => p.observation_id === "o1")!;
    expect(p1).toMatchObject({ trace_id: "t1", cluster_id: 2 });
    expect(p1.x).toBeCloseTo(1.5);
    expect(p1.y).toBeCloseTo(-2.5);
    expect(p1.z).toBeNull();
    expect(p1.color_value).toBeNull(); // store leaves color null; packages/server fills it
    // Resolves the latest run without an explicit runId.
    expect(await store.listEmbeddingProjection(P)).toHaveLength(2);
  });

  it("overwrites an embedding vector on same id + newer event_ts (LWW), no duplicate", async () => {
    await store.insertRows("embeddings", [embeddingRow({ vector: [9, 8, 7, 6], event_ts: iso(60_000) })]);
    const vecs = await store.listEmbeddingsForProjection(P, { days: 7, limit: 100 });
    expect(vecs).toHaveLength(2); // o1 overwritten in place, o2 unchanged — no duplicate row
    const o1 = vecs.find((v) => v.observation_id === "o1")!;
    [9, 8, 7, 6].forEach((n, i) => {
      expect(o1.vector[i]!).toBeCloseTo(n, 4);
    });
  });

  it("ranks similar traces by exact cosine, scoped by model/dim, and hydrates by trace id", async () => {
    // Sibling traces in a distinct embedding space (model "sim-test", dim 3), isolated from the
    // o1/o2 fixtures (model "text-embedding-3-small", dim 4).
    await store.insertRows("traces", [
      trace({ id: "t2", name: "Sim Two" }),
      trace({ id: "t3", name: "Sim Three" }),
      trace({ id: "t4", name: "Sim Four" }),
    ]);
    await store.insertRows("embeddings", [
      embeddingRow({ observation_id: "oa", trace_id: "t2", model: "sim-test", dim: 3, vector: [1, 0, 0] }),
      embeddingRow({ observation_id: "ob", trace_id: "t3", model: "sim-test", dim: 3, vector: [0.9, 0.1, 0] }), // close
      embeddingRow({ observation_id: "ob2", trace_id: "t3", model: "sim-test", dim: 3, vector: [0, 1, 0] }), // far; MIN keeps close
      embeddingRow({ observation_id: "oc", trace_id: "t4", model: "sim-test", dim: 3, vector: [-1, 0, 0] }), // opposite
      // Same model, different dim — must NOT be compared when the seed space is dim 3.
      embeddingRow({ observation_id: "od", trace_id: "t4", model: "sim-test", dim: 4, vector: [1, 0, 0, 0] }),
    ]);

    // Seed vectors for a trace carry model + dim.
    const seed = await store.getTraceEmbeddings(P, "t2");
    expect(seed).toHaveLength(1);
    expect(seed[0]).toMatchObject({ observation_id: "oa", trace_id: "t2", model: "sim-test", dim: 3 });
    expect(seed[0]!.vector[0]!).toBeCloseTo(1, 5);

    // Exact cosine k-NN, computed in Doris. Seed = t2's [1,0,0]. Order: t3 (closest obs ~1.0) >
    // t4 (-1). The seed trace is excluded; the dim-4 row never participates.
    const ranked = await store.rankSimilarTraceIds(P, {
      seedVectors: seed.map((s) => s.vector),
      model: "sim-test",
      dim: 3,
      excludeTraceId: "t2",
      limit: 10,
    });
    expect(ranked.map((r) => r.trace_id)).toEqual(["t3", "t4"]);
    expect(ranked[0]!.similarity).toBeGreaterThan(0.98); // t3's closest obs ≈ 0.993
    expect(ranked[1]!.similarity).toBeCloseTo(-1, 5); // t4 opposite
    // A space with no rows returns nothing.
    expect(
      await store.rankSimilarTraceIds(P, {
        seedVectors: [[1, 0, 0]],
        model: "nope",
        dim: 3,
        excludeTraceId: "t2",
        limit: 10,
      }),
    ).toHaveLength(0);

    // Hydrating summaries by explicit id set (the similarity result → trace summaries step).
    const summaries = await store.listTraces(P, { traceIds: ["t2", "t3"], limit: 10 });
    expect(new Set(summaries.map((s) => s.id))).toEqual(new Set(["t2", "t3"]));
    expect(await store.listTraces(P, { traceIds: ["t2"], limit: 10 })).toHaveLength(1);
    expect(await store.listTraces(P, { traceIds: [], limit: 10 }).then((r) => r.length)).toBeGreaterThan(1); // empty set ⇒ no id filter

    // Restore fixture state for the delete test below (cascades the sim-test embeddings).
    await store.deleteTraces(P, ["t2", "t3", "t4"]);
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
    // Retrieval docs, embeddings, and projections for the trace are cascade-deleted as well.
    expect(await store.listRetrievalDocumentsByObservationIds(P, ["o1"])).toHaveLength(0);
    expect(await store.listEmbeddingsForProjection(P, { days: 30, limit: 100 })).toHaveLength(0);
    expect(await store.listEmbeddingProjection(P, { runId: "run1" })).toHaveLength(0);
  });
});
