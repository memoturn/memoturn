import { randomUUID } from "node:crypto";

/** Generate a unique id (UUID v4). Used for traces, observations, scores, events. */
export function newId(): string {
  return randomUUID();
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
  eval: "eval",
  export: "export",
  automation: "automation",
} as const;
