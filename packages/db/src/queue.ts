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
        // 8 attempts of exponential backoff (1,2,4,…,64s) span ~2min, so a routine Doris FE
        // restart / failover no longer dumps the whole ingest stream to the DLQ after ~15s.
        // Backoff delays sit in the delayed set, not a worker slot, so this costs no concurrency.
        attempts: 8,
        backoff: { type: "exponential", delay: 1000 },
        removeOnComplete: 1000,
        removeOnFail: 5000,
      },
    });
  }
  return ingestQueue;
}

/** Payload enqueued per experiment run — the worker loads config + items from Postgres. */
export interface ExperimentJob {
  projectId: string;
  experimentId: string;
}

let experimentQueue: Queue<ExperimentJob> | undefined;

/**
 * Queue for server-executed dataset experiments. Each job fans out over dataset items
 * (LLM calls + evaluators), so it can run for minutes — the worker consumes this on a
 * dedicated Worker at low concurrency so experiments never starve ingest. Retries are
 * safe because the ExperimentItemResult checkpoint table skips already-DONE items.
 */
export function getExperimentQueue(): Queue<ExperimentJob> {
  if (!experimentQueue) {
    experimentQueue = new Queue<ExperimentJob>(QUEUE_NAMES.experiment, {
      connection: connectionOptions(),
      prefix: QUEUE_PREFIX,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: "exponential", delay: 2000 },
        removeOnComplete: 1000,
        removeOnFail: 5000, // retain for inspection
      },
    });
  }
  return experimentQueue;
}

/** Payload enqueued when a demo sandbox is provisioned — the worker seeds it. */
export interface SandboxJob {
  organizationId: string;
  projectId: string;
}

let sandboxQueue: Queue<SandboxJob> | undefined;

/**
 * Queue for seeding public-demo sandboxes (DEMO_MODE only). Seeding generates a few
 * hundred events and submits them through the normal ingest path, so a job is seconds
 * of work; retries are safe because the generated entity ids are deterministic and the
 * store merges last-writer-wins.
 */
export function getSandboxQueue(): Queue<SandboxJob> {
  if (!sandboxQueue) {
    sandboxQueue = new Queue<SandboxJob>(QUEUE_NAMES.sandbox, {
      connection: connectionOptions(),
      prefix: QUEUE_PREFIX,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: "exponential", delay: 2000 },
        removeOnComplete: 100,
        removeOnFail: 500,
      },
    });
  }
  return sandboxQueue;
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
