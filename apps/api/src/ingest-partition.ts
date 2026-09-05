import { type IngestEvent, ingestEvent } from "@memoturn/core";

export interface IngestPartition {
  /** Zod-parsed events (defaults applied) — used for the 207 response ids. */
  valid: IngestEvent[];
  /**
   * The ORIGINAL (pre-zod-default) event objects for the valid events — this is what gets
   * persisted to blob. Storing the parsed form would bake in defaults (e.g. `environment:
   * "default"`, `source: "API"`), which the worker then can't distinguish from client-provided
   * values — defeating the mutable-state merge's "which fields did the client actually send?"
   * check (ADR-0001). The worker re-parses with `ingestRequest.parse`, so the Doris path is
   * unchanged; only the mutable-state provided-ness is restored.
   */
  persist: unknown[];
  errors: { id: string; index: number; status: 400; error: string }[];
}

/**
 * Per-event limits, enforced at the edge so one pathological event can't dominate a batch
 * (the body cap is 12 MB for the whole batch) or blow the recursion budget of the worker's
 * masking / media-offload walks, which run in the shared ingest process for every tenant.
 * Larger payloads belong in `/v1/media` (or get offloaded client-side); deeper nesting
 * has never been a legitimate telemetry shape.
 */
const envInt = (name: string, fallback: number): number => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : fallback;
};
export const MAX_EVENT_BYTES = envInt("INGEST_MAX_EVENT_BYTES", 1024 * 1024);
export const MAX_JSON_DEPTH = envInt("INGEST_MAX_JSON_DEPTH", 32);

/** Depth of the deepest nested object/array (a scalar is 0), computed iteratively. */
export function jsonDepth(value: unknown, limit = Number.POSITIVE_INFINITY): number {
  let max = 0;
  const stack: { v: unknown; d: number }[] = [{ v: value, d: 0 }];
  while (stack.length) {
    const { v, d } = stack.pop() as { v: unknown; d: number };
    if (v === null || typeof v !== "object") continue;
    const depth = d + 1;
    if (depth > max) max = depth;
    if (max > limit) return max; // early exit — the caller only needs "too deep"
    const children = Array.isArray(v) ? v : Object.values(v as Record<string, unknown>);
    for (const c of children) if (c !== null && typeof c === "object") stack.push({ v: c, d: depth });
  }
  return max;
}

/** Validate a raw ingest batch, keeping the original bodies of valid events for persistence. */
export function partitionIngestBatch(rawBatch: unknown[]): IngestPartition {
  const valid: IngestEvent[] = [];
  const persist: unknown[] = [];
  const errors: IngestPartition["errors"] = [];
  rawBatch.forEach((raw, index) => {
    const id = typeof (raw as { id?: unknown } | null)?.id === "string" ? (raw as { id: string }).id : "";
    // Size + depth gates run before zod: a 10 MB event is rejected without being parsed.
    const bytes = raw === undefined ? 0 : (JSON.stringify(raw)?.length ?? 0);
    if (bytes > MAX_EVENT_BYTES) {
      errors.push({
        id,
        index,
        status: 400,
        error: `event is ${bytes} bytes; the per-event limit is ${MAX_EVENT_BYTES} (use /v1/media for large payloads)`,
      });
      return;
    }
    if (jsonDepth(raw, MAX_JSON_DEPTH) > MAX_JSON_DEPTH) {
      errors.push({ id, index, status: 400, error: `event is nested deeper than ${MAX_JSON_DEPTH} levels` });
      return;
    }
    const parsed = ingestEvent.safeParse(raw);
    if (parsed.success) {
      valid.push(parsed.data);
      persist.push(raw); // original, pre-default
      return;
    }
    const issue = parsed.error.issues[0];
    const error = (issue ? `${issue.path.join(".") || "event"}: ${issue.message}` : "invalid event").slice(0, 500);
    errors.push({ id, index, status: 400, error });
  });
  return { valid, persist, errors };
}
