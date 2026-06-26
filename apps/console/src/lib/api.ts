/**
 * Thin client for the memoturn API. In dev, requests go through the Vite proxy at
 * `/api` (which injects auth); in production this base is configured to the API host.
 */
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

export interface TraceSummary {
  id: string;
  name: string;
  timestamp: string;
  user_id: string;
  session_id: string;
  environment: string;
  observation_count: number;
  total_cost: number;
  total_tokens: number;
  latency_ms: number;
}

export interface ObservationDetail {
  id: string;
  trace_id: string;
  type: string;
  parent_observation_id: string;
  name: string;
  start_time: string;
  end_time: string | null;
  level: string;
  status_message: string;
  model: string;
  provider: string;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  total_cost: number;
  latency_ms: number;
  input: string;
  output: string;
  metadata: string;
}

export interface ScoreRow {
  name: string;
  source: string;
  data_type: string;
  value: number | null;
  string_value: string;
  comment: string;
  timestamp: string;
}

export interface TraceDetail extends TraceSummary {
  release: string;
  version: string;
  tags: string[];
  metadata: string;
  input: string;
  output: string;
  observations: ObservationDetail[];
  scores: ScoreRow[];
}

export interface TraceFilters {
  userId?: string;
  sessionId?: string;
  environment?: string;
  search?: string;
}

export interface DailyMetric {
  date: string;
  generations: number;
  total_tokens: number;
  total_cost: number;
  p50_latency_ms: number;
  p95_latency_ms: number;
}

export interface ModelMetric {
  model: string;
  generations: number;
  total_tokens: number;
  total_cost: number;
}

export interface MetricsSummary {
  total_traces: number;
  total_generations: number;
  total_tokens: number;
  total_cost: number;
  byDay: DailyMetric[];
  byModel: ModelMetric[];
}

function qs(params: Record<string, unknown>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : "";
}

export interface PromptChannel {
  label: string;
  version: number;
}

export interface PromptListItem {
  name: string;
  folder: string;
  versions: number;
  latestVersion: number;
  channels: PromptChannel[];
  updatedAt: string;
}

export interface PromptVersionDetail {
  version: number;
  type: "TEXT" | "CHAT";
  content: unknown;
  config: unknown;
  createdAt: string;
}

export interface PromptDetail extends PromptListItem {
  allVersions: PromptVersionDetail[];
}

export const api = {
  listTraces: (filters: TraceFilters & { limit?: number } = {}) =>
    get<{ data: TraceSummary[] }>(`/v1/traces${qs(filters as Record<string, unknown>)}`).then((r) => r.data),
  getTrace: (id: string) => get<TraceDetail>(`/v1/traces/${encodeURIComponent(id)}`),
  getMetrics: (days = 30) => get<MetricsSummary>(`/v1/metrics${qs({ days })}`),
  listPrompts: () => get<{ data: PromptListItem[] }>(`/v1/prompts`).then((r) => r.data),
  getPrompt: (name: string) => get<PromptDetail>(`/v1/prompts/${encodeURIComponent(name)}/detail`),
  listDatasets: () => get<{ data: DatasetListItem[] }>(`/v1/datasets`).then((r) => r.data),
  getDataset: (name: string) => get<DatasetDetail>(`/v1/datasets/${encodeURIComponent(name)}`),
  playgroundChat: (body: PlaygroundRequest) => post<PlaygroundResponse>(`/v1/playground/chat`, body),
  listProviders: () => get<{ data: ProviderConnection[] }>(`/v1/providers`).then((r) => r.data),
  addProvider: (provider: string, apiKey: string) => post(`/v1/providers`, { provider, apiKey }),
  getRetention: () => get<{ days: number }>(`/v1/retention`),
  setRetention: (days: number) => post<{ days: number }>(`/v1/retention`, { days }),
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
  listReviewItems: (name: string) => get<ReviewItemsResponse>(`/v1/review-queues/${encodeURIComponent(name)}/items`),
  submitReviewScore: (name: string, itemId: string, body: { value?: number; stringValue?: string; comment?: string }) =>
    post(`/v1/review-queues/${encodeURIComponent(name)}/items/${encodeURIComponent(itemId)}/score`, body),
};

export interface ReviewQueue {
  name: string;
  description: string;
  scoreName: string;
  dataType: string;
  pending: number;
  done: number;
}
export interface ReviewItem {
  id: string;
  traceId: string;
  status: string;
  trace: { id: string; name: string; input: string; output: string };
}
export interface ReviewItemsResponse {
  queue: { name: string; scoreName: string; dataType: string };
  items: ReviewItem[];
}

export interface SessionSummary {
  session_id: string;
  trace_count: number;
  first_seen: string;
  last_seen: string;
  total_cost: number;
}

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

export interface Project {
  id: string;
  name: string;
  slug: string;
  workspace: string;
  role: string;
}
export interface AuditEntry {
  actor: string;
  action: string;
  target: string;
  metadata: unknown;
  createdAt: string;
}

export type ChatRole = "system" | "user" | "assistant";
export interface ChatMessage {
  role: ChatRole;
  content: string;
}
export interface PlaygroundRequest {
  provider: string;
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
}
export interface PlaygroundResponse {
  provider: string;
  model: string;
  content: string;
  usage: { promptTokens: number; completionTokens: number; totalTokens: number };
  traceId?: string;
}
export interface ProviderConnection {
  provider: string;
  masked: string;
  createdAt: string;
}
export interface Evaluator {
  name: string;
  provider: string;
  model: string;
  prompt: string;
  online: boolean;
  samplingRate: number;
  filterName: string;
  createdAt: string;
}

export interface DatasetListItem {
  name: string;
  description: string;
  items: number;
  runs: number;
  createdAt: string;
}

export interface DatasetItemRow {
  id: string;
  input: unknown;
  expectedOutput: unknown;
  metadata: unknown;
}

export interface DatasetRunRow {
  name: string;
  itemCount: number;
  createdAt: string;
}

export interface DatasetDetail {
  name: string;
  description: string;
  items: DatasetItemRow[];
  runs: DatasetRunRow[];
}
