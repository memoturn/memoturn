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
  dataType: z.enum(["NUMERIC", "CATEGORICAL", "BOOLEAN"]),
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
});
export type TraceFacets = z.infer<typeof traceFacets>;

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

export const maskingPolicy = z.object({
  enabled: z.boolean(),
  builtins: z.array(z.string()),
  customPatterns: z.array(z.string()),
  redactWith: z.string(),
  available: z.array(z.string()),
});
export type MaskingPolicy = z.infer<typeof maskingPolicy>;

// Runtime guardrails: the per-project policy config, and a single check's verdict.
export const guardrailPolicy = z.object({
  enabled: z.boolean(),
  pii: z.boolean(),
  piiAction: z.enum(["redact", "block"]),
  builtins: z.array(z.string()),
  customPatterns: z.array(z.string()),
  redactWith: z.string(),
  injection: z.boolean(),
  blockedTerms: z.array(z.string()),
  available: z.array(z.string()),
});
export type GuardrailPolicy = z.infer<typeof guardrailPolicy>;

export const guardrailVerdict = z.object({
  verdict: z.enum(["allow", "redact", "block"]),
  findings: z.array(
    z.object({
      category: z.enum(["pii", "injection", "blocked_term"]),
      type: z.string(),
      count: z.number(),
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
export const promptChannel = z.object({ label: z.string(), version: z.number() });
export type PromptChannel = z.infer<typeof promptChannel>;

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
