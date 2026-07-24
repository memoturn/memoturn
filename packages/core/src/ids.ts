import { createHash, randomUUID } from "node:crypto";

/** Generate a unique id (UUID v4). Used for traces, observations, scores, events. */
export function newId(): string {
  return randomUUID();
}

/**
 * A stable, UUID-shaped id derived from its inputs — the same inputs always yield the same
 * id. Use it for rows that must be idempotent under retries/re-runs (e.g. an online-eval
 * score is keyed by trace + evaluator): the telemetry store's merge-on-write then dedupes on
 * the id instead of accumulating a fresh row every time the producing job runs again.
 */
export function deterministicId(...parts: string[]): string {
  // NUL separator: unambiguous even when a part (e.g. an evaluator name) contains a space.
  const h = createHash("sha256").update(parts.join("\u0000")).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/** Format a Date (or now) as an ISO-8601 string with offset, for wire timestamps. */
export function isoNow(d: Date = new Date()): string {
  return d.toISOString();
}

// BullMQ disallows ':' in queue names; the shared Redis key namespace is set via the
// `prefix` option (see QUEUE_PREFIX) instead.
export const QUEUE_PREFIX = "memoturn";
export const QUEUE_NAMES = {
  ingest: "ingest",
  ingestDlq: "ingest-dlq", // dead-letter for ingest jobs that exhaust retries
  eval: "eval",
  export: "export",
  automation: "automation",
  experiment: "experiment", // server-executed dataset experiments (fan-out per item)
  sandbox: "sandbox", // public-demo sandbox seeding (DEMO_MODE only)
} as const;
