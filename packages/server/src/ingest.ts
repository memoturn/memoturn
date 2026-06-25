import { type IngestRequest, newId } from "@memoturn/core";
import { putRawBatch } from "@memoturn/db/blob";
import { getIngestQueue } from "@memoturn/db/queue";

/**
 * Shared ingestion submission: persist the validated batch to blob storage (the
 * replayable source of truth) and enqueue a processing job. Used by both the /v1/ingest
 * and OTel receiver routes so the durability + queueing behavior is identical.
 */
export async function submitBatch(projectId: string, batch: IngestRequest): Promise<{ batchId: string }> {
  const batchId = newId();
  const blobKey = await putRawBatch(projectId, batchId, batch);
  await getIngestQueue().add("ingest", { projectId, batchId, blobKey });
  return { batchId };
}
