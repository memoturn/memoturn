import { QUEUE_NAMES, QUEUE_PREFIX } from "@memoturn/core";
import { type ConnectionOptions, Queue } from "bullmq";
import { Redis } from "ioredis";

/**
 * BullMQ wiring on Redis/Valkey. The web app produces ingest jobs; the worker
 * consumes them. A single shared Redis connection is reused for producers.
 */
let connection: Redis | undefined;

export function redisConnection(): Redis {
  if (!connection) {
    connection = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379", {
      maxRetriesPerRequest: null, // required by BullMQ
    });
  }
  return connection;
}

export function connectionOptions(): ConnectionOptions {
  return redisConnection();
}

/** Payload enqueued per ingest batch — worker fetches the raw events from blob. */
export interface IngestJob {
  projectId: string;
  batchId: string;
  blobKey: string;
}

/** Dead-lettered ingest job — the original payload plus failure context. */
export interface IngestDlqJob extends IngestJob {
  error?: string;
  failedAt?: string;
}

let ingestQueue: Queue<IngestJob> | undefined;

export function getIngestQueue(): Queue<IngestJob> {
  if (!ingestQueue) {
    ingestQueue = new Queue<IngestJob>(QUEUE_NAMES.ingest, {
      connection: connectionOptions(),
      prefix: QUEUE_PREFIX,
      defaultJobOptions: {
        attempts: 5,
        backoff: { type: "exponential", delay: 1000 },
        removeOnComplete: 1000,
        removeOnFail: 5000,
      },
    });
  }
  return ingestQueue;
}

let dlqQueue: Queue<IngestDlqJob> | undefined;

/** Dead-letter queue for ingest batches that exhaust their retries (inspect/replay). */
export function getDlqQueue(): Queue<IngestDlqJob> {
  if (!dlqQueue) {
    dlqQueue = new Queue<IngestDlqJob>(QUEUE_NAMES.ingestDlq, {
      connection: connectionOptions(),
      prefix: QUEUE_PREFIX,
    });
  }
  return dlqQueue;
}

export type { ConnectionOptions };
export { QUEUE_NAMES, QUEUE_PREFIX };
