import { getDlqQueue, getIngestQueue } from "@memoturn/db/queue";
import { withLock } from "./lock.js";

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
// Replay must not touch a job another replayer is holding (`active`), and never scans the
// whole queue into memory — `getJobs` is paged to the requested limit.
const REPLAYABLE_STATES = ["waiting", "delayed", "failed", "completed"] as const;
const REPLAY_PAGE = 500;
const REPLAY_LOCK_TTL_S = 300;
const DLQ_PAGE = 500;
/** Upper bound on how deep a per-project scan goes (a pathological queue still answers). */
const DLQ_SCAN_CAP = 50_000;

export class DlqReplayInProgressError extends Error {
  constructor() {
    super("a DLQ replay is already in progress");
    this.name = "DlqReplayInProgressError";
  }
}

export interface DlqBatch {
  batchId: string;
  projectId: string;
  failedAt: string;
  error: string;
}

/** Recent dead-lettered batches + total depth, read straight from the DLQ. */
/**
 * Recent dead-lettered batches + total depth. With `projectId` (the API path — every project
 * admin sees ONLY their own tenant's failures, never another project's ids or error strings),
 * the depth is that project's count and the listing is filtered; without it (the operator
 * CLI) the whole queue is visible.
 */
export async function inspectDlq(limit = 50, projectId?: string): Promise<{ depth: number; batches: DlqBatch[] }> {
  const dlq = getDlqQueue();
  if (projectId) {
    // Scan in pages and keep the first `limit` matches; a tenant's share of a deep DLQ is
    // normally small, and this never loads the whole queue at once.
    const batches: DlqBatch[] = [];
    let depth = 0;
    for (let start = 0; ; start += DLQ_PAGE) {
      const page = await dlq.getJobs([...DLQ_STATES], start, start + DLQ_PAGE - 1);
      for (const j of page) {
        if (j.data.projectId !== projectId) continue;
        depth++;
        if (batches.length < limit) {
          batches.push({
            batchId: j.data.batchId,
            projectId: j.data.projectId,
            failedAt: j.data.failedAt ?? "",
            error: j.data.error ?? "",
          });
        }
      }
      if (page.length < DLQ_PAGE || start + DLQ_PAGE >= DLQ_SCAN_CAP) break;
    }
    return { depth, batches };
  }
  const counts = await dlq.getJobCounts(...DLQ_STATES);
  const depth = DLQ_STATES.reduce((n, s) => n + (counts[s] ?? 0), 0);
  // Page the fetch to the limit — a deep DLQ must not be loaded wholesale into API memory.
  const jobs = await dlq.getJobs([...DLQ_STATES], 0, Math.max(0, limit - 1));
  const batches = jobs.slice(0, limit).map((j) => ({
    batchId: j.data.batchId,
    projectId: j.data.projectId,
    failedAt: j.data.failedAt ?? "",
    error: j.data.error ?? "",
  }));
  return { depth, batches };
}

/**
 * Re-enqueue dead-lettered batches onto the ingest queue and clear them from the DLQ.
 * Serialized by a Redis lock (fail-closed): the console button and `bun run dlq --replay`
 * racing each other would otherwise double-enqueue the same batches. Throws
 * DlqReplayInProgressError when another replay holds the lock.
 */
export async function replayDlq(
  limit = Number.POSITIVE_INFINITY,
  projectId?: string,
): Promise<{ replayed: number; failed: number }> {
  const result = await withLock(
    "dlq-replay",
    REPLAY_LOCK_TTL_S,
    async () => {
      const dlq = getDlqQueue();
      const ingest = getIngestQueue();
      let replayed = 0;
      let failed = 0;
      // Jobs that stay in the queue (failed re-adds, other tenants' jobs when scoped) shift
      // the page window; removed jobs don't, so the offset is exactly the count of kept ones.
      let kept = 0;
      while (replayed < limit) {
        const want = Math.min(REPLAY_PAGE, limit - replayed);
        const jobs = await dlq.getJobs([...REPLAYABLE_STATES], kept, kept + want - 1);
        if (jobs.length === 0) break;
        for (const job of jobs) {
          if (replayed >= limit) break;
          if (projectId && job.data.projectId !== projectId) {
            kept++;
            continue;
          }
          const { batchId, blobKey, requestId } = job.data;
          try {
            await ingest.add("ingest", { projectId: job.data.projectId, batchId, blobKey, requestId });
            await job.remove();
            replayed++;
          } catch {
            failed++;
            kept++;
          }
        }
        if (jobs.length < want) break;
      }
      return { replayed, failed };
    },
    { failClosed: true },
  );
  if (result === null) throw new DlqReplayInProgressError();
  return result;
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
export async function getIngestHealth(projectId?: string): Promise<{
  workerReachable: boolean;
  dlqDepth: number;
  insertLatencyMs: number | null;
  counters: Record<string, number>;
  recentFailures: DlqBatch[];
}> {
  const { depth, batches } = await inspectDlq(50, projectId);

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
    dlqDepth: projectId ? depth : (worker?.dlqDepth ?? depth),
    insertLatencyMs: worker?.metrics?.telemetry_insert?.avgMs ?? null,
    counters: worker?.metrics?.counters ?? {},
    recentFailures: batches,
  };
}
