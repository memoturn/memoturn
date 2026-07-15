import { getDlqQueue, getIngestQueue } from "@memoturn/db/queue";

/**
 * Ingest-pipeline health + DLQ replay, shared by the console API and the `dlq` CLI.
 *
 * Dead-lettered ingest batches (retries exhausted) keep their blob key — the raw batch is
 * the replayable source of truth — so a batch can be re-processed once the underlying cause
 * (e.g. a Doris outage) is resolved. In-process worker counters (insert latency, error
 * totals) live only in the worker, so `getIngestHealth` fetches the worker's /metrics over
 * HTTP; DLQ batch details are read directly from Redis (the API already has queue access).
 */

const DLQ_STATES = ["waiting", "delayed", "failed", "completed", "active"] as const;

export interface DlqBatch {
  batchId: string;
  projectId: string;
  failedAt: string;
  error: string;
}

/** Recent dead-lettered batches + total depth, read straight from the DLQ. */
export async function inspectDlq(limit = 50): Promise<{ depth: number; batches: DlqBatch[] }> {
  const dlq = getDlqQueue();
  const counts = await dlq.getJobCounts(...DLQ_STATES);
  const depth = DLQ_STATES.reduce((n, s) => n + (counts[s] ?? 0), 0);
  const jobs = await dlq.getJobs([...DLQ_STATES]);
  const batches = jobs.slice(0, limit).map((j) => ({
    batchId: j.data.batchId,
    projectId: j.data.projectId,
    failedAt: j.data.failedAt ?? "",
    error: j.data.error ?? "",
  }));
  return { depth, batches };
}

/** Re-enqueue dead-lettered batches onto the ingest queue and clear them from the DLQ. */
export async function replayDlq(limit = Number.POSITIVE_INFINITY): Promise<{ replayed: number; failed: number }> {
  const dlq = getDlqQueue();
  const ingest = getIngestQueue();
  const jobs = await dlq.getJobs([...DLQ_STATES]);
  let replayed = 0;
  let failed = 0;
  for (const job of jobs) {
    if (replayed >= limit) break;
    const { projectId, batchId, blobKey } = job.data;
    try {
      await ingest.add("ingest", { projectId, batchId, blobKey });
      await job.remove();
      replayed++;
    } catch {
      failed++;
    }
  }
  return { replayed, failed };
}

interface WorkerMetrics {
  concurrency?: number;
  dlqDepth?: number;
  queues?: unknown;
  metrics?: { counters?: Record<string, number>; telemetry_insert?: { count: number; avgMs: number } };
}

/**
 * Ingest health for the ops console: worker counters (best-effort HTTP fetch) merged with
 * the DLQ depth + recent failed batches (from Redis). Never throws — a down worker just
 * yields `workerReachable: false`.
 */
export async function getIngestHealth(): Promise<{
  workerReachable: boolean;
  dlqDepth: number;
  insertLatencyMs: number | null;
  counters: Record<string, number>;
  recentFailures: DlqBatch[];
}> {
  const { depth, batches } = await inspectDlq(50);

  let worker: WorkerMetrics | null = null;
  const url = process.env.WORKER_METRICS_URL ?? "http://127.0.0.1:3002/metrics";
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(3_000) });
    if (res.ok) worker = (await res.json()) as WorkerMetrics;
  } catch {
    // worker unreachable — report DLQ-only health
  }

  return {
    workerReachable: worker !== null,
    dlqDepth: worker?.dlqDepth ?? depth,
    insertLatencyMs: worker?.metrics?.telemetry_insert?.avgMs ?? null,
    counters: worker?.metrics?.counters ?? {},
    recentFailures: batches,
  };
}
