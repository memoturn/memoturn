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
  prompt_tokens: z.number(),
  completion_tokens: z.number(),
  total_tokens: z.number(),
  total_cost: z.number(),
  latency_ms: z.number(),
  input: z.string(),
  output: z.string(),
  metadata: z.string(),
});
export type ObservationDetail = z.infer<typeof observationDetail>;

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

// ── Metrics ────────────────────────────────────────────────────────────────────
export const dailyMetric = z.object({
  date: z.string(),
  generations: z.number(),
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
  total_tokens: z.number(),
  total_cost: z.number(),
  byDay: z.array(dailyMetric),
  byModel: z.array(modelMetric),
});
export type MetricsSummary = z.infer<typeof metricsSummary>;

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

export const datasetRunRow = z.object({ name: z.string(), itemCount: z.number(), createdAt: z.string() });
export type DatasetRunRow = z.infer<typeof datasetRunRow>;

export const datasetDetail = z.object({
  name: z.string(),
  description: z.string(),
  items: z.array(datasetItemRow),
  runs: z.array(datasetRunRow),
});
export type DatasetDetail = z.infer<typeof datasetDetail>;

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
  createdAt: z.string(),
});
export type Evaluator = z.infer<typeof evaluator>;

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
});
export type Webhook = z.infer<typeof webhook>;

export const widgetMetric = z.enum(["cost", "tokens", "generations", "latency_p95"]);
export const widgetBreakdown = z.enum(["by_day", "by_model"]);
export type WidgetMetric = z.infer<typeof widgetMetric>;
export type WidgetBreakdown = z.infer<typeof widgetBreakdown>;

export const widgetPoint = z.object({ label: z.string(), value: z.number() });
export type WidgetPoint = z.infer<typeof widgetPoint>;

export const widget = z.object({
  id: z.string(),
  title: z.string(),
  metric: widgetMetric,
  breakdown: widgetBreakdown,
  days: z.number(),
  data: z.array(widgetPoint),
});
export type Widget = z.infer<typeof widget>;

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
