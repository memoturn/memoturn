/**
 * Thin client for the memoturn API. In dev, requests go through the Vite proxy at
 * `/api` (which forwards the session cookie); the active project is sent as a header.
 *
 * Response types come from @memoturn/contracts (the same zod schemas the API serves in
 * its OpenAPI doc) — single source of truth, no hand-maintained duplicates.
 */
import type {
  AuditEntry,
  Automation,
  ChatMessage,
  Comment,
  DatasetDetail,
  DatasetListItem,
  Evaluator,
  ExperimentComparison,
  MetricsSummary,
  ModelPriceList,
  PlaygroundResponse,
  Project,
  PromptDetail,
  PromptListItem,
  ProviderConnection,
  ReviewItemsResponse,
  ReviewQueue,
  SavedView,
  ScheduledExport,
  ScheduledExportResult,
  ScoreConfig,
  SessionSummary,
  TraceDetail,
  TraceSummary,
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
  getTrace: (id: string) => get<TraceDetail>(`/v1/traces/${encodeURIComponent(id)}`),
  batchTraces: (body: { action: string; traceIds: string[]; datasetName?: string; queueName?: string }) =>
    post<{ action: string; affected: number }>(`/v1/traces/batch`, body),
  getMetrics: (days = 30) => get<MetricsSummary>(`/v1/metrics${qs({ days })}`),
  listPrompts: () => get<{ data: PromptListItem[] }>(`/v1/prompts`).then((r) => r.data),
  getPrompt: (name: string) => get<PromptDetail>(`/v1/prompts/${encodeURIComponent(name)}/detail`),
  listDatasets: () => get<{ data: DatasetListItem[] }>(`/v1/datasets`).then((r) => r.data),
  getDataset: (name: string) => get<DatasetDetail>(`/v1/datasets/${encodeURIComponent(name)}`),
  getDatasetComparison: (name: string) =>
    get<ExperimentComparison>(`/v1/datasets/${encodeURIComponent(name)}/comparison`),
  playgroundChat: (body: PlaygroundRequest) => post<PlaygroundResponse>(`/v1/playground/chat`, body),
  listProviders: () => get<{ data: ProviderConnection[] }>(`/v1/providers`).then((r) => r.data),
  addProvider: (provider: string, apiKey: string) => post(`/v1/providers`, { provider, apiKey }),
  getRetention: () => get<{ days: number }>(`/v1/retention`),
  setRetention: (days: number) => post<{ days: number }>(`/v1/retention`, { days }),
  getScheduledExport: () => get<ScheduledExport>(`/v1/scheduled-exports`),
  setScheduledExport: (body: { enabled?: boolean; environment?: string; limit?: number }) =>
    post<ScheduledExport>(`/v1/scheduled-exports`, body),
  runScheduledExport: () => post<ScheduledExportResult>(`/v1/scheduled-exports/run`, {}),
  listWebhooks: () => get<{ data: Webhook[] }>(`/v1/webhooks`).then((r) => r.data),
  createWebhook: (body: { url: string; event?: string; threshold?: number | null }) => post(`/v1/webhooks`, body),
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
  createEvaluator: (body: {
    name: string;
    prompt: string;
    provider: string;
    model: string;
    online?: boolean;
    samplingRate?: number;
    filterName?: string;
  }) => post(`/v1/evaluators`, body),
  listSessions: () => get<{ data: SessionSummary[] }>(`/v1/sessions`).then((r) => r.data),
  listProjects: () => get<{ data: Project[] }>(`/v1/projects`).then((r) => r.data),
  listAuditLogs: () => get<{ data: AuditEntry[] }>(`/v1/audit-logs`).then((r) => r.data),
  listReviewQueues: () => get<{ data: ReviewQueue[] }>(`/v1/review-queues`).then((r) => r.data),
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

/** Download the traces export (NDJSON) for the active project via an object URL. */
export async function downloadTracesExport(): Promise<void> {
  const res = await fetch(`${API_BASE}/v1/exports/traces`, { headers: headers() });
  if (!res.ok) throw new Error(`export failed: ${res.status}`);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "memoturn-traces.jsonl";
  a.click();
  URL.revokeObjectURL(url);
}
