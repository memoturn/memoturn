/**
 * Replay raw ingest batches from the blob event log back through the ingest queue.
 *
 * This is the disaster-recovery path the backup strategy relies on: Doris (or the Postgres
 * telemetry tier) is NOT snapshotted — the raw batches under `events/<project>/<date>/` are
 * the source of truth, and this tool rebuilds the query store from them. It is also how you
 * re-materialize after an engine move that went wrong, or backfill a project into a fresh
 * store.
 *
 *   bun run replay -- --project <id>                       # every batch for the project
 *   bun run replay -- --project <id> --from 2026-08-01 --to 2026-08-31
 *   bun run replay -- --all --from 2026-09-01              # every project, from a date
 *   bun run replay -- --project <id> --dry-run             # count + size only
 *   bun run replay -- --project <id> --concurrency 50      # enqueue faster (default 20)
 *
 * Idempotent: rows are last-writer-wins by event_ts, so replaying a batch that already
 * landed is a no-op for the store. Replayed jobs carry `replay: true`, which makes the
 * worker skip usage metering and online evaluators (no double billing, no LLM spend).
 * Requires the worker's env (REDIS_URL + BLOB_*). Run with `bun --env-file=.env`.
 */

import { prisma } from "@memoturn/db";
import { listBlobKeys } from "@memoturn/db/blob";
import { getIngestQueue } from "@memoturn/db/queue";

interface Args {
  project?: string;
  all: boolean;
  from?: string;
  to?: string;
  dryRun: boolean;
  concurrency: number;
}

function parseArgs(argv: string[]): Args {
  const opt = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const date = (name: string): string | undefined => {
    const v = opt(name);
    if (v === undefined) return undefined;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) {
      console.error(`error: --${name} must be YYYY-MM-DD (got ${v})`);
      process.exit(2);
    }
    return v;
  };
  const args: Args = {
    project: opt("project"),
    all: argv.includes("--all"),
    from: date("from"),
    to: date("to"),
    dryRun: argv.includes("--dry-run"),
    concurrency: Math.max(1, Math.min(200, Number(opt("concurrency") ?? 20) || 20)),
  };
  if (!args.project && !args.all) {
    console.error("error: pass --project <id> or --all");
    process.exit(2);
  }
  if (args.project && args.all) {
    console.error("error: --project and --all are mutually exclusive");
    process.exit(2);
  }
  return args;
}

/** events/<project>/<YYYY-MM-DD>/<batchId>.json → parts, or null for anything else. */
function parseKey(key: string): { projectId: string; date: string; batchId: string } | null {
  const m = /^events\/([^/]+)\/(\d{4}-\d{2}-\d{2})\/([^/]+)\.json$/.exec(key);
  return m ? { projectId: m[1] as string, date: m[2] as string, batchId: m[3] as string } : null;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const projects = args.all
    ? (await prisma.project.findMany({ select: { id: true, name: true } })).map((p) => p.id)
    : [args.project as string];

  const queue = getIngestQueue();
  let scanned = 0;
  let selected = 0;
  let bytes = 0;
  let enqueued = 0;
  let pending: Promise<unknown>[] = [];

  for (const projectId of projects) {
    for await (const obj of listBlobKeys(`events/${projectId}/`)) {
      scanned++;
      const parts = parseKey(obj.key);
      if (!parts) continue;
      if (args.from && parts.date < args.from) continue;
      if (args.to && parts.date > args.to) continue;
      selected++;
      bytes += obj.size;
      if (args.dryRun) continue;
      pending.push(
        queue.add("ingest", { projectId, batchId: parts.batchId, blobKey: obj.key, replay: true }).then(() => {
          enqueued++;
        }),
      );
      if (pending.length >= args.concurrency) {
        await Promise.all(pending);
        pending = [];
        if (enqueued % 1000 === 0) console.log(`  enqueued ${enqueued}…`);
      }
    }
  }
  await Promise.all(pending);

  const mb = (bytes / 1_048_576).toFixed(1);
  console.log(
    `${args.dryRun ? "[dry-run] " : ""}scanned ${scanned} object(s) across ${projects.length} project(s); ` +
      `selected ${selected} batch(es), ${mb} MB${args.dryRun ? "" : `; enqueued ${enqueued}`}`,
  );
  if (!args.dryRun) {
    console.log("Watch the worker drain the ingest queue (`bun run dlq` shows the DLQ if any batch fails).");
  }
  await queue.close();
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("replay failed:", err);
    process.exit(1);
  });
