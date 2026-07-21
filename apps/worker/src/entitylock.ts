import type { IngestEvent } from "@memoturn/core";

/**
 * The set of entity-lock names a batch must hold while it read-merges and inserts, so a
 * concurrent batch touching the same trace/observation serializes behind it (see withEntityLocks).
 *
 * Every trace and observation the batch writes is included — creates too, not just updates: a
 * trace/observation created in one batch and patched by another that runs concurrently is the same
 * lost-update race. Names are project-scoped so ids only ever collide within their own project.
 * Scores/retrieval/embeddings are append-only by their own id (idempotent under merge-on-write), so
 * they don't need serialization.
 */
export function entityLockNames(projectId: string, batch: IngestEvent[]): string[] {
  const names = new Set<string>();
  for (const e of batch) {
    const id = (e.body as { id?: string }).id;
    if (!id) continue;
    if (e.type === "trace-create") {
      names.add(`${projectId}:t:${id}`);
    } else if (
      e.type === "span-create" ||
      e.type === "span-update" ||
      e.type === "generation-create" ||
      e.type === "generation-update" ||
      e.type === "event-create"
    ) {
      names.add(`${projectId}:o:${id}`);
    }
  }
  return [...names];
}
