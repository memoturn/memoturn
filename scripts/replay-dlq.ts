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
import { QUEUE_NAMES } from "@memoturn/db/queue";
import { getIngestHealth, inspectDlq, replayDlq } from "@memoturn/server";

async function main() {
  const args = process.argv.slice(2);
  const replay = args.includes("--replay");
  const limitArg = args.find((a) => /^\d+$/.test(a));
  const limit = limitArg ? Number(limitArg) : Number.POSITIVE_INFINITY;

  const { depth, batches } = await inspectDlq(20);
  console.log(`DLQ "${QUEUE_NAMES.ingestDlq}" — ${depth} job(s)`);

  if (depth === 0) {
    console.log("Nothing in the DLQ. ✅");
    return;
  }

  if (!replay) {
    console.log("\nMost recent dead-lettered batches (use --replay to re-enqueue):");
    for (const d of batches) {
      console.log(`  • ${d.batchId}  project=${d.projectId}  failedAt=${d.failedAt || "?"}  error=${d.error || "?"}`);
    }
    // Worker in-process counters (insert latency, error totals) — best-effort.
    const health = await getIngestHealth();
    if (health.workerReachable) {
      console.log(
        `\nWorker: insert avg ${health.insertLatencyMs ?? "?"}ms · counters ${JSON.stringify(health.counters)}`,
      );
    }
    console.log(`\nRun \`bun run dlq --replay\` to reprocess batch(es) from blob.`);
    return;
  }

  const { replayed, failed } = await replayDlq(limit);
  console.log(`\nReplayed ${replayed} batch(es) onto the ingest queue${failed ? ` (${failed} failed)` : ""}.`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("dlq tool failed:", err);
    process.exit(1);
  });
