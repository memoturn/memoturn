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

/** Validate a raw ingest batch, keeping the original bodies of valid events for persistence. */
export function partitionIngestBatch(rawBatch: unknown[]): IngestPartition {
  const valid: IngestEvent[] = [];
  const persist: unknown[] = [];
  const errors: IngestPartition["errors"] = [];
  rawBatch.forEach((raw, index) => {
    const parsed = ingestEvent.safeParse(raw);
    if (parsed.success) {
      valid.push(parsed.data);
      persist.push(raw); // original, pre-default
      return;
    }
    const id = typeof (raw as { id?: unknown } | null)?.id === "string" ? (raw as { id: string }).id : "";
    const issue = parsed.error.issues[0];
    const error = (issue ? `${issue.path.join(".") || "event"}: ${issue.message}` : "invalid event").slice(0, 500);
    errors.push({ id, index, status: 400, error });
  });
  return { valid, persist, errors };
}
