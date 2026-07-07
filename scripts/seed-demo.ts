/**
 * Seeds a large volume of realistic demo telemetry spanning multiple past days by
 * POSTing raw backdated batches to /v1/ingest — exercising the real pipeline
 * (blob → queue → worker → ClickHouse, including cost computation).
 *
 * Run with: bun run seed:demo [-- --days 30 --traces-per-day 1000 --dry-run ...]
 *
 * Prereqs: `bun run setup` done and `bun run dev` running (api on :3001 + worker).
 *
 * Deterministic & idempotent within a UTC day: entity ids and content derive from --seed,
 * so a same-day re-run replaces the same rows via ReplacingMergeTree instead of duplicating.
 * Timestamps are anchored to "now", and ClickHouse dedups by (project_id, toDate, id) — so a
 * re-run on a LATER day shifts the window and leaves the old rows behind. Pass --wipe to
 * delete all previous demo rows (and rebuild the daily rollup) before seeding.
 *
 * SAFETY: refuses to run when NODE_ENV=production, or against a non-localhost
 * --base-url, unless ALLOW_SEED=1 — this floods a project with fake demo data.
 */
import { parseArgs } from "node:util";
import { clickhouse } from "@memoturn/db/clickhouse";
import { type IngestEvent, ingestRequest } from "../packages/core/src/events";

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

// ── Deterministic PRNG helpers ──────────────────────────────────────────────────

function fnv1a(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Rng = () => number;
const randInt = (rng: Rng, min: number, max: number) => min + Math.floor(rng() * (max - min + 1));
const pick = <T>(rng: Rng, arr: readonly T[]): T => arr[Math.floor(rng() * arr.length)] as T;
/** Rough bell curve around `mean`, spread ±`spread`, clamped at `min`. */
const gauss = (rng: Rng, mean: number, spread: number, min = 0) =>
  Math.max(min, Math.round(mean + (rng() + rng() + rng() - 1.5) * spread));

function weightedPick<T>(rng: Rng, entries: readonly (readonly [T, number])[]): T {
  const total = entries.reduce((s, [, w]) => s + w, 0);
  let r = rng() * total;
  for (const [value, weight] of entries) {
    r -= weight;
    if (r <= 0) return value;
  }
  return entries[entries.length - 1]?.[0] as T;
}

// ── Data pools ──────────────────────────────────────────────────────────────────

const ADJECTIVES = [
  "amber",
  "brisk",
  "coral",
  "dusty",
  "eager",
  "fuzzy",
  "gold",
  "hazel",
  "iron",
  "jade",
  "kind",
  "lunar",
];
const NOUNS = ["otter", "falcon", "maple", "comet", "harbor", "prairie", "ridge", "sparrow", "thicket", "willow"];
// ~120 users with a power-law weight so a few users dominate (realistic per-user views).
const USERS = ADJECTIVES.flatMap((a) => NOUNS.map((n) => `user-${a}-${n}`)).map(
  (id, i) => [id, 1 / (i + 1) ** 0.6] as const,
);

// [model, weight, meanLatencyMs] — names must match the registry in packages/core/src/models.ts for nonzero cost.
const MODELS = [
  ["claude-sonnet-4-6", 0.35, 1800],
  ["gpt-4o-mini", 0.25, 700],
  ["claude-haiku-4-5", 0.15, 600],
  ["gpt-4.1", 0.1, 1500],
  ["claude-opus-4-1", 0.08, 3200],
  ["o3-mini", 0.07, 2500],
] as const;

const ENVIRONMENTS = [
  ["production", 0.8],
  ["staging", 0.12],
  ["default", 0.08],
] as const;

const RELEASES = ["v1.4.2", "v1.5.0", "v1.5.1", "v1.6.0"];
const EXTRA_TAGS = ["beta", "internal", "priority", "eu-region", "mobile"];
const TOOLS = ["search-kb", "fetch-ticket", "lookup-order", "run-sql", "send-email-draft"];

const QA_PAIRS = [
  [
    "How do I reset my password?",
    "Go to Settings → Security → Reset password. A confirmation link lands in your inbox within a minute.",
  ],
  [
    "Why was my card charged twice?",
    "The second entry is a temporary authorization hold — it drops off within 3-5 business days and only one charge settles.",
  ],
  [
    "Can I export my data as CSV?",
    "Yes — open the table view and use Export → CSV in the top-right menu. Exports over 10k rows are emailed to you.",
  ],
  [
    "How do I invite a teammate?",
    "From the Organization page, click Invite member, enter their email, and pick a role. They'll get a signup link.",
  ],
  [
    "Does the API support pagination?",
    "Yes, list endpoints accept `page` and `limit` (max 500) and return a `total` count for building pagers.",
  ],
  [
    "My webhook stopped firing, what should I check?",
    "Check the webhook's delivery log for recent 4xx/5xx responses, then verify the signing secret matches your handler.",
  ],
  [
    "What's the difference between staging and production keys?",
    "Staging keys write to an isolated environment with the same schema — nothing crosses over into production data.",
  ],
  [
    "How long are traces retained?",
    "Retention defaults to 30 days and is configurable per project under Settings → Retention.",
  ],
  [
    "Can I self-host this?",
    "Yes — the whole stack ships as a Docker Compose file. See the deployment docs for the single-VM setup.",
  ],
  [
    "Why is my dashboard empty?",
    "Data is ingested asynchronously — allow a few seconds after sending. Also confirm the project selector matches your API key.",
  ],
  [
    "How do I rotate an API key?",
    "Create a new key first, deploy it, then revoke the old one from the API Keys page — revocation is immediate.",
  ],
  [
    "Is there a rate limit on ingestion?",
    "Not by default in dev; hosted projects meter events per minute and return 429 with a Retry-After header.",
  ],
] as const;

const ERROR_MESSAGES = [
  "upstream timeout after 30000ms",
  "rate_limited: 429 from provider",
  "provider returned 529 overloaded",
  "context window exceeded for model",
];
const WARNING_MESSAGES = [
  "retry 1/3 succeeded",
  "fallback model used after primary timeout",
  "truncated tool output at 8kb",
];

const EVAL_COMMENTS = [
  "Answer directly addresses the question with accurate product detail.",
  "Mostly relevant; the second paragraph drifts off-topic.",
  "Grounded in the retrieved docs, minor phrasing issues.",
  "Response is generic and misses the specific error the user described.",
];

// Diurnal weight per hour (UTC) — business-hours peak, quiet nights.
const HOUR_WEIGHTS = [1, 1, 1, 1, 1, 2, 3, 5, 8, 10, 11, 11, 10, 10, 11, 10, 9, 8, 6, 5, 4, 3, 2, 1].map(
  (w, h) => [h, w] as const,
);

// ── Trace generation ────────────────────────────────────────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.now();
const iso = (ms: number) => new Date(ms).toISOString();

type Ctx = {
  traceId: string;
  rng: Rng;
  environment: string;
  events: IngestEvent[];
  obsSeq: number;
};

function addObservation(
  ctx: Ctx,
  type: "span-create" | "generation-create" | "event-create",
  startMs: number,
  endMs: number,
  body: Record<string, unknown>,
): string {
  const id = `demo-obs-${ctx.traceId}-${ctx.obsSeq++}`;
  ctx.events.push({
    id: `evt-${id}`,
    timestamp: iso(endMs),
    type,
    body: {
      id,
      traceId: ctx.traceId,
      environment: ctx.environment,
      startTime: iso(startMs),
      endTime: iso(endMs),
      ...body,
    },
  } as IngestEvent);
  return id;
}

function makeGenerationBody(
  rng: Rng,
  opts: { promptMean: number; completionMean: number; input: unknown; output: unknown },
) {
  const [model, , meanLatency] = weightedPick(
    rng,
    MODELS.map((m) => [m, m[1]] as const),
  );
  const promptTokens = gauss(rng, opts.promptMean, opts.promptMean * 0.4, 20);
  const completionTokens = gauss(rng, opts.completionMean, opts.completionMean * 0.5, 5);
  const durationMs = Math.max(120, Math.round(meanLatency * Math.exp((rng() + rng() - 1) * 0.8)));
  return {
    durationMs,
    body: {
      model,
      modelParameters: { temperature: 0.2 + Math.round(rng() * 6) / 10, max_tokens: 1024 },
      usage: { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens },
      input: opts.input,
      output: opts.output,
    },
  };
}

/** Builds all ingest events for one trace. Fully deterministic from (SEED, dayIndex, traceIndex). */
function makeTrace(dayIndex: number, traceIndex: number, dayStartMs: number, dayCutoffMs: number): IngestEvent[] {
  const rng = mulberry32(fnv1a(`${SEED}:${dayIndex}:${traceIndex}`));
  const traceId = `demo-trace-d${dayIndex}-${traceIndex}`;

  const hour = weightedPick(rng, HOUR_WEIGHTS);
  let t = dayStartMs + hour * 3600_000 + Math.floor(rng() * 3600_000);
  if (t > dayCutoffMs) t = dayStartMs + ((t - dayStartMs) % Math.max(1, dayCutoffMs - dayStartMs));
  const traceStart = t;

  const environment = weightedPick(rng, ENVIRONMENTS);
  const userIdx = USERS.indexOf(
    weightedPick(
      rng,
      USERS.map((u) => [u, u[1]] as const),
    ),
  );
  const userId = USERS[userIdx]?.[0] ?? "user-unknown";
  const scenario = weightedPick(rng, [
    ["chat-completion", 0.55],
    ["rag-pipeline", 0.3],
    ["agent-loop", 0.15],
  ] as const);
  const [question, answer] = pick(rng, QA_PAIRS);
  const isError = rng() < 0.03;
  const hasWarning = !isError && rng() < 0.05;

  const ctx: Ctx = { traceId, rng, environment, events: [], obsSeq: 0 };
  let cursor = traceStart;
  let finalGenerationId = "";
  const traceInput = [{ role: "user", content: question }];
  const traceOutput = isError ? null : { role: "assistant", content: answer };

  if (scenario === "chat-completion") {
    const gen = makeGenerationBody(rng, {
      promptMean: 350,
      completionMean: 180,
      input: traceInput,
      output: traceOutput,
    });
    finalGenerationId = addObservation(ctx, "generation-create", cursor, cursor + gen.durationMs, {
      name: "chat",
      ...gen.body,
    });
    cursor += gen.durationMs;
  } else if (scenario === "rag-pipeline") {
    const retrieveMs = randInt(rng, 40, 280);
    const spanId = addObservation(ctx, "span-create", cursor, cursor + retrieveMs, {
      name: "retrieve-docs",
      input: { query: question, topK: 5 },
      output: { hits: randInt(rng, 2, 5) },
      ...(hasWarning ? { level: "WARNING", statusMessage: pick(rng, WARNING_MESSAGES) } : {}),
    });
    if (rng() < 0.6) {
      addObservation(ctx, "event-create", cursor + 5, cursor + 15, {
        name: "cache-check",
        parentObservationId: spanId,
        output: { hit: rng() < 0.3 },
      });
    }
    cursor += retrieveMs + randInt(rng, 5, 20);
    const gen = makeGenerationBody(rng, {
      promptMean: 900,
      completionMean: 220,
      input: traceInput,
      output: traceOutput,
    });
    finalGenerationId = addObservation(ctx, "generation-create", cursor, cursor + gen.durationMs, {
      name: "answer",
      promptId: "support-reply",
      promptVersion: "1",
      ...gen.body,
    });
    cursor += gen.durationMs;
  } else {
    const planMs = randInt(rng, 80, 400);
    addObservation(ctx, "span-create", cursor, cursor + planMs, {
      name: "plan",
      input: { goal: question },
      output: { steps: randInt(rng, 2, 4) },
    });
    cursor += planMs;
    const steps = randInt(rng, 2, 4);
    for (let s = 0; s < steps; s++) {
      const tool = pick(rng, TOOLS);
      const toolMs = randInt(rng, 30, 300);
      addObservation(ctx, "span-create", cursor, cursor + toolMs, {
        name: `execute-tool:${tool}`,
        input: { tool, args: { query: question.slice(0, 40) } },
        output: { ok: true },
        ...(hasWarning && s === 0 ? { level: "WARNING", statusMessage: pick(rng, WARNING_MESSAGES) } : {}),
      });
      cursor += toolMs;
      const stepGen = makeGenerationBody(rng, {
        promptMean: 500,
        completionMean: 90,
        input: { role: "tool", tool },
        output: { decision: s === steps - 1 ? "finalize" : "continue" },
      });
      addObservation(ctx, "generation-create", cursor, cursor + stepGen.durationMs, {
        name: `step-${s + 1}`,
        ...stepGen.body,
      });
      cursor += stepGen.durationMs;
    }
    const gen = makeGenerationBody(rng, {
      promptMean: 1200,
      completionMean: 260,
      input: traceInput,
      output: traceOutput,
    });
    finalGenerationId = addObservation(ctx, "generation-create", cursor, cursor + gen.durationMs, {
      name: "final-answer",
      ...gen.body,
    });
    cursor += gen.durationMs;
  }

  if (isError) {
    // Mark the final generation as failed: replace its event with an ERROR-level one.
    const failed = ctx.events[ctx.events.length - 1] as IngestEvent & { body: Record<string, unknown> };
    failed.body.level = "ERROR";
    failed.body.statusMessage = pick(rng, ERROR_MESSAGES);
    failed.body.output = null;
  }

  const releaseIdx = Math.min(RELEASES.length - 1, Math.floor((1 - dayIndex / Math.max(1, DAYS)) * RELEASES.length));
  ctx.events.unshift({
    id: `evt-${traceId}`,
    timestamp: iso(traceStart),
    type: "trace-create",
    body: {
      id: traceId,
      name: scenario,
      timestamp: iso(traceStart),
      userId,
      sessionId: `demo-session-u${userIdx}-d${dayIndex}`,
      release: RELEASES[releaseIdx],
      environment,
      tags: [scenario.split("-")[0] ?? scenario, ...(rng() < 0.4 ? [pick(rng, EXTRA_TAGS)] : [])],
      metadata: { demo: true, seededBy: "seed-demo" },
      input: traceInput,
      output: traceOutput,
    },
  } as IngestEvent);

  // Scores: user feedback (API), plus EVAL-style judge scores on the final generation.
  const addScore = (name: string, body: Record<string, unknown>, atMs: number) => {
    const id = `demo-score-${traceId}-${name}`;
    ctx.events.push({
      id: `evt-${id}`,
      timestamp: iso(atMs),
      type: "score-create",
      body: { id, traceId, name, timestamp: iso(atMs), environment, ...body },
    } as IngestEvent);
  };
  if (rng() < 0.4) {
    const positive = rng() < (isError ? 0.25 : 0.85);
    addScore(
      "user-feedback",
      { source: "API", dataType: "BOOLEAN", value: positive ? 1 : 0 },
      cursor + randInt(rng, 5_000, 120_000),
    );
  }
  if (rng() < 0.25) {
    const base = isError ? 0.15 + rng() * 0.3 : 0.6 + rng() ** 2 * 0.4;
    addScore(
      "answer-relevance",
      {
        source: "EVAL",
        dataType: "NUMERIC",
        value: Math.round(base * 100) / 100,
        comment: pick(rng, EVAL_COMMENTS),
        observationId: finalGenerationId,
      },
      cursor + randInt(rng, 1_000, 10_000),
    );
  }
  if (rng() < 0.1) {
    addScore(
      "sentiment",
      {
        source: "EVAL",
        dataType: "CATEGORICAL",
        stringValue: weightedPick(rng, [
          ["positive", 0.6],
          ["neutral", 0.3],
          ["negative", 0.1],
        ] as const),
      },
      cursor + randInt(rng, 1_000, 10_000),
    );
  }

  return ctx.events;
}

/** Weekday dip + linear growth toward today + deterministic jitter. */
function tracesForDay(dayIndex: number, dayStartMs: number): number {
  const dow = new Date(dayStartMs).getUTCDay();
  const weekday = dow === 0 || dow === 6 ? 0.45 : 1;
  const growth = 0.6 + 0.4 * (1 - dayIndex / Math.max(1, DAYS - 1));
  const jitter = 0.9 + mulberry32(fnv1a(`${SEED}:day:${dayIndex}`))() * 0.2;
  return Math.max(1, Math.round(TRACES_PER_DAY * weekday * growth * jitter));
}

// ── Batching + sending ──────────────────────────────────────────────────────────

const MAX_BATCH_EVENTS = 1000;
const MAX_BATCH_BYTES = 10 * 1024 * 1024; // stay well under the API's 12 MB body limit

function packBatches(events: IngestEvent[]): IngestEvent[][] {
  const batches: IngestEvent[][] = [];
  let current: IngestEvent[] = [];
  let bytes = 0;
  for (const event of events) {
    const size = JSON.stringify(event).length;
    if (current.length >= MAX_BATCH_EVENTS || (bytes + size > MAX_BATCH_BYTES && current.length > 0)) {
      batches.push(current);
      current = [];
      bytes = 0;
    }
    current.push(event);
    bytes += size;
  }
  if (current.length > 0) batches.push(current);
  return batches;
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

async function chNumber(query: string): Promise<number> {
  const rs = await clickhouse().query({ query, format: "JSONEachRow" });
  const rows = (await rs.json()) as Record<string, string>[];
  return Number(Object.values(rows[0] ?? {})[0] ?? 0);
}

/**
 * Waits until this run's rows are queryable in ClickHouse (the ground truth), then prints
 * counts + total cost. Deliberately does NOT wait for the ingest queue to drain: online
 * evaluators fan out one follow-up score job per sampled trace, so at this volume the queue
 * stays busy long after the seeded rows have landed.
 */
async function verifyCounts(expected: { traces: number; observations: number; scores: number }): Promise<void> {
  const deadline = Date.now() + 5 * 60_000;
  let last = { traces: 0, observations: 0, scores: 0 };
  for (;;) {
    last = {
      traces: await chNumber("SELECT count() FROM traces FINAL WHERE id LIKE 'demo-trace-%'"),
      observations: await chNumber("SELECT count() FROM observations FINAL WHERE id LIKE 'demo-obs-%'"),
      scores: await chNumber("SELECT count() FROM scores FINAL WHERE id LIKE 'demo-score-%'"),
    };
    if (last.traces >= expected.traces && last.observations >= expected.observations && last.scores >= expected.scores)
      break;
    if (Date.now() > deadline) {
      console.warn("  seeded rows not fully visible after 5 minutes — the worker may be down or backlogged");
      break;
    }
    await Bun.sleep(2000);
  }
  const cost = await chNumber("SELECT round(sum(total_cost), 2) FROM observations FINAL WHERE id LIKE 'demo-obs-%'");
  console.log("\nClickHouse (all demo rows, incl. prior runs):");
  console.log(`  traces       : ${last.traces} (this run generated ${expected.traces})`);
  console.log(`  observations : ${last.observations} (this run generated ${expected.observations})`);
  console.log(`  scores       : ${last.scores} (this run generated ${expected.scores})`);
  console.log(`  total cost   : $${cost}`);
}

/**
 * Deletes all demo rows from a previous run, then rebuilds the observations_daily rollup —
 * aggregate states can't be selectively deleted, and the MV only fires on insert, so stale
 * demo aggregates would otherwise keep haunting the dashboards.
 */
async function wipeDemoRows(): Promise<void> {
  console.log("Wiping previous demo rows...");
  const ch = clickhouse();
  const sync = { mutations_sync: "1" } as const;
  await ch.command({ query: "ALTER TABLE traces DELETE WHERE id LIKE 'demo-trace-%'", clickhouse_settings: sync });
  await ch.command({ query: "ALTER TABLE observations DELETE WHERE id LIKE 'demo-obs-%'", clickhouse_settings: sync });
  // Online-evaluator writeback scores carry generated ids but reference demo traces — match on trace_id.
  await ch.command({
    query: "ALTER TABLE scores DELETE WHERE trace_id LIKE 'demo-trace-%'",
    clickhouse_settings: sync,
  });
  // Keep this SELECT in sync with observations_daily_mv in infra/clickhouse/0001_init.sql.
  await ch.command({ query: "TRUNCATE TABLE observations_daily" });
  await ch.command({
    query: `INSERT INTO observations_daily
      SELECT project_id, toDate(start_time) AS date, environment, model,
             countState(toUInt64(1)) AS observations, sumState(total_tokens) AS total_tokens,
             sumState(total_cost) AS total_cost, quantilesState(0.5, 0.95, 0.99)(latency_ms) AS latency_ms
      FROM observations FINAL WHERE type = 'GENERATION'
      GROUP BY project_id, date, environment, model`,
  });
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
  if (WIPE && !DRY_RUN) await wipeDemoRows();
  const generated = { traces: 0, observations: 0, scores: 0, events: 0, batches: 0 };
  let perDayMin = Number.POSITIVE_INFINITY;
  let perDayMax = 0;

  for (let day = DAYS - 1; day >= 0; day--) {
    const dayStartMs = Math.floor(NOW / DAY_MS) * DAY_MS - day * DAY_MS; // UTC midnight
    const dayCutoffMs = Math.min(dayStartMs + DAY_MS, NOW - 120_000);
    const traceCount = tracesForDay(day, dayStartMs);
    perDayMin = Math.min(perDayMin, traceCount);
    perDayMax = Math.max(perDayMax, traceCount);

    const events: IngestEvent[] = [];
    for (let i = 0; i < traceCount; i++) events.push(...makeTrace(day, i, dayStartMs, dayCutoffMs));
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
    console.log("\nWaiting for the seeded rows to land in ClickHouse...");
    await verifyCounts({ traces: generated.traces, observations: generated.observations, scores: generated.scores });
    await reportQueueState();
    await clickhouse().close();
  }
  console.log("\nDone. Open http://localhost:3000 — dashboards default to the last 30 days.");
}

main().catch((err) => {
  console.error("seed:demo failed:", err);
  process.exit(1);
});
