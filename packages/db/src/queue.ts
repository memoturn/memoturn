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

export type { ConnectionOptions };
export { QUEUE_NAMES, QUEUE_PREFIX };
