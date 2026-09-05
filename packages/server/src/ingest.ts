import { type IngestRequest, newId } from "@memoturn/core";
import { deleteBlobObject, putRawBatch } from "@memoturn/db/blob";
import { getIngestQueue } from "@memoturn/db/queue";

/**
 * Raised when the ingest write path (blob store or queue) is unreachable. The API maps it
 * to a 503 + `Retry-After` so SDKs treat it as transient and re-send — a bare 500 gave
 * clients no backpressure signal and no way to tell "your batch is bad" from "we're down".
 */
export class StorageUnavailableError extends Error {
  readonly retryAfterSeconds: number;
  constructor(
    public readonly stage: "blob" | "queue",
    cause: unknown,
    retryAfterSeconds = 5,
  ) {
    super(`ingest ${stage} unavailable: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    this.name = "StorageUnavailableError";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/**
 * Shared ingestion submission: persist the validated batch to blob storage (the
 * replayable source of truth) and enqueue a processing job. Used by both the /v1/ingest
 * and OTel receiver routes so the durability + queueing behavior is identical.
 *
 * Blob-then-enqueue: if the enqueue fails after the blob write, the object is removed
 * (best-effort) before the error surfaces, so a client retry — which mints a NEW batchId —
 * doesn't leave an unreferenced batch behind that no job and no replay will ever find.
 */
export async function submitBatch(
  projectId: string,
  batch: IngestRequest,
  opts: { requestId?: string } = {},
): Promise<{ batchId: string }> {
  const batchId = newId();
  let blobKey: string;
  try {
    blobKey = await putRawBatch(projectId, batchId, batch);
  } catch (err) {
    throw new StorageUnavailableError("blob", err);
  }
  try {
    await getIngestQueue().add("ingest", { projectId, batchId, blobKey, requestId: opts.requestId });
  } catch (err) {
    await deleteBlobObject(blobKey).catch(() => {});
    throw new StorageUnavailableError("queue", err);
  }
  return { batchId };
}
