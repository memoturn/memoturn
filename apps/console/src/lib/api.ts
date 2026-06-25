/**
 * Thin client for the memoturn API. In dev, requests go through the Vite proxy at
 * `/api` (which injects auth); in production this base is configured to the API host.
 */
const API_BASE = import.meta.env.VITE_API_BASE ?? "/api";

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, { headers: { accept: "application/json" } });
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

export interface TraceDetail extends TraceSummary {
  release: string;
  version: string;
  tags: string[];
  metadata: string;
  input: string;
  output: string;
  observations: ObservationDetail[];
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
};

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
