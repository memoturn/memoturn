import { createServer } from "node:http";
import { QUEUE_NAMES, QUEUE_PREFIX } from "@memoturn/core";
import { connectionOptions, type ExperimentJob, getDlqQueue, getIngestQueue, type IngestJob } from "@memoturn/db/queue";
import {
  applyAllRetention,
  evaluateAllAlerts,
  evaluateBudgets,
  runAllEmbeddingProjections,
  runAllScheduledExports,
  validateRuntimeEnv,
  withLock,
} from "@memoturn/server";
import { Queue, Worker } from "bullmq";
import { shouldDeadLetter } from "./dlq.js";
import { logJson, snapshot } from "./metrics.js";
import { processExperiment } from "./processors/experiment.js";
import { processIngest } from "./processors/ingest.js";

/**
 * memoturn worker — consumes BullMQ queues and writes telemetry to the Doris store.
 * Runs the ingest processor (+ online evaluations) and daily maintenance crons
 * (retention sweep + scheduled blob exports).
 */
validateRuntimeEnv("worker");
const concurrency = Number(process.env.WORKER_CONCURRENCY ?? 10);

// Dead-letter queue: jobs that exhaust their retries land here (with the blob key) instead
// of being discarded, so lost batches can be inspected and replayed.
const dlq = getDlqQueue();

const ingestWorker = new Worker<IngestJob>(QUEUE_NAMES.ingest, processIngest, {
  connection: connectionOptions(),
  prefix: QUEUE_PREFIX,
  concurrency,
});

ingestWorker.on("ready", () => console.log(`[worker] ingest ready (concurrency=${concurrency})`));
ingestWorker.on("failed", async (job, err) => {
  logJson("error", "ingest job failed", { jobId: job?.id, attemptsMade: job?.attemptsMade, error: err.message });
  // DLQ on a terminal failure: retries exhausted OR a stalled job (which BullMQ fails with
  // attemptsMade possibly still below `attempts`). See shouldDeadLetter.
  const maxAttempts = job?.opts.attempts ?? 1;
  if (job && shouldDeadLetter(err.message, job.attemptsMade, maxAttempts)) {
    try {
      await dlq.add(
        "dead",
        { ...job.data, error: err.message, failedAt: new Date().toISOString() },
        { removeOnComplete: false, removeOnFail: false },
      );
      logJson("warn", "ingest job sent to DLQ", { jobId: job.id, blobKey: job.data.blobKey });
    } catch (e) {
      logJson("error", "failed to enqueue DLQ job", {
        jobId: job.id,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
});

// ── Experiments (server-executed dataset runs) ───────────────────────────────────
// A dedicated worker at low concurrency: each job fans out over dataset items, so it
// must not share the ingest worker's slots (a long experiment would starve ingest).
const experimentConcurrency = Number(process.env.EXPERIMENT_CONCURRENCY ?? 2);
const experimentWorker = new Worker<ExperimentJob>(QUEUE_NAMES.experiment, processExperiment, {
  connection: connectionOptions(),
  prefix: QUEUE_PREFIX,
  concurrency: experimentConcurrency,
});
experimentWorker.on("ready", () => console.log(`[worker] experiment ready (concurrency=${experimentConcurrency})`));
experimentWorker.on("failed", (job, err) =>
  logJson("error", "experiment job failed", { jobId: job?.id, attemptsMade: job?.attemptsMade, error: err.message }),
);

// ── Daily maintenance crons (retention + scheduled exports) ──────────────────────
const maintenanceQueue = new Queue(QUEUE_NAMES.export, {
  connection: connectionOptions(),
  prefix: QUEUE_PREFIX,
});
// Concurrency > 1 so the per-minute alert-eval tick isn't blocked behind a long-running daily
// sweep (retention/export/embeddings) on the same queue. Each job type is withLock-guarded, so
// running different types concurrently is safe.
const maintenanceConcurrency = Number(process.env.MAINTENANCE_CONCURRENCY ?? 4);
const maintenanceWorker = new Worker(
  QUEUE_NAMES.export,
  async (job) => {
    if (job.name === "retention") {
      // Lock so two workers / a manual trigger can't sweep concurrently (racing deletes).
      // fail-closed: retention DELETES data, so if Redis is down, skip rather than let every
      // replica run an uncoordinated concurrent sweep.
      const ran = await withLock(
        "retention",
        30 * 60,
        async () => {
          const results = await applyAllRetention();
          const total = results.reduce((n, r) => n + r.deletedTraces, 0);
          const blobs = results.reduce((n, r) => n + r.deletedBlobObjects, 0);
          console.log(`[retention] swept ${results.length} project(s), deleted ${total} traces, ${blobs} blob objects`);
        },
        { failClosed: true },
      );
      if (ran === null) console.log("[retention] skipped — lock held or (Redis down) fail-closed");
    } else if (job.name === "export") {
      const ran = await withLock("scheduled-export", 30 * 60, async () => {
        const results = await runAllScheduledExports();
        const total = results.reduce((n, r) => n + r.count, 0);
        console.log(`[export] ran ${results.length} project export(s), wrote ${total} traces`);
      });
      if (ran === null) console.log("[export] skipped — another run holds the lock");
    } else if (job.name === "embeddings") {
      // Lock so overlapping runs don't race (UMAP-free PCA is deterministic, but two
      // concurrent runs would still write competing run_ids).
      const ran = await withLock("embedding-projection", 30 * 60, async () => {
        const results = await runAllEmbeddingProjections();
        const total = results.reduce((n, r) => n + r.points, 0);
        console.log(`[embeddings] projected ${results.length} project(s), ${total} points`);
      });
      if (ran === null) console.log("[embeddings] skipped — another run holds the lock");
    } else if (job.name === "alert-eval") {
      // Short TTL: this runs every minute, so a stuck holder shouldn't block the next tick long.
      const ran = await withLock("alert-eval", 120, async () => {
        // dlq_depth alert rules read the global DLQ queue depth (jobs carry projectId, but
        // the queue count is process-global) — inject it so the engine needn't touch BullMQ.
        const dlqCounts = await dlq.getJobCounts();
        const dlqDepth = (dlqCounts.waiting ?? 0) + (dlqCounts.completed ?? 0) + (dlqCounts.failed ?? 0);
        const [alerts, budgets] = await Promise.all([evaluateAllAlerts({ dlqDepth }), evaluateBudgets()]);
        if (alerts.fired > 0 || budgets.notified > 0)
          console.log(`[alerts] ${alerts.fired} fired, ${budgets.notified} budget step(s) notified`);
      });
      if (ran === null) console.log("[alerts] skipped — another run holds the lock");
    }
  },
  { connection: connectionOptions(), prefix: QUEUE_PREFIX, concurrency: maintenanceConcurrency },
);
maintenanceWorker.on("failed", (job, err) => console.error(`[maintenance] job ${job?.id} failed:`, err.message));

// Schedule maintenance daily (idempotent — same jobId/pattern just updates the schedule).
await maintenanceQueue.add(
  "retention",
  {},
  {
    repeat: { pattern: "0 3 * * *" },
    jobId: "retention-daily",
    removeOnComplete: true,
  },
);
await maintenanceQueue.add(
  "export",
  {},
  {
    repeat: { pattern: "0 4 * * *" },
    jobId: "export-daily",
    removeOnComplete: true,
  },
);
await maintenanceQueue.add(
  "embeddings",
  {},
  {
    repeat: { pattern: "0 5 * * *" },
    jobId: "embeddings-daily",
    removeOnComplete: true,
  },
);
// Alert rules + cost budgets: evaluated every minute (stateful firing/resolved, dedup).
await maintenanceQueue.add(
  "alert-eval",
  {},
  {
    repeat: { pattern: "* * * * *" },
    jobId: "alert-eval-cron",
    removeOnComplete: true,
  },
);

// ── Health + metrics HTTP endpoint (liveness probes + queue depth) ───────────────
const startedAt = Date.now();
const healthPort = Number(process.env.WORKER_PORT ?? 3002);
// Bind to loopback by default — /metrics is unauthenticated and leaks queue depths and
// per-project evaluator names, so it must not be reachable off-host. The in-container Docker
// healthcheck still works over 127.0.0.1; set WORKER_HOST=0.0.0.0 for cross-host probes.
const healthHost = process.env.WORKER_HOST ?? "127.0.0.1";
const ingestQueue = getIngestQueue();

const healthServer = createServer(async (req, res) => {
  const path = (req.url ?? "/").split("?")[0];
  res.setHeader("content-type", "application/json");
  if (path === "/health") {
    res.end(
      JSON.stringify({
        status: "ok",
        service: "memoturn-worker",
        uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
      }),
    );
    return;
  }
  if (path === "/metrics") {
    const [ingest, maintenance, dlqCounts] = await Promise.all([
      ingestQueue.getJobCounts(),
      maintenanceQueue.getJobCounts(),
      dlq.getJobCounts(),
    ]);
    const dlqDepth = (dlqCounts.waiting ?? 0) + (dlqCounts.completed ?? 0) + (dlqCounts.failed ?? 0);
    res.end(
      JSON.stringify({
        concurrency,
        queues: { ingest, maintenance, dlq: dlqCounts },
        dlqDepth,
        metrics: snapshot(),
      }),
    );
    return;
  }
  res.statusCode = 404;
  res.end(JSON.stringify({ error: "not found" }));
});
healthServer.listen(healthPort, healthHost, () =>
  console.log(`[worker] health + metrics on http://${healthHost}:${healthPort} (/health, /metrics)`),
);

async function shutdown(signal: string) {
  console.log(`[worker] ${signal} received, draining…`);
  healthServer.close();
  await Promise.all([ingestWorker.close(), experimentWorker.close(), maintenanceWorker.close(), dlq.close()]);
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

console.log("[worker] memoturn worker started (ingest + retention + export crons + health endpoint)");
