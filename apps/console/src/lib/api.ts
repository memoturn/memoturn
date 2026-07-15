/**
 * Thin client for the memoturn API. In dev, requests go through the Vite proxy at
 * `/api` (which forwards the session cookie); the active project is sent as a header.
 *
 * Response types come from @memoturn/contracts (the same zod schemas the API serves in
 * its OpenAPI doc) — single source of truth, no hand-maintained duplicates.
 */
import type {
  AlertChannel,
  AlertRule,
  AnalyticsSink,
  AnnotationResult,
  ApiKey,
  ApiKeyCreated,
  AuditEntry,
  Automation,
  ChatMessage,
  Comment,
  CostBudget,
  DatasetDetail,
  DatasetListItem,
  DatasetVersionDetail,
  DatasetVersionRow,
  EmbeddingProjection,
  Evaluator,
  EvaluatorAnalytics,
  EvaluatorTemplate,
  ExperimentComparison,
  ExperimentDetail,
  ExperimentSummary,
  MaskingPolicy,
  MetricsSummary,
  ModelPriceList,
  PlaygroundResponse,
  Project,
  PromptDetail,
  PromptListItem,
  ProviderConnection,
  ReviewAnalytics,
  ReviewItemsResponse,
  ReviewQueue,
  SavedView,
  ScheduledExport,
  ScheduledExportResult,
  ScoreConfig,
  ScoreCorrected,
  SessionPage,
  SessionSummary,
  TraceDetail,
  TraceFacets,
  TraceHistogram,
  TracePage,
  TraceSummary,
  TraceTags,
  UserPage,
  Webhook,
  Widget,
} from "@memoturn/contracts";

// Re-export the contract types so route components keep importing from "../lib/api".
export type * from "@memoturn/contracts";

const API_BASE = import.meta.env.VITE_API_BASE ?? "/api";
const PROJECT_KEY = "memoturn.project";

export function getActiveProject(): string {
  return (typeof localStorage !== "undefined" && localStorage.getItem(PROJECT_KEY)) || "";
}
export function setActiveProject(id: string) {
  localStorage.setItem(PROJECT_KEY, id);
}

function headers(extra: Record<string, string> = {}): Record<string, string> {
  const h: Record<string, string> = { accept: "application/json", ...extra };
  const project = getActiveProject();
  if (project) h["x-memoturn-project"] = project; // active project for the switcher
  return h;
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, { headers: headers() });
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return res.json() as Promise<T>;
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: headers({ "content-type": "application/json" }),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return res.json() as Promise<T>;
}

async function del<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, { method: "DELETE", headers: headers() });
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return res.json() as Promise<T>;
}

async function patch<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "PATCH",
    headers: headers({ "content-type": "application/json" }),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return res.json() as Promise<T>;
}

async function put<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "PUT",
    headers: headers({ "content-type": "application/json" }),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return res.json() as Promise<T>;
}

function qs(params: Record<string, unknown>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : "";
}

// ── Client-only (request) types ──────────────────────────────────────────────────
export interface TraceFilters {
  userId?: string;
  sessionId?: string;
  environment?: string;
  search?: string;
  tag?: string;
  promptId?: string;
  scoreName?: string;
  level?: string;
  days?: number;
}
export interface PlaygroundRequest {
  provider: string;
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  tools?: { name: string; description?: string; parameters: Record<string, unknown> }[];
  responseFormat?: { type: "json_schema"; schema: Record<string, unknown> };
}

export const api = {
  listTraces: (filters: TraceFilters & { limit?: number } = {}) =>
    get<{ data: TraceSummary[] }>(`/v1/traces${qs(filters as Record<string, unknown>)}`).then((r) => r.data),
  listTracesPage: (filters: TraceFilters & { page?: number; pageSize?: number } = {}) =>
    get<TracePage>(`/v1/traces${qs(filters as Record<string, unknown>)}`),
  traceFacets: (
    opts: {
      days?: number;
      limit?: number;
      environment?: string;
      search?: string;
      userId?: string;
      tag?: string;
      scoreName?: string;
      level?: string;
    } = {},
  ) => get<TraceFacets>(`/v1/traces/facets${qs(opts as Record<string, unknown>)}`),
  traceHistogram: (opts: TraceFilters = {}) =>
    get<TraceHistogram>(`/v1/traces/histogram${qs(opts as Record<string, unknown>)}`),
  getTrace: (id: string) => get<TraceDetail>(`/v1/traces/${encodeURIComponent(id)}`),
  batchTraces: (body: { action: string; traceIds: string[]; datasetName?: string; queueName?: string }) =>
    post<{ action: string; affected: number }>(`/v1/traces/batch`, body),
  replayTrace: (id: string, body: { provider?: string; model?: string } = {}) =>
    post<PlaygroundResponse>(`/v1/traces/${encodeURIComponent(id)}/replay`, body),
  annotateTrace: (
    id: string,
    body: {
      name: string;
      dataType: "NUMERIC" | "CATEGORICAL" | "BOOLEAN";
      value?: number;
      stringValue?: string;
      comment?: string;
    },
  ) => post<AnnotationResult>(`/v1/traces/${encodeURIComponent(id)}/annotate`, body),
  setTraceTags: (id: string, tags: string[]) => post<TraceTags>(`/v1/traces/${encodeURIComponent(id)}/tags`, { tags }),
  getMetrics: (days = 30) => get<MetricsSummary>(`/v1/metrics${qs({ days })}`),
  listPrompts: () => get<{ data: PromptListItem[] }>(`/v1/prompts`).then((r) => r.data),
  getPrompt: (name: string) => get<PromptDetail>(`/v1/prompts/${encodeURIComponent(name)}/detail`),
  listDatasets: () => get<{ data: DatasetListItem[] }>(`/v1/datasets`).then((r) => r.data),
  getDataset: (name: string) => get<DatasetDetail>(`/v1/datasets/${encodeURIComponent(name)}`),
  getDatasetComparison: (name: string, version?: number) =>
    get<ExperimentComparison>(`/v1/datasets/${encodeURIComponent(name)}/comparison${qs({ version })}`),
  createDataset: (name: string, description?: string) =>
    post<{ id: string; name: string }>(`/v1/datasets`, { name, description }),
  addDatasetItems: (name: string, items: { input: unknown; expectedOutput?: unknown }[]) =>
    post<{ added: number; itemIds: string[] }>(`/v1/datasets/${encodeURIComponent(name)}/items`, { items }),
  recordRun: (name: string, runName: string, links: { datasetItemId: string; traceId: string }[], version?: number) =>
    post<{ run: string; linked: number }>(`/v1/datasets/${encodeURIComponent(name)}/runs`, { runName, links, version }),
  listDatasetVersions: (name: string) =>
    get<{ data: DatasetVersionRow[] }>(`/v1/datasets/${encodeURIComponent(name)}/versions`).then((r) => r.data),
  createDatasetVersion: (name: string, body: { label?: string; description?: string }) =>
    post<DatasetVersionRow>(`/v1/datasets/${encodeURIComponent(name)}/versions`, body),
  getDatasetVersion: (name: string, version: number) =>
    get<DatasetVersionDetail>(`/v1/datasets/${encodeURIComponent(name)}/versions/${version}`),
  // Experiments (server-executed dataset runs)
  listExperiments: () => get<{ data: ExperimentSummary[] }>(`/v1/experiments`).then((r) => r.data),
  createExperiment: (body: {
    datasetName: string;
    name: string;
    provider?: string;
    model: string;
    params?: Record<string, unknown>;
    promptName?: string;
    promptChannel?: string;
    evaluators?: string[];
  }) => post<ExperimentSummary>(`/v1/experiments`, body),
  getExperiment: (id: string) => get<ExperimentDetail>(`/v1/experiments/${encodeURIComponent(id)}`),
  getExperimentComparison: (id: string) =>
    get<ExperimentComparison>(`/v1/experiments/${encodeURIComponent(id)}/comparison`),
  cancelExperiment: (id: string) =>
    post<{ id: string; status: string }>(`/v1/experiments/${encodeURIComponent(id)}/cancel`, {}),
  playgroundChat: (body: PlaygroundRequest) => post<PlaygroundResponse>(`/v1/playground/chat`, body),
  listProviders: () => get<{ data: ProviderConnection[] }>(`/v1/providers`).then((r) => r.data),
  addProvider: (provider: string, apiKey: string) => post(`/v1/providers`, { provider, apiKey }),
  getRetention: () => get<{ days: number }>(`/v1/retention`),
  setRetention: (days: number) => post<{ days: number }>(`/v1/retention`, { days }),
  listApiKeys: () => get<{ data: ApiKey[] }>(`/v1/api-keys`).then((r) => r.data),
  createApiKey: (body: {
    name?: string;
    scopes?: string[];
    expiresInDays?: number | null;
    rateLimitPerMinute?: number | null;
  }) => post<ApiKeyCreated>(`/v1/api-keys`, body),
  revokeApiKey: (id: string) => del(`/v1/api-keys/${encodeURIComponent(id)}`),
  getMaskingPolicy: () => get<MaskingPolicy>(`/v1/masking`),
  setMaskingPolicy: (body: {
    enabled?: boolean;
    builtins?: string[];
    customPatterns?: string[];
    redactWith?: string;
  }) => post<MaskingPolicy>(`/v1/masking`, body),
  getAnalyticsSink: () => get<AnalyticsSink>(`/v1/analytics-sink`),
  setAnalyticsSink: (body: { enabled?: boolean; host?: string; apiKey?: string }) =>
    post<AnalyticsSink>(`/v1/analytics-sink`, body),
  getScheduledExport: () => get<ScheduledExport>(`/v1/scheduled-exports`),
  setScheduledExport: (body: { enabled?: boolean; environment?: string; limit?: number }) =>
    post<ScheduledExport>(`/v1/scheduled-exports`, body),
  runScheduledExport: () => post<ScheduledExportResult>(`/v1/scheduled-exports/run`, {}),
  listWebhooks: () => get<{ data: Webhook[] }>(`/v1/webhooks`).then((r) => r.data),
  createWebhook: (body: { url: string; event?: string; threshold?: number | null }) =>
    post<Webhook>(`/v1/webhooks`, body),
  deleteWebhook: (id: string) => del(`/v1/webhooks/${encodeURIComponent(id)}`),
  listAutomations: () => get<{ data: Automation[] }>(`/v1/automations`).then((r) => r.data),
  createAutomation: (body: {
    name: string;
    trigger?: string;
    action?: string;
    target: string;
    threshold?: number | null;
    filter?: string;
  }) => post(`/v1/automations`, body),
  deleteAutomation: (id: string) => del(`/v1/automations/${encodeURIComponent(id)}`),
  listAlerts: () => get<{ data: AlertRule[] }>(`/v1/alerts`).then((r) => r.data),
  createAlert: (body: {
    name: string;
    metric: string;
    window?: number;
    threshold: number;
    comparator?: string;
    channels?: AlertChannel[];
    enabled?: boolean;
  }) => post<AlertRule>(`/v1/alerts`, body),
  updateAlert: (id: string, body: Partial<{ enabled: boolean; threshold: number; channels: AlertChannel[] }>) =>
    patch<AlertRule>(`/v1/alerts/${encodeURIComponent(id)}`, body),
  deleteAlert: (id: string) => del(`/v1/alerts/${encodeURIComponent(id)}`),
  getBudget: () => get<CostBudget>(`/v1/budgets`),
  setBudget: (body: { monthlyUsd: number; thresholds?: number[]; channels?: AlertChannel[] }) =>
    put<CostBudget>(`/v1/budgets`, body),
  deleteBudget: () => del(`/v1/budgets`),
  listScoreConfigs: () => get<{ data: ScoreConfig[] }>(`/v1/score-configs`).then((r) => r.data),
  listModelPrices: () => get<ModelPriceList>(`/v1/model-prices`),
  createModelPrice: (body: { pattern: string; provider?: string; inputPerMTok: number; outputPerMTok: number }) =>
    post(`/v1/model-prices`, body),
  deleteModelPrice: (id: string) => del(`/v1/model-prices/${encodeURIComponent(id)}`),
  createScoreConfig: (body: {
    name: string;
    dataType?: string;
    categories?: string[];
    min?: number | null;
    max?: number | null;
  }) => post(`/v1/score-configs`, body),
  deleteScoreConfig: (id: string) => del(`/v1/score-configs/${encodeURIComponent(id)}`),
  correctScore: (id: string, body: { value?: number; stringValue?: string; comment?: string }) =>
    patch<ScoreCorrected>(`/v1/scores/${encodeURIComponent(id)}`, body),
  deleteScore: (id: string) => del<{ deleted: boolean }>(`/v1/scores/${encodeURIComponent(id)}`),
  listSavedViews: (table = "traces") =>
    get<{ data: SavedView[] }>(`/v1/saved-views${qs({ table })}`).then((r) => r.data),
  createSavedView: (body: { name: string; table?: string; filters: Record<string, unknown> }) =>
    post<SavedView>(`/v1/saved-views`, body),
  deleteSavedView: (id: string) => del(`/v1/saved-views/${encodeURIComponent(id)}`),
  listComments: (objectType: string, objectId: string) =>
    get<{ data: Comment[] }>(`/v1/comments${qs({ objectType, objectId })}`).then((r) => r.data),
  createComment: (objectType: string, objectId: string, content: string) =>
    post(`/v1/comments`, { objectType, objectId, content }),
  deleteComment: (id: string) => del(`/v1/comments/${encodeURIComponent(id)}`),
  listWidgets: () => get<{ data: Widget[] }>(`/v1/widgets`).then((r) => r.data),
  createWidget: (body: { title: string; metric?: string; breakdown?: string; days?: number }) =>
    post(`/v1/widgets`, body),
  deleteWidget: (id: string) => del(`/v1/widgets/${encodeURIComponent(id)}`),
  listEvaluators: () => get<{ data: Evaluator[] }>(`/v1/evaluators`).then((r) => r.data),
  getEvaluatorAnalytics: (days = 30) => get<EvaluatorAnalytics>(`/v1/evaluators/analytics${qs({ days })}`),
  createEvaluator: (body: {
    name: string;
    prompt: string;
    provider: string;
    model: string;
    online?: boolean;
    samplingRate?: number;
    filterName?: string;
  }) => post(`/v1/evaluators`, body),
  listEvaluatorTemplates: () => get<{ data: EvaluatorTemplate[] }>(`/v1/evaluators/templates`).then((r) => r.data),
  getEmbeddingProjection: (opts: { runId?: string; colorBy?: string; limit?: number } = {}) =>
    get<EmbeddingProjection>(`/v1/embeddings/projection${qs(opts as Record<string, unknown>)}`),
  runEmbeddingProjection: () => post<{ run_id: string; points: number }>(`/v1/embeddings/projection/run`, {}),
  instantiateEvaluatorTemplate: (body: {
    key: string;
    name?: string;
    provider?: string;
    model?: string;
    online?: boolean;
    samplingRate?: number;
    filterName?: string;
  }) => post<Evaluator>(`/v1/evaluators/from-template`, body),
  listSessions: () => get<{ data: SessionSummary[] }>(`/v1/sessions`).then((r) => r.data),
  listSessionsPage: (opts: { page?: number; pageSize?: number; days?: number; search?: string } = {}) =>
    get<SessionPage>(`/v1/sessions${qs(opts as Record<string, unknown>)}`),
  listUsersPage: (opts: { page?: number; pageSize?: number; days?: number; search?: string } = {}) =>
    get<UserPage>(`/v1/users${qs(opts as Record<string, unknown>)}`),
  listProjects: () => get<{ data: Project[] }>(`/v1/projects`).then((r) => r.data),
  listAuditLogs: () => get<{ data: AuditEntry[] }>(`/v1/audit-logs`).then((r) => r.data),
  listReviewQueues: () => get<{ data: ReviewQueue[] }>(`/v1/review-queues`).then((r) => r.data),
  getReviewAnalytics: () => get<ReviewAnalytics>(`/v1/review-queues/analytics`),
  createReviewQueue: (body: { name: string; scoreName: string; dataType?: string; description?: string }) =>
    post(`/v1/review-queues`, body),
  addReviewItems: (name: string, traceIds: string[]) =>
    post(`/v1/review-queues/${encodeURIComponent(name)}/items`, { traceIds }),
  listReviewItems: (name: string, opts: { status?: string; assignee?: string } = {}) =>
    get<ReviewItemsResponse>(`/v1/review-queues/${encodeURIComponent(name)}/items${qs(opts)}`),
  submitReviewScore: (name: string, itemId: string, body: { value?: number; stringValue?: string; comment?: string }) =>
    post(`/v1/review-queues/${encodeURIComponent(name)}/items/${encodeURIComponent(itemId)}/score`, body),
  assignReviewItem: (name: string, itemId: string, assigneeId?: string) =>
    post(`/v1/review-queues/${encodeURIComponent(name)}/items/${encodeURIComponent(itemId)}/assign`, { assigneeId }),
  skipReviewItem: (name: string, itemId: string) =>
    post(`/v1/review-queues/${encodeURIComponent(name)}/items/${encodeURIComponent(itemId)}/skip`, {}),
};

/** Stream a playground completion (SSE), invoking onDelta for each text chunk. */
export async function streamPlayground(body: PlaygroundRequest, onDelta: (delta: string) => void): Promise<void> {
  const res = await fetch(`${API_BASE}/v1/playground/stream`, {
    method: "POST",
    headers: headers({ "content-type": "application/json" }),
    body: JSON.stringify(body),
  });
  if (!res.ok || !res.body) throw new Error(`stream failed: ${res.status}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const parts = buf.split("\n\n");
    buf = parts.pop() ?? "";
    for (const part of parts) {
      const line = part.split("\n").find((l) => l.startsWith("data:"));
      if (!line) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") return;
      try {
        const parsed = JSON.parse(data);
        if (parsed.delta) onDelta(parsed.delta);
        if (parsed.error) throw new Error(parsed.error);
      } catch {
        /* ignore non-JSON keepalives */
      }
    }
  }
}

/**
 * Download the traces export for the active project via an object URL (NDJSON or CSV).
 * Honors the same filters as the trace list so the export matches the on-screen view.
 */
export async function downloadTracesExport(
  format: "jsonl" | "csv" = "jsonl",
  filters: TraceFilters & { limit?: number } = {},
): Promise<void> {
  const res = await fetch(`${API_BASE}/v1/exports/traces${qs({ format, ...filters })}`, { headers: headers() });
  if (!res.ok) throw new Error(`export failed: ${res.status}`);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `memoturn-traces.${format}`;
  a.click();
  URL.revokeObjectURL(url);
}

const BLOB_REF_PREFIX = "memoturn-blob://";

/** Fetch a large input/output payload that was offloaded to blob at ingest (returns raw text). */
export async function fetchOffloadedPayload(ref: string): Promise<string> {
  const key = ref.startsWith(BLOB_REF_PREFIX) ? ref.slice(BLOB_REF_PREFIX.length) : ref;
  const res = await fetch(`${API_BASE}/v1/payloads/${key}`, { headers: headers() });
  if (!res.ok) throw new Error(`payload fetch failed: ${res.status}`);
  return res.text();
}
