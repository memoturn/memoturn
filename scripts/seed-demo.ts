/**
 * Seeds a large volume of realistic demo telemetry spanning multiple past days by
 * POSTing raw backdated batches to /v1/ingest — exercising the real pipeline
 * (blob → queue → worker → telemetry store, including cost computation).
 *
 * Run with: bun run seed:demo [-- --days 30 --traces-per-day 1000 --dry-run ...]
 *
 * Prereqs: `bun run setup` done and `bun run dev` running (api on :3001 + worker).
 *
 * Deterministic & idempotent within a UTC day: entity ids and content derive from --seed,
 * so a same-day re-run replaces the same rows via the store's last-writer-wins merge
 * instead of duplicating. Timestamps are anchored to "now", so a re-run on a LATER day
 * shifts the window and can leave old rows behind. Pass --wipe to delete ALL of the
 * project's previous telemetry before seeding.
 *
 * SAFETY: refuses to run when NODE_ENV=production, or against a non-localhost
 * --base-url, unless ALLOW_SEED=1 — this floods a project with fake demo data.
 */
import { parseArgs } from "node:util";
import { prisma } from "@memoturn/db";
import { telemetry } from "@memoturn/telemetry";
import { type IngestEvent, ingestRequest } from "../packages/core/src/events";
import { type DemoDataConfig, demoDayWindow, generateDemoDay, packBatches } from "../packages/server/src/demodata";

// ── CLI + guards ─────────────────────────────────────────────────────────────────

const { values: flags } = parseArgs({
  options: {
    days: { type: "string", default: "30" },
    "traces-per-day": { type: "string", default: "1000" },
    "base-url": { type: "string", default: process.env.MEMOTURN_BASE_URL ?? "http://localhost:3001" },
    keys: { type: "string", default: "pk-mt-dev:sk-mt-dev" }, // "publicKey:secretKey"
    seed: { type: "string", default: "42" },
    concurrency: { type: "string", default: "4" },
    "dry-run": { type: "boolean", default: false },
    "no-verify": { type: "boolean", default: false },
    wipe: { type: "boolean", default: false },
  },
});

const DAYS = Math.max(1, Number(flags.days));
const TRACES_PER_DAY = Math.max(1, Number(flags["traces-per-day"]));
const BASE_URL = (flags["base-url"] as string).replace(/\/$/, "");
const SEED = flags.seed as string;
const CONCURRENCY = Math.max(1, Number(flags.concurrency));
const DRY_RUN = flags["dry-run"] as boolean;
const NO_VERIFY = flags["no-verify"] as boolean;
const WIPE = flags.wipe as boolean;
const AUTH_HEADER = `Basic ${Buffer.from(flags.keys as string).toString("base64")}`;

const allowUnsafe = process.env.ALLOW_SEED === "1";
if (process.env.NODE_ENV === "production" && !allowUnsafe) {
  console.error("Refusing to seed demo data in production. Set ALLOW_SEED=1 to override.");
  process.exit(1);
}
if (!/^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(BASE_URL) && !allowUnsafe) {
  console.error(`Refusing to seed demo data against non-localhost ${BASE_URL}. Set ALLOW_SEED=1 to override.`);
  process.exit(1);
}

const stats = { batches: 0, events: 0, eventErrors: 0 };

async function postBatch(batch: IngestEvent[]): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(`${BASE_URL}/v1/ingest`, {
        method: "POST",
        headers: { authorization: AUTH_HEADER, "content-type": "application/json" },
        body: JSON.stringify({ batch }),
      });
    } catch (err) {
      if (attempt >= 3) throw new Error(`ingest POST failed after ${attempt + 1} attempts: ${err}`);
      await Bun.sleep(500 * 2 ** attempt);
      continue;
    }
    if (res.status === 401) {
      throw new Error("401 from /v1/ingest — run `bun run seed` first or pass --keys pk:sk");
    }
    if (res.status === 429 || res.status >= 500) {
      if (attempt >= 3) throw new Error(`ingest POST failed with ${res.status} after ${attempt + 1} attempts`);
      await Bun.sleep(500 * 2 ** attempt);
      continue;
    }
    const json = (await res.json()) as { errors?: { id: string; error?: string }[] };
    const errors = json.errors ?? [];
    if (errors.length > 0) {
      stats.eventErrors += errors.length;
      if (stats.eventErrors <= 5) console.error(`  event rejected: ${errors[0]?.id} — ${errors[0]?.error}`);
    }
    stats.batches++;
    stats.events += batch.length;
    return;
  }
}

/** Minimal promise pool: run tasks with at most CONCURRENCY in flight. */
async function runPool(tasks: (() => Promise<void>)[]): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(CONCURRENCY, tasks.length) }, async () => {
    while (next < tasks.length) {
      const task = tasks[next++];
      if (task) await task();
    }
  });
  await Promise.all(workers);
}

// ── Verification ────────────────────────────────────────────────────────────────

const WORKER_METRICS_URL = `http://localhost:${process.env.WORKER_PORT ?? 3002}/metrics`;

/** Resolve the project the demo data lands in from the ingest key pair (--keys). */
async function resolveProjectId(): Promise<string> {
  const publicKey = (flags.keys as string).split(":")[0] ?? "";
  const key = await prisma.apiKey.findUnique({ where: { publicKey } });
  if (!key) {
    console.error(`No API key found for public key "${publicKey}" — run \`bun run seed\` first.`);
    process.exit(1);
  }
  return key.projectId;
}

/**
 * Waits until this run's rows are queryable in the telemetry store (the ground truth),
 * then prints counts + total cost. Counts are project-wide (the demo project), so prior
 * runs and quickstart traces are included. Deliberately does NOT wait for the ingest
 * queue to drain: online evaluators fan out one follow-up score job per sampled trace,
 * so at this volume the queue stays busy long after the seeded rows have landed.
 */
async function verifyCounts(
  projectId: string,
  expected: { traces: number; observations: number; scores: number },
): Promise<void> {
  const deadline = Date.now() + 5 * 60_000;
  let last = { traces: 0, observations: 0, scores: 0 };
  for (;;) {
    last = await telemetry().countProjectRows(projectId);
    if (last.traces >= expected.traces && last.observations >= expected.observations && last.scores >= expected.scores)
      break;
    if (Date.now() > deadline) {
      console.warn("  seeded rows not fully visible after 5 minutes — the worker may be down or backlogged");
      break;
    }
    await Bun.sleep(2000);
  }
  const byModel = await telemetry().metricsByModel(projectId, 3650);
  const cost = Math.round(byModel.reduce((s, m) => s + m.total_cost, 0) * 100) / 100;
  console.log("\nTelemetry store (all project rows, incl. prior runs):");
  console.log(`  traces       : ${last.traces} (this run generated ${expected.traces})`);
  console.log(`  observations : ${last.observations} (this run generated ${expected.observations})`);
  console.log(`  scores       : ${last.scores} (this run generated ${expected.scores})`);
  console.log(`  total cost   : $${cost}`);
}

/** Deletes ALL of the project's telemetry (traces/observations/scores) before seeding. */
async function wipeProjectRows(projectId: string): Promise<void> {
  console.log("Wiping the project's previous telemetry...");
  await telemetry().deleteProjectData(projectId);
}

/** One-shot queue health report — informational only, never blocks. */
async function reportQueueState(): Promise<void> {
  try {
    const res = await fetch(WORKER_METRICS_URL);
    const json = (await res.json()) as {
      queues?: { ingest?: { waiting?: number; active?: number; delayed?: number } };
      dlqDepth?: number;
    };
    const q = json.queues?.ingest ?? {};
    const pending = (q.waiting ?? 0) + (q.active ?? 0) + (q.delayed ?? 0);
    if ((json.dlqDepth ?? 0) > 0) console.warn(`  WARNING: dlqDepth=${json.dlqDepth} — inspect with \`bun run dlq\``);
    if (pending > 0) console.log(`  note: ${pending} ingest jobs still queued (online evaluator score writebacks)`);
  } catch {
    console.log(`  worker /metrics unreachable at ${WORKER_METRICS_URL} — skipping queue health report`);
  }
}

// ── Main ────────────────────────────────────────────────────────────────────────

async function main() {
  console.log(
    `Seeding ${DAYS} days × ~${TRACES_PER_DAY} traces/day → ${BASE_URL}/v1/ingest` +
      `${DRY_RUN ? " (dry run — nothing sent)" : ""}`,
  );
  const demoConfig: DemoDataConfig = { days: DAYS, tracesPerDay: TRACES_PER_DAY, seed: SEED, now: Date.now() };
  const projectId = DRY_RUN ? "" : await resolveProjectId();
  if (WIPE && !DRY_RUN) await wipeProjectRows(projectId);
  const generated = { traces: 0, observations: 0, scores: 0, events: 0, batches: 0 };
  let perDayMin = Number.POSITIVE_INFINITY;
  let perDayMax = 0;

  for (let day = DAYS - 1; day >= 0; day--) {
    // One day at a time so a large run never materializes the whole set in memory.
    const events = generateDemoDay(demoConfig, day);
    const traceCount = events.filter((e) => e.type === "trace-create").length;
    perDayMin = Math.min(perDayMin, traceCount);
    perDayMax = Math.max(perDayMax, traceCount);
    generated.traces += traceCount;
    generated.events += events.length;
    generated.observations += events.filter((e) => e.type !== "trace-create" && e.type !== "score-create").length;
    generated.scores += events.filter((e) => e.type === "score-create").length;

    const batches = packBatches(events);
    generated.batches += batches.length;
    // Cheap drift guard: zod-validate every batch in dry runs, the first batch of each day otherwise.
    for (const batch of DRY_RUN ? batches : batches.slice(0, 1)) ingestRequest.parse({ batch });

    if (!DRY_RUN) {
      // Send day-by-day (concurrency within the day) so we never hold the full run in memory.
      await runPool(batches.map((batch) => () => postBatch(batch)));
      console.log(`  day -${day}: ${traceCount} traces sent (${stats.batches}/${generated.batches} batches total)`);
    }
  }

  console.log("\nGenerated:");
  console.log(`  traces       : ${generated.traces} (per day min ${perDayMin} / max ${perDayMax})`);
  console.log(`  observations : ${generated.observations}`);
  console.log(`  scores       : ${generated.scores}`);
  console.log(`  events       : ${generated.events} in ${generated.batches} batches`);
  if (DRY_RUN) return;
  if (stats.eventErrors > 0) console.warn(`  WARNING: ${stats.eventErrors} events rejected by the API`);

  if (!NO_VERIFY) {
    console.log("\nWaiting for the seeded rows to land in the telemetry store...");
    await verifyCounts(projectId, {
      traces: generated.traces,
      observations: generated.observations,
      scores: generated.scores,
    });
    await reportQueueState();
    await telemetry().close();
  }
  console.log("\nDone. Open http://localhost:3000 — dashboards default to the last 30 days.");
}

main().catch((err) => {
  console.error("seed:demo failed:", err);
  process.exit(1);
});
