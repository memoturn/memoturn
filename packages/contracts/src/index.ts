import { z } from "zod";

/**
 * Shared API response contracts — the single source of truth for memoturn's read API
 * shapes. The API uses these zod schemas for its OpenAPI responses; the server derives
 * function return types and the console derives client types, all via z.infer. Zod-only
 * (no runtime deps) so the console can import the inferred types without bundling weight.
 */

// ── Traces ───────────────────────────────────────────────────────────────────────
export const traceSummary = z.object({
  id: z.string(),
  name: z.string(),
  timestamp: z.string(),
  user_id: z.string(),
  session_id: z.string(),
  environment: z.string(),
  tags: z.array(z.string()),
  observation_count: z.number(),
  total_cost: z.number(),
  total_tokens: z.number(),
  latency_ms: z.number(),
});
export type TraceSummary = z.infer<typeof traceSummary>;

// A trace's scores, condensed for the list view (name + value).
export const traceListScore = z.object({
  name: z.string(),
  value: z.number().nullable(),
  string_value: z.string(),
});
export type TraceListScore = z.infer<typeof traceListScore>;

// Paginated trace list: the page of rows, the total matching the filters, and a per-trace score map.
export const tracePage = z.object({
  data: z.array(traceSummary),
  total: z.number(),
  scores: z.record(z.string(), z.array(traceListScore)),
});
export type TracePage = z.infer<typeof tracePage>;

// A trace returned by semantic similarity search — a trace summary plus its cosine similarity
// (-1…1, where 1 = identical) to the seed trace's embedding. Higher = more alike.
export const similarTrace = traceSummary.extend({ similarity: z.number() });
export type SimilarTrace = z.infer<typeof similarTrace>;
export const similarTraces = z.object({ data: z.array(similarTrace) });
export type SimilarTraces = z.infer<typeof similarTraces>;

// Result of annotating a trace (writing an ANNOTATION score); the score lands asynchronously.
export const annotationResult = z.object({
  scoreId: z.string(),
  traceId: z.string(),
  name: z.string(),
});
export type AnnotationResult = z.infer<typeof annotationResult>;

// Result of editing a trace's tags (merge-on-write into the telemetry store).
export const traceTags = z.object({
  traceId: z.string(),
  tags: z.array(z.string()),
});
export type TraceTags = z.infer<typeof traceTags>;

export const scoreConfig = z.object({
  id: z.string(),
  name: z.string(),
  dataType: z.enum(["NUMERIC", "CATEGORICAL", "BOOLEAN", "TEXT"]),
  categories: z.array(z.string()),
  min: z.number().nullable(),
  max: z.number().nullable(),
});
export type ScoreConfig = z.infer<typeof scoreConfig>;

export const comment = z.object({
  id: z.string(),
  objectType: z.string(),
  objectId: z.string(),
  author: z.string(),
  content: z.string(),
  createdAt: z.string(),
});
export type Comment = z.infer<typeof comment>;

export const savedView = z.object({
  id: z.string(),
  table: z.string(),
  name: z.string(),
  filters: z.record(z.string(), z.any()),
  createdAt: z.string(),
});
export type SavedView = z.infer<typeof savedView>;

// Faceted filter counts for the traces list — one {value, count} per distinct facet value,
// scoped to the current time range. Powers the faceted filter panel with live counts.
export const facetCount = z.object({ value: z.string(), count: z.number() });
export type FacetCount = z.infer<typeof facetCount>;

export const traceFacets = z.object({
  environments: z.array(facetCount),
  names: z.array(facetCount),
  tags: z.array(facetCount),
  scores: z.array(facetCount),
  levels: z.array(facetCount),
  types: z.array(facetCount),
});
export type TraceFacets = z.infer<typeof traceFacets>;

// ── Structured filter model ──────────────────────────────────────────────────────
// A single filter is a discriminated union on `type`; a filter set is an array of them.
// `FILTER_OPERATORS` is the ONE source of truth mapping each value type to its allowed
// operators — reused by the console (operator dropdown) and the telemetry SQL builder, so
// the UI and the query engine can never drift. Shared by the trace list and the (future)
// dashboard query engine.
export const FILTER_OPERATORS = {
  string: ["eq", "neq", "contains", "not_contains", "starts_with", "ends_with"],
  number: ["eq", "neq", "gt", "lt", "gte", "lte"],
  datetime: ["gt", "lt", "gte", "lte"],
  boolean: ["eq", "neq"],
  stringOptions: ["any_of", "none_of"], // scalar column ∈ a set
  arrayOptions: ["any_of", "none_of", "all_of"], // the column itself is an array (e.g. tags)
  stringObject: ["eq", "neq", "contains", "not_contains", "starts_with", "ends_with"], // key/value (metadata)
  numberObject: ["eq", "neq", "gt", "lt", "gte", "lte"],
  null: ["is_null", "is_not_null"],
} as const;

export type FilterValueType = keyof typeof FILTER_OPERATORS;

export const singleFilter = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("string"),
    column: z.string(),
    operator: z.enum(FILTER_OPERATORS.string),
    value: z.string(),
  }),
  z.object({
    type: z.literal("number"),
    column: z.string(),
    operator: z.enum(FILTER_OPERATORS.number),
    value: z.number(),
  }),
  z.object({
    type: z.literal("datetime"),
    column: z.string(),
    operator: z.enum(FILTER_OPERATORS.datetime),
    value: z.string(), // ISO 8601
  }),
  z.object({
    type: z.literal("boolean"),
    column: z.string(),
    operator: z.enum(FILTER_OPERATORS.boolean),
    value: z.boolean(),
  }),
  z.object({
    type: z.literal("stringOptions"),
    column: z.string(),
    operator: z.enum(FILTER_OPERATORS.stringOptions),
    value: z.array(z.string()),
  }),
  z.object({
    type: z.literal("arrayOptions"),
    column: z.string(),
    operator: z.enum(FILTER_OPERATORS.arrayOptions),
    value: z.array(z.string()),
  }),
  z.object({
    type: z.literal("stringObject"),
    column: z.string(),
    key: z.string(), // arbitrary metadata key
    operator: z.enum(FILTER_OPERATORS.stringObject),
    value: z.string(),
  }),
  z.object({
    type: z.literal("numberObject"),
    column: z.string(),
    key: z.string(),
    operator: z.enum(FILTER_OPERATORS.numberObject),
    value: z.number(),
  }),
  z.object({ type: z.literal("null"), column: z.string(), operator: z.enum(FILTER_OPERATORS.null) }),
]);
export type SingleFilter = z.infer<typeof singleFilter>;

export const filterState = z.array(singleFilter);
export type FilterState = z.infer<typeof filterState>;

/** A filterable column exposed to the builder UI. The physical Doris mapping (uiId → column
 * or subquery) lives server-side in packages/telemetry — the UI only knows id/label/type. */
export interface FilterColumnDef {
  id: string;
  label: string;
  type: FilterValueType;
  /** Preset keys offered for object (key/value) columns; free-text when omitted. */
  keyOptions?: string[];
}

export const TRACE_FILTER_COLUMNS: FilterColumnDef[] = [
  { id: "name", label: "Name", type: "stringOptions" },
  { id: "environment", label: "Environment", type: "stringOptions" },
  { id: "type", label: "Type", type: "stringOptions" },
  { id: "level", label: "Level", type: "stringOptions" },
  { id: "tags", label: "Tags", type: "arrayOptions" },
  { id: "userId", label: "User", type: "string" },
  { id: "sessionId", label: "Session", type: "string" },
  { id: "version", label: "Version", type: "string" },
  { id: "release", label: "Release", type: "string" },
  { id: "timestamp", label: "Timestamp", type: "datetime" },
  { id: "tokens", label: "Tokens", type: "number" },
  { id: "cost", label: "Cost (USD)", type: "number" },
  { id: "latencyMs", label: "Latency (ms)", type: "number" },
  { id: "metadata", label: "Metadata", type: "stringObject" },
];

// ── Analytics query model (dashboard/widget engine) ─────────────────────────────
// A generic query over a declared "view" (traces/observations/scores): pick a metric
// (measure × aggregation) broken down by dimension(s) and/or time, filtered with the shared
// filter model. Compiled to parameterized Doris SQL by a view-declaration registry in
// packages/telemetry. Presence of `timeDimension` makes it a time series.
export const queryView = z.enum(["traces", "observations", "scores"]);
export type QueryView = z.infer<typeof queryView>;

export const queryAggregation = z.enum([
  "count",
  "sum",
  "avg",
  "min",
  "max",
  "p50",
  "p75",
  "p90",
  "p95",
  "p99",
  "uniq",
]);
export type QueryAggregation = z.infer<typeof queryAggregation>;

export const queryGranularity = z.enum(["minute", "hour", "day", "week", "month"]);
export type QueryGranularity = z.infer<typeof queryGranularity>;

export const analyticsQuery = z.object({
  view: queryView,
  metrics: z.array(z.object({ measure: z.string(), aggregation: queryAggregation })).min(1),
  dimensions: z.array(z.object({ field: z.string() })).default([]),
  filters: filterState.default([]),
  timeDimension: z.object({ granularity: queryGranularity }).nullable().default(null),
  fromTimestamp: z.string(), // ISO 8601 (inclusive)
  toTimestamp: z.string(), // ISO 8601 (exclusive)
  orderBy: z.array(z.object({ field: z.string(), direction: z.enum(["asc", "desc"]) })).default([]),
  rowLimit: z.number().int().min(1).max(1000).default(100),
});
export type AnalyticsQuery = z.infer<typeof analyticsQuery>;

// Result rows are keyed by dimension field / "time" and by `${aggregation}_${measure}` metric
// columns; values are strings (dimensions/time) or numbers (metrics), null when unmeasured.
export const queryResult = z.object({
  rows: z.array(z.record(z.string(), z.union([z.string(), z.number(), z.null()]))),
});
export type QueryResult = z.infer<typeof queryResult>;

// Widget chart types. Time-series types (line/bar) require the query's `timeDimension`; the rest
// are total-value shapes over a dimension breakdown (or a single aggregate for big_number).
export const chartType = z.enum(["line", "bar", "horizontal_bar", "big_number", "pie", "table"]);
export type ChartType = z.infer<typeof chartType>;
export const TIME_SERIES_CHARTS: ChartType[] = ["line", "bar"];

// UI-facing catalog of the analytics views: which measures (+ their valid aggregations) and
// dimensions each view exposes. Mirrors the server-side view-declaration registry in
// packages/telemetry (validateQuery is the authority; this drives the builder's dropdowns).
export interface ViewMeasure {
  id: string;
  label: string;
  aggregations: QueryAggregation[];
}
export interface ViewCatalog {
  view: QueryView;
  label: string;
  measures: ViewMeasure[];
  dimensions: { id: string; label: string }[];
}

export const ANALYTICS_VIEWS: ViewCatalog[] = [
  {
    view: "observations",
    label: "Observations",
    measures: [
      { id: "count", label: "Count", aggregations: ["count"] },
      { id: "cost", label: "Cost (USD)", aggregations: ["sum", "avg", "min", "max", "p50", "p95", "p99"] },
      { id: "tokens", label: "Tokens", aggregations: ["sum", "avg", "max", "p95"] },
      { id: "latency", label: "Latency (ms)", aggregations: ["avg", "p50", "p95", "p99", "max"] },
    ],
    dimensions: [
      { id: "model", label: "Model" },
      { id: "type", label: "Type" },
      { id: "level", label: "Level" },
      { id: "environment", label: "Environment" },
      { id: "provider", label: "Provider" },
      { id: "name", label: "Name" },
    ],
  },
  {
    view: "traces",
    label: "Traces",
    measures: [{ id: "count", label: "Count", aggregations: ["count"] }],
    dimensions: [
      { id: "environment", label: "Environment" },
      { id: "userId", label: "User" },
      { id: "sessionId", label: "Session" },
      { id: "name", label: "Name" },
    ],
  },
  {
    view: "scores",
    label: "Scores",
    measures: [
      { id: "count", label: "Count", aggregations: ["count"] },
      { id: "value", label: "Value", aggregations: ["avg", "min", "max", "p50", "p95"] },
    ],
    dimensions: [
      { id: "name", label: "Name" },
      { id: "source", label: "Source" },
      { id: "environment", label: "Environment" },
      { id: "dataType", label: "Data type" },
    ],
  },
];

/** Trace volume over the selected range, bucketed by hour (short ranges) or day. */
export const traceHistogramBucket = z.object({ bucket: z.string(), count: z.number() });
export type TraceHistogramBucket = z.infer<typeof traceHistogramBucket>;
export const traceHistogram = z.object({
  interval: z.enum(["hour", "day"]),
  buckets: z.array(traceHistogramBucket),
});
export type TraceHistogram = z.infer<typeof traceHistogram>;

export const modelPrice = z.object({
  id: z.string(),
  pattern: z.string(),
  provider: z.string(),
  inputPerMTok: z.number(),
  outputPerMTok: z.number(),
  createdAt: z.string(),
});
export type ModelPrice = z.infer<typeof modelPrice>;

export const modelPriceBuiltin = z.object({
  pattern: z.string(),
  provider: z.string(),
  inputPerMTok: z.number(),
  outputPerMTok: z.number(),
});
export const modelPriceList = z.object({
  data: z.array(modelPrice),
  builtins: z.array(modelPriceBuiltin),
});
export type ModelPriceList = z.infer<typeof modelPriceList>;

export const scheduledExport = z.object({
  enabled: z.boolean(),
  environment: z.string(),
  limit: z.number(),
  lastRunAt: z.string().nullable(),
  lastKey: z.string(),
  lastCount: z.number(),
});
export type ScheduledExport = z.infer<typeof scheduledExport>;

export const scheduledExportResult = z.object({
  projectId: z.string(),
  key: z.string(),
  count: z.number(),
  ranAt: z.string(),
});
export type ScheduledExportResult = z.infer<typeof scheduledExportResult>;

// Head-based ingest sampling: percent (0–100) of traces kept in the query store (100 = all).
export const samplingPolicy = z.object({ rate: z.number() });
export type SamplingPolicy = z.infer<typeof samplingPolicy>;

export const maskingPolicy = z.object({
  enabled: z.boolean(),
  builtins: z.array(z.string()),
  customPatterns: z.array(z.string()),
  redactWith: z.string(),
  available: z.array(z.string()),
});
export type MaskingPolicy = z.infer<typeof maskingPolicy>;

// Runtime guardrails: the per-project policy config, and a single check's verdict.
export const evaluatorGuard = z.object({
  name: z.string(),
  comparator: z.enum(["gt", "gte", "lt", "lte"]),
  threshold: z.number(),
});
export type EvaluatorGuard = z.infer<typeof evaluatorGuard>;

export const guardrailPolicy = z.object({
  enabled: z.boolean(),
  pii: z.boolean(),
  piiAction: z.enum(["redact", "block"]),
  builtins: z.array(z.string()),
  customPatterns: z.array(z.string()),
  redactWith: z.string(),
  injection: z.boolean(),
  blockedTerms: z.array(z.string()),
  sqlInjection: z.boolean(),
  requireMatch: z.array(z.string()),
  requireValidJson: z.boolean(),
  requiredJsonKeys: z.array(z.string()),
  evaluatorGuards: z.array(evaluatorGuard),
  available: z.array(z.string()),
});
export type GuardrailPolicy = z.infer<typeof guardrailPolicy>;

export const guardrailVerdict = z.object({
  verdict: z.enum(["allow", "redact", "block"]),
  findings: z.array(
    z.object({
      category: z.enum(["pii", "injection", "blocked_term", "sql_injection", "json_invalid", "evaluator"]),
      type: z.string(),
      count: z.number(),
      score: z.number().optional(),
    }),
  ),
  redactedText: z.string().optional(),
});
export type GuardrailVerdict = z.infer<typeof guardrailVerdict>;

export const analyticsSink = z.object({
  enabled: z.boolean(),
  type: z.string(),
  host: z.string(),
  apiKey: z.string(),
});
export type AnalyticsSink = z.infer<typeof analyticsSink>;

export const automation = z.object({
  id: z.string(),
  name: z.string(),
  trigger: z.string(),
  action: z.string(),
  target: z.string(),
  threshold: z.number().nullable(),
  filter: z.string(),
  enabled: z.boolean(),
  createdAt: z.string(),
});
export type Automation = z.infer<typeof automation>;

/** A notification channel (shared by alerts + budgets). target: URL (slack/webhook),
 *  routing key (pagerduty), or email address (email). */
export const alertChannel = z.object({
  type: z.enum(["slack", "webhook", "pagerduty", "email"]),
  target: z.string(),
});
export type AlertChannel = z.infer<typeof alertChannel>;

export const alertRule = z.object({
  id: z.string(),
  name: z.string(),
  metric: z.string(), // error_rate | latency_p95 | cost_per_day | ingest_volume | dlq_depth
  window: z.number(),
  threshold: z.number(),
  comparator: z.string(), // gt | gte | lt | lte
  channels: z.array(alertChannel),
  enabled: z.boolean(),
  createdAt: z.string(),
  status: z.string(), // ok | firing | resolved
  lastValue: z.number().nullable(),
  lastFiredAt: z.string().nullable(),
  lastResolvedAt: z.string().nullable(),
});
export type AlertRule = z.infer<typeof alertRule>;

export const costBudget = z
  .object({
    monthlyUsd: z.number(),
    thresholds: z.array(z.number()),
    channels: z.array(alertChannel),
    createdAt: z.string(),
  })
  .nullable();
export type CostBudget = z.infer<typeof costBudget>;

export const ingestHealth = z.object({
  workerReachable: z.boolean(),
  dlqDepth: z.number(),
  insertLatencyMs: z.number().nullable(),
  counters: z.record(z.string(), z.number()),
  recentFailures: z.array(
    z.object({ batchId: z.string(), projectId: z.string(), failedAt: z.string(), error: z.string() }),
  ),
});
export type IngestHealth = z.infer<typeof ingestHealth>;

/** A document a retriever span returned (RAG analysis). */
export const retrievalDocument = z.object({
  rank: z.number(),
  score: z.number().nullable(),
  doc_id: z.string(),
  content: z.string(),
  metadata: z.string(),
});
export type RetrievalDocument = z.infer<typeof retrievalDocument>;

export const observationDetail = z.object({
  id: z.string(),
  trace_id: z.string(),
  type: z.string(),
  parent_observation_id: z.string(),
  name: z.string(),
  start_time: z.string(),
  end_time: z.string().nullable(),
  level: z.string(),
  status_message: z.string(),
  model: z.string(),
  provider: z.string(),
  prompt_id: z.string(),
  prompt_version: z.string(),
  prompt_tokens: z.number(),
  completion_tokens: z.number(),
  total_tokens: z.number(),
  cache_read_tokens: z.number(),
  cache_creation_tokens: z.number(),
  total_cost: z.number(),
  latency_ms: z.number(),
  input: z.string(),
  output: z.string(),
  metadata: z.string(),
  // RAG: documents this span retrieved (empty for non-retriever spans).
  retrieval_documents: z.array(retrievalDocument),
});
export type ObservationDetail = z.infer<typeof observationDetail>;

// ── Embeddings projection (RAG cluster/scatter view) ────────────────────────────
export const embeddingPoint = z.object({
  observation_id: z.string(),
  trace_id: z.string(),
  x: z.number(),
  y: z.number(),
  z: z.number().nullable(),
  cluster_id: z.number(),
  color_value: z.number().nullable(), // e.g. an eval score, for color-by
});
export type EmbeddingPoint = z.infer<typeof embeddingPoint>;

export const embeddingProjection = z.object({
  run_id: z.string(),
  method: z.string(),
  cluster_count: z.number(),
  points: z.array(embeddingPoint),
});
export type EmbeddingProjection = z.infer<typeof embeddingProjection>;

/** Result of an on-demand projection run (empty run_id when there weren't enough vectors). */
export const embeddingProjectionRun = z.object({
  run_id: z.string(),
  points: z.number(),
});
export type EmbeddingProjectionRun = z.infer<typeof embeddingProjectionRun>;

export const scoreRow = z.object({
  name: z.string(),
  source: z.string(),
  data_type: z.string(),
  value: z.number().nullable(),
  string_value: z.string(),
  comment: z.string(),
  timestamp: z.string(),
});
export type ScoreRow = z.infer<typeof scoreRow>;

/** Response from PATCH /v1/scores/{id} — the full corrected score row. */
export const scoreCorrected = scoreRow.extend({
  id: z.string(),
  trace_id: z.string(),
});
export type ScoreCorrected = z.infer<typeof scoreCorrected>;

export const traceDetail = traceSummary.extend({
  release: z.string(),
  version: z.string(),
  tags: z.array(z.string()),
  metadata: z.string(),
  input: z.string(),
  output: z.string(),
  observations: z.array(observationDetail),
  scores: z.array(scoreRow),
});
export type TraceDetail = z.infer<typeof traceDetail>;

export const sessionSummary = z.object({
  session_id: z.string(),
  trace_count: z.number(),
  first_seen: z.string(),
  last_seen: z.string(),
  total_cost: z.number(),
});
export type SessionSummary = z.infer<typeof sessionSummary>;

export const sessionPage = z.object({
  data: z.array(sessionSummary),
  total: z.number(),
});
export type SessionPage = z.infer<typeof sessionPage>;

// Per-end-user rollup (traces grouped by user_id) — the Users view.
export const userSummary = z.object({
  user_id: z.string(),
  trace_count: z.number(),
  first_seen: z.string(),
  last_seen: z.string(),
  total_cost: z.number(),
});
export type UserSummary = z.infer<typeof userSummary>;

export const userPage = z.object({
  data: z.array(userSummary),
  total: z.number(),
});
export type UserPage = z.infer<typeof userPage>;

// ── Metrics ────────────────────────────────────────────────────────────────────
export const dailyMetric = z.object({
  date: z.string(),
  generations: z.number(),
  errors: z.number(),
  total_tokens: z.number(),
  total_cost: z.number(),
  p50_latency_ms: z.number(),
  p95_latency_ms: z.number(),
});
export type DailyMetric = z.infer<typeof dailyMetric>;

export const modelMetric = z.object({
  model: z.string(),
  generations: z.number(),
  total_tokens: z.number(),
  total_cost: z.number(),
});
export type ModelMetric = z.infer<typeof modelMetric>;

export const metricsSummary = z.object({
  total_traces: z.number(),
  total_generations: z.number(),
  total_errors: z.number(),
  total_tokens: z.number(),
  total_cost: z.number(),
  byDay: z.array(dailyMetric),
  byModel: z.array(modelMetric),
});
export type MetricsSummary = z.infer<typeof metricsSummary>;

// Cost rollup: spend grouped by a dimension (user or session), ranked by cost. `key` is the
// user_id or session_id; empty keys are excluded upstream.
export const costRollupRow = z.object({
  key: z.string(),
  trace_count: z.number(),
  total_cost: z.number(),
  total_tokens: z.number(),
});
export type CostRollupRow = z.infer<typeof costRollupRow>;

// Per-tool (named SPAN observation) analytics: call volume, error rate, and latency —
// the top agent-debugging view ("which tool/step is slow or failing").
export const toolAnalyticsRow = z.object({
  tool: z.string(),
  calls: z.number(),
  errors: z.number(),
  error_rate: z.number(),
  p50_latency_ms: z.number(),
  p95_latency_ms: z.number(),
  avg_latency_ms: z.number(),
});
export type ToolAnalyticsRow = z.infer<typeof toolAnalyticsRow>;

// ── Evaluator analytics ────────────────────────────────────────────────────────
export const evaluatorScoreSummary = z.object({
  name: z.string(),
  count: z.number(),
  avgValue: z.number(),
});
export type EvaluatorScoreSummary = z.infer<typeof evaluatorScoreSummary>;

export const evaluatorScoreTrend = z.object({
  date: z.string(),
  name: z.string(),
  count: z.number(),
  avgValue: z.number(),
});
export type EvaluatorScoreTrend = z.infer<typeof evaluatorScoreTrend>;

export const evaluatorAnalytics = z.object({
  days: z.number(),
  summary: z.array(evaluatorScoreSummary),
  trend: z.array(evaluatorScoreTrend),
});
export type EvaluatorAnalytics = z.infer<typeof evaluatorAnalytics>;

// ── Prompts ──────────────────────────────────────────────────────────────────────
// A channel is a deployment pointer. `version` is the live (control) version. When `status`
// is "experiment", a weighted A/B split routes `splitWeight`% of resolves to `splitVersion`
// (the challenger), sticky per bucketing key; the rest get `version`.
export const promptChannel = z.object({
  label: z.string(),
  version: z.number(),
  splitVersion: z.number().nullable(),
  splitWeight: z.number(),
  status: z.string(),
});
export type PromptChannel = z.infer<typeof promptChannel>;

// One score's mean + count for a single prompt version — the per-arm quality signal that
// tells you which A/B arm is winning. `prompt_version` empty = generations with no pinned version.
export const promptArmScore = z.object({
  prompt_version: z.string(),
  score_name: z.string(),
  score_count: z.number(),
  avg_value: z.number(),
});
export type PromptArmScore = z.infer<typeof promptArmScore>;

export const promptListItem = z.object({
  name: z.string(),
  folder: z.string(),
  versions: z.number(),
  latestVersion: z.number(),
  channels: z.array(promptChannel),
  updatedAt: z.string(),
});
export type PromptListItem = z.infer<typeof promptListItem>;

export const promptVersionDetail = z.object({
  version: z.number(),
  type: z.enum(["TEXT", "CHAT"]),
  content: z.unknown(),
  config: z.unknown(),
  createdAt: z.string(),
});
export type PromptVersionDetail = z.infer<typeof promptVersionDetail>;

export const promptDetail = promptListItem.extend({ allVersions: z.array(promptVersionDetail) });
export type PromptDetail = z.infer<typeof promptDetail>;

// Spend attributed to one version of a prompt (observations grouped by prompt_version). Empty
// prompt_version means the prompt was used without a pinned version. Closes the loop between the
// prompt registry and cost: "did v3 get more expensive than v2?".
export const promptVersionCost = z.object({
  prompt_version: z.string(),
  observation_count: z.number(),
  total_cost: z.number(),
  total_tokens: z.number(),
});
export type PromptVersionCost = z.infer<typeof promptVersionCost>;

// ── Datasets ─────────────────────────────────────────────────────────────────────
export const datasetListItem = z.object({
  name: z.string(),
  description: z.string(),
  items: z.number(),
  runs: z.number(),
  createdAt: z.string(),
});
export type DatasetListItem = z.infer<typeof datasetListItem>;

export const datasetItemRow = z.object({
  id: z.string(),
  input: z.unknown(),
  expectedOutput: z.unknown(),
  metadata: z.unknown(),
});
export type DatasetItemRow = z.infer<typeof datasetItemRow>;

export const datasetRunRow = z.object({
  name: z.string(),
  itemCount: z.number(),
  createdAt: z.string(),
  version: z.number().nullable(),
});
export type DatasetRunRow = z.infer<typeof datasetRunRow>;

export const datasetVersionRow = z.object({
  version: z.number(),
  label: z.string(),
  description: z.string(),
  itemCount: z.number(),
  runCount: z.number(),
  createdAt: z.string(),
});
export type DatasetVersionRow = z.infer<typeof datasetVersionRow>;

export const datasetDetail = z.object({
  name: z.string(),
  description: z.string(),
  currentVersion: z.number(),
  items: z.array(datasetItemRow),
  runs: z.array(datasetRunRow),
  versions: z.array(datasetVersionRow),
});
export type DatasetDetail = z.infer<typeof datasetDetail>;

export const datasetVersionDetail = z.object({
  version: z.number(),
  label: z.string(),
  description: z.string(),
  items: z.array(datasetItemRow),
});
export type DatasetVersionDetail = z.infer<typeof datasetVersionDetail>;

export const experimentCell = z.object({
  traceId: z.string(),
  output: z.string(),
  scores: z.array(z.object({ name: z.string(), value: z.number().nullable(), stringValue: z.string() })),
});
export const experimentItem = z.object({
  id: z.string(),
  input: z.unknown(),
  expectedOutput: z.unknown(),
  cells: z.array(experimentCell.nullable()),
});
export const experimentComparison = z.object({
  dataset: z.string(),
  runs: z.array(z.string()),
  items: z.array(experimentItem),
});
export type ExperimentComparison = z.infer<typeof experimentComparison>;

// CI quality gate: a run's per-score means checked against threshold bounds.
export const gateFailure = z.object({
  scoreName: z.string(),
  reason: z.enum(["below_min", "above_max", "regression", "missing_score"]),
  value: z.number().nullable(),
  bound: z.number(),
  baseline: z.number().optional(),
});
export const gateResult = z.object({
  dataset: z.string(),
  run: z.string(),
  baselineRun: z.string().nullable(),
  passed: z.boolean(),
  scores: z.array(z.object({ name: z.string(), mean: z.number(), count: z.number() })),
  failures: z.array(gateFailure),
});
export type GateResult = z.infer<typeof gateResult>;

// ── Experiments (server-executed dataset runs) ──────────────────────────────────
export const experimentStatus = z.enum(["PENDING", "RUNNING", "COMPLETED", "FAILED", "CANCELLED"]);
export type ExperimentStatus = z.infer<typeof experimentStatus>;

export const experimentConfig = z.object({
  datasetName: z.string(),
  name: z.string(),
  provider: z.string().optional(),
  model: z.string(),
  params: z.record(z.string(), z.unknown()).optional(),
  promptName: z.string().optional(),
  promptChannel: z.string().optional(),
  evaluators: z.array(z.string()).optional(),
});
export type ExperimentConfig = z.infer<typeof experimentConfig>;

export const experimentSummary = z.object({
  id: z.string(),
  name: z.string(),
  dataset: z.string(),
  status: experimentStatus,
  provider: z.string(),
  model: z.string(),
  totalItems: z.number(),
  completedItems: z.number(),
  failedItems: z.number(),
  createdAt: z.string(),
});
export type ExperimentSummary = z.infer<typeof experimentSummary>;

export const experimentItemResult = z.object({
  datasetItemId: z.string(),
  status: z.string(),
  traceId: z.string(),
  error: z.string(),
});
export type ExperimentItemResult = z.infer<typeof experimentItemResult>;

export const experimentDetail = experimentSummary.extend({
  promptName: z.string(),
  promptChannel: z.string(),
  promptVersion: z.number().nullable(),
  evaluators: z.array(z.string()),
  error: z.string(),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  items: z.array(experimentItemResult),
});
export type ExperimentDetail = z.infer<typeof experimentDetail>;

export const evaluatorTemplate = z.object({
  key: z.string(),
  name: z.string(),
  description: z.string(),
  prompt: z.string(),
  requires: z.array(z.string()),
  defaultModel: z.string(),
});
export type EvaluatorTemplate = z.infer<typeof evaluatorTemplate>;

// ── Providers / evaluators ───────────────────────────────────────────────────────
export const providerConnection = z.object({ provider: z.string(), masked: z.string(), createdAt: z.string() });
export type ProviderConnection = z.infer<typeof providerConnection>;

export const evaluator = z.object({
  name: z.string(),
  provider: z.string(),
  model: z.string(),
  prompt: z.string(),
  online: z.boolean(),
  samplingRate: z.number(),
  filterName: z.string(),
  version: z.number(),
  createdAt: z.string(),
});
export type Evaluator = z.infer<typeof evaluator>;

export const evaluatorVersion = z.object({
  version: z.number(),
  prompt: z.string(),
  provider: z.string(),
  model: z.string(),
  createdAt: z.string(),
});
export type EvaluatorVersion = z.infer<typeof evaluatorVersion>;

// ── Playground ───────────────────────────────────────────────────────────────────
export const chatMessage = z.object({
  role: z.enum(["system", "user", "assistant"]),
  content: z.string(),
});
export type ChatMessage = z.infer<typeof chatMessage>;

export const playgroundResponse = z.object({
  provider: z.string(),
  model: z.string(),
  content: z.string(),
  usage: z.object({ promptTokens: z.number(), completionTokens: z.number(), totalTokens: z.number() }),
  traceId: z.string().optional(),
});
export type PlaygroundResponse = z.infer<typeof playgroundResponse>;

// ── Platform ─────────────────────────────────────────────────────────────────────
export const apiKey = z.object({
  id: z.string(),
  publicKey: z.string(),
  secretHint: z.string(),
  name: z.string(),
  scopes: z.array(z.string()),
  expiresAt: z.string().nullable(),
  rateLimitPerMinute: z.number().nullable(),
  createdAt: z.string(),
  lastUsedAt: z.string().nullable(),
});
export type ApiKey = z.infer<typeof apiKey>;

export const apiKeyCreated = z.object({
  id: z.string(),
  publicKey: z.string(),
  secretKey: z.string(), // shown once at creation
  secretHint: z.string(),
  name: z.string(),
  scopes: z.array(z.string()),
  expiresAt: z.string().nullable(),
  rateLimitPerMinute: z.number().nullable(),
  createdAt: z.string(),
});
export type ApiKeyCreated = z.infer<typeof apiKeyCreated>;

export const project = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  organization: z.string(),
  role: z.string(),
});
export type Project = z.infer<typeof project>;

// Project-level RBAC: an org member annotated with their per-project role override.
// projectRole is null when they inherit their org role.
export const projectMember = z.object({
  userId: z.string(),
  email: z.string(),
  name: z.string(),
  orgRole: z.string(),
  projectRole: z.string().nullable(),
});
export type ProjectMember = z.infer<typeof projectMember>;

export const auditEntry = z.object({
  actor: z.string(),
  action: z.string(),
  target: z.string(),
  metadata: z.unknown(),
  createdAt: z.string(),
});
export type AuditEntry = z.infer<typeof auditEntry>;

export const retentionPolicy = z.object({ days: z.number() });
export type RetentionPolicy = z.infer<typeof retentionPolicy>;

export const webhook = z.object({
  id: z.string(),
  url: z.string(),
  event: z.string(),
  threshold: z.number().nullable(),
  enabled: z.boolean(),
  createdAt: z.string(),
  // Signing secret — returned ONLY in the create response, never when listing.
  secret: z.string().optional(),
  // Delivery tracking (present when listing; absent on the create response).
  lastStatus: z.number().nullable().optional(),
  lastError: z.string().optional(),
  lastAttemptAt: z.string().nullable().optional(),
  failureCount: z.number().optional(),
});
export type Webhook = z.infer<typeof webhook>;

// One entry in a webhook's delivery log (historical; newest first).
export const webhookDelivery = z.object({
  id: z.string(),
  event: z.string(),
  status: z.number().nullable(),
  ok: z.boolean(),
  error: z.string(),
  attempts: z.number(),
  durationMs: z.number().nullable(),
  createdAt: z.string(),
});
export type WebhookDelivery = z.infer<typeof webhookDelivery>;

export const widgetMetric = z.enum(["cost", "tokens", "generations", "latency_p95", "error_rate", "score"]);
export const widgetBreakdown = z.enum(["by_day", "by_model", "by_user", "by_session"]);
export type WidgetMetric = z.infer<typeof widgetMetric>;
export type WidgetBreakdown = z.infer<typeof widgetBreakdown>;

// Optional per-widget filters (all AND-ed). tag matches one of a trace's tags.
export const widgetFilters = z.object({
  environment: z.string().optional(),
  model: z.string().optional(),
  tag: z.string().optional(),
});
export type WidgetFilters = z.infer<typeof widgetFilters>;

export const widgetPoint = z.object({ label: z.string(), value: z.number() });
export type WidgetPoint = z.infer<typeof widgetPoint>;

export const widget = z.object({
  id: z.string(),
  dashboardId: z.string().nullable(),
  title: z.string(),
  metric: widgetMetric,
  breakdown: widgetBreakdown,
  days: z.number(),
  filters: widgetFilters,
  data: z.array(widgetPoint),
});
export type Widget = z.infer<typeof widget>;

// A saved query-engine widget (built in Explore) — carries its full AnalyticsQuery + chart type +
// 12-col grid placement; the dashboard runs the query and renders it via the chart library.
export const queryWidget = z.object({
  id: z.string(),
  dashboardId: z.string().nullable(),
  title: z.string(),
  query: analyticsQuery,
  chartType: chartType,
  gridX: z.number(),
  gridY: z.number(),
  gridW: z.number(),
  gridH: z.number(),
});
export type QueryWidget = z.infer<typeof queryWidget>;

// A named dashboard grouping widgets (null dashboardId = the implicit "Default" dashboard).
export const dashboard = z.object({
  id: z.string(),
  name: z.string(),
  position: z.number(),
  createdAt: z.string(),
});
export type Dashboard = z.infer<typeof dashboard>;

// ── Review queues ────────────────────────────────────────────────────────────────
export const reviewQueue = z.object({
  name: z.string(),
  description: z.string(),
  scoreName: z.string(),
  dataType: z.string(),
  pending: z.number(),
  done: z.number(),
});
export type ReviewQueue = z.infer<typeof reviewQueue>;

export const reviewQueueThroughput = z.object({
  queueName: z.string(),
  pending: z.number(),
  done: z.number(),
  skipped: z.number(),
  total: z.number(),
});
export type ReviewQueueThroughput = z.infer<typeof reviewQueueThroughput>;

export const reviewAnalytics = z.object({
  queues: z.array(reviewQueueThroughput),
  totals: z.object({
    pending: z.number(),
    done: z.number(),
    skipped: z.number(),
    total: z.number(),
  }),
});
export type ReviewAnalytics = z.infer<typeof reviewAnalytics>;

export const reviewItem = z.object({
  id: z.string(),
  traceId: z.string(),
  status: z.string(),
  assigneeId: z.string(),
  trace: z.object({ id: z.string(), name: z.string(), input: z.string(), output: z.string() }),
});
export type ReviewItem = z.infer<typeof reviewItem>;

export const reviewItemsResponse = z.object({
  queue: z.object({ name: z.string(), scoreName: z.string(), dataType: z.string() }),
  items: z.array(reviewItem),
});
export type ReviewItemsResponse = z.infer<typeof reviewItemsResponse>;

/** Helper: a `{ data: T[] }` list envelope schema. */
export const listOf = <T extends z.ZodTypeAny>(item: T) => z.object({ data: z.array(item) });
