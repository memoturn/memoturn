import { ingestRequest } from "@memoturn/core";
import { clickhouse } from "@memoturn/db/clickhouse";
import { getRawBatch } from "@memoturn/db/blob";
import type { IngestJob } from "@memoturn/db/queue";
import type { Job } from "bullmq";
import { mapEvents } from "../mappers.js";

/**
 * Ingest job processor. Re-reads the raw batch from blob storage (the source of
 * truth), validates it, maps events to ClickHouse rows, and inserts.
 *
 * NOTE (Phase 2 hardening): create + update for one observation are merged when they
 * arrive in the same batch. Cross-batch partial updates currently insert a new
 * ReplacingMergeTree row; a read-merge against the existing row will be added so
 * fields set at create time are never lost.
 */
export async function processIngest(job: Job<IngestJob>): Promise<void> {
  const { projectId, blobKey } = job.data;

  const raw = await getRawBatch(blobKey);
  if (!raw) throw new Error(`raw batch not found at ${blobKey}`);

  const parsed = ingestRequest.parse(JSON.parse(raw));
  const { traces, observations, scores } = mapEvents(projectId, parsed.batch);

  const ch = clickhouse();
  await Promise.all([
    traces.length
      ? ch.insert({ table: "traces", values: traces, format: "JSONEachRow" })
      : Promise.resolve(),
    observations.length
      ? ch.insert({ table: "observations", values: observations, format: "JSONEachRow" })
      : Promise.resolve(),
    scores.length
      ? ch.insert({ table: "scores", values: scores, format: "JSONEachRow" })
      : Promise.resolve(),
  ]);

  console.log(
    `[ingest] project=${projectId} traces=${traces.length} observations=${observations.length} scores=${scores.length}`,
  );
}
