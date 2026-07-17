import { basicAuth, DEFAULT_REQUEST_TIMEOUT_MS, truncate } from "./internal.js";

export interface Creds {
  baseUrl?: string;
  publicKey?: string;
  secretKey?: string;
  /** Per-request timeout (ms). Default 10000. */
  requestTimeout?: number;
}

function resolve(creds: Creds) {
  const baseUrl = (creds.baseUrl ?? process.env.MEMOTURN_BASE_URL ?? "http://localhost:3001").replace(/\/$/, "");
  const publicKey = creds.publicKey ?? process.env.MEMOTURN_PUBLIC_KEY ?? "";
  const secretKey = creds.secretKey ?? process.env.MEMOTURN_SECRET_KEY ?? "";
  return { baseUrl, auth: basicAuth(publicKey, secretKey) };
}

async function req<T>(creds: Creds, method: string, path: string, body?: unknown): Promise<T> {
  const { baseUrl, auth } = resolve(creds);
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { authorization: auth, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(creds.requestTimeout ?? DEFAULT_REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`${method} ${path} failed: ${res.status} ${truncate(await res.text())}`);
  return res.json() as Promise<T>;
}

export interface DatasetItem {
  id: string;
  input: unknown;
  expectedOutput: unknown;
  metadata: unknown;
}

export interface DatasetHandle {
  name: string;
  description: string;
  items: DatasetItem[];
  /** Record an experiment run linking items to the traces produced for them. */
  recordRun(
    runName: string,
    links: { datasetItemId: string; traceId: string }[],
  ): Promise<{ run: string; linked: number }>;
}

export async function createDataset(creds: Creds, name: string, description?: string): Promise<void> {
  await req(creds, "POST", "/v1/datasets", { name, description });
}

export async function addDatasetItems(
  creds: Creds,
  name: string,
  items: { input: unknown; expectedOutput?: unknown; metadata?: Record<string, unknown> }[],
): Promise<{ added: number; itemIds: string[] }> {
  return req(creds, "POST", `/v1/datasets/${encodeURIComponent(name)}/items`, { items });
}

/** Fetch a dataset and its items, with a `.recordRun()` helper for experiments. */
export async function getDataset(creds: Creds, name: string): Promise<DatasetHandle> {
  const data = await req<{ name: string; description: string; items: DatasetItem[] }>(
    creds,
    "GET",
    `/v1/datasets/${encodeURIComponent(name)}`,
  );
  return {
    ...data,
    recordRun: (runName, links) =>
      req(creds, "POST", `/v1/datasets/${encodeURIComponent(name)}/runs`, { runName, links }),
  };
}
