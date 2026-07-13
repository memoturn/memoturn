/**
 * Inspect and replay the ingest dead-letter queue (DLQ).
 *
 * Ingest batches that exhaust their BullMQ retries are moved to the `ingest-dlq` queue
 * (with their original blob key) instead of being discarded. The raw batch still lives in
 * blob storage — the replayable source of truth — so a DLQ'd batch can be re-processed once
 * the underlying cause (e.g. a Doris outage) is resolved.
 *
 *   bun run dlq            # inspect: counts + the most recent dead-lettered batches
 *   bun run dlq --replay   # re-enqueue every DLQ batch onto the ingest queue, then clear it
 *   bun run dlq --replay 50  # replay at most 50
 *
 * Requires the same env as the worker (REDIS_URL). Run with `bun --env-file=.env`.
 */
import { getDlqQueue, getIngestQueue, QUEUE_NAMES } from "@memoturn/db/queue";

const STATES = ["waiting", "delayed", "failed", "completed", "active"] as const;

async function main() {
  const args = process.argv.slice(2);
  const replay = args.includes("--replay");
  const limitArg = args.find((a) => /^\d+$/.test(a));
  const limit = limitArg ? Number(limitArg) : Infinity;

  const dlq = getDlqQueue();

  const counts = await dlq.getJobCounts(...STATES);
  const total = STATES.reduce((n, s) => n + (counts[s] ?? 0), 0);
  console.log(`DLQ "${QUEUE_NAMES.ingestDlq}" — ${total} job(s): ${JSON.stringify(counts)}`);

  const jobs = await dlq.getJobs([...STATES]);
  if (jobs.length === 0) {
    console.log("Nothing in the DLQ. ✅");
    await dlq.close();
    return;
  }

  if (!replay) {
    console.log("\nMost recent dead-lettered batches (use --replay to re-enqueue):");
    for (const job of jobs.slice(0, 20)) {
      const d = job.data;
      console.log(`  • ${d.batchId}  project=${d.projectId}  failedAt=${d.failedAt ?? "?"}  error=${d.error ?? "?"}`);
    }
    console.log(`\nRun \`bun run dlq --replay\` to reprocess ${jobs.length} batch(es) from blob.`);
    await dlq.close();
    return;
  }

  const ingest = getIngestQueue();
  let replayed = 0;
  for (const job of jobs) {
    if (replayed >= limit) break;
    const { projectId, batchId, blobKey } = job.data;
    try {
      await ingest.add("ingest", { projectId, batchId, blobKey });
      await job.remove();
      replayed++;
      console.log(`  ↻ replayed ${batchId} (project=${projectId})`);
    } catch (err) {
      console.error(`  ✗ failed to replay ${batchId}:`, err instanceof Error ? err.message : err);
    }
  }
  console.log(`\nReplayed ${replayed} batch(es) onto the ingest queue.`);
  await dlq.close();
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("dlq tool failed:", err);
    process.exit(1);
  });
