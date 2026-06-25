import { QUEUE_NAMES, QUEUE_PREFIX } from "@memoturn/core";
import { connectionOptions, type IngestJob } from "@memoturn/db/queue";
import { Worker } from "bullmq";
import { processIngest } from "./processors/ingest.js";

/**
 * memoturn worker — consumes BullMQ queues and writes telemetry to ClickHouse.
 * Phase 1 runs the ingest queue; eval / export / automation workers slot in later.
 */
const concurrency = Number(process.env.WORKER_CONCURRENCY ?? 10);

const ingestWorker = new Worker<IngestJob>(QUEUE_NAMES.ingest, processIngest, {
  connection: connectionOptions(),
  prefix: QUEUE_PREFIX,
  concurrency,
});

ingestWorker.on("ready", () => console.log(`[worker] ingest ready (concurrency=${concurrency})`));
ingestWorker.on("failed", (job, err) => console.error(`[worker] job ${job?.id} failed:`, err.message));

async function shutdown(signal: string) {
  console.log(`[worker] ${signal} received, draining…`);
  await ingestWorker.close();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

console.log("[worker] memoturn worker started");
