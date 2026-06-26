import { QUEUE_NAMES, QUEUE_PREFIX } from "@memoturn/core";
import { connectionOptions, type IngestJob } from "@memoturn/db/queue";
import { applyAllRetention, runAllScheduledExports } from "@memoturn/server";
import { Queue, Worker } from "bullmq";
import { processIngest } from "./processors/ingest.js";

/**
 * memoturn worker — consumes BullMQ queues and writes telemetry to ClickHouse.
 * Runs the ingest processor (+ online evaluations) and daily maintenance crons
 * (retention sweep + scheduled blob exports).
 */
const concurrency = Number(process.env.WORKER_CONCURRENCY ?? 10);

const ingestWorker = new Worker<IngestJob>(QUEUE_NAMES.ingest, processIngest, {
  connection: connectionOptions(),
  prefix: QUEUE_PREFIX,
  concurrency,
});

ingestWorker.on("ready", () => console.log(`[worker] ingest ready (concurrency=${concurrency})`));
ingestWorker.on("failed", (job, err) => console.error(`[worker] job ${job?.id} failed:`, err.message));

// ── Daily maintenance crons (retention + scheduled exports) ──────────────────────
const maintenanceQueue = new Queue(QUEUE_NAMES.export, {
  connection: connectionOptions(),
  prefix: QUEUE_PREFIX,
});
const maintenanceWorker = new Worker(
  QUEUE_NAMES.export,
  async (job) => {
    if (job.name === "retention") {
      const results = await applyAllRetention();
      const total = results.reduce((n, r) => n + r.deletedTraces, 0);
      console.log(`[retention] swept ${results.length} project(s), deleted ${total} traces`);
    } else if (job.name === "export") {
      const results = await runAllScheduledExports();
      const total = results.reduce((n, r) => n + r.count, 0);
      console.log(`[export] ran ${results.length} project export(s), wrote ${total} traces`);
    }
  },
  { connection: connectionOptions(), prefix: QUEUE_PREFIX },
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

async function shutdown(signal: string) {
  console.log(`[worker] ${signal} received, draining…`);
  await Promise.all([ingestWorker.close(), maintenanceWorker.close()]);
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

console.log("[worker] memoturn worker started (ingest + retention + export crons)");
