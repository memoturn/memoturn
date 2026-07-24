import type { IngestEvent } from "@memoturn/core";

/**
 * Deterministic generator for realistic demo telemetry — traces with nested spans,
 * generations, tool calls, retrieval documents, embeddings, and scores.
 *
 * Extracted from scripts/seed-demo.ts so it can be driven from two places:
 *  - the CLI (`bun run seed:demo`), which streams day-by-day and POSTs to /v1/ingest
 *  - the worker's demo-sandbox seeder, which calls submitBatch() directly
 *
 * Everything here is PURE: no env reads, no I/O, no module-level clock. All inputs come
 * from `DemoDataConfig`, so a given (seed, days, tracesPerDay, now) always produces the
 * same events — which is what makes re-seeding idempotent under the store's
 * last-writer-wins merge.
 */

/** Generation parameters. `now` anchors the backdated window (defaults to call time). */
export interface DemoDataConfig {
  days: number;
  tracesPerDay: number;
  seed: string;
  now?: number;
}

type Cfg = Required<DemoDataConfig>;

function resolveCfg(cfg: DemoDataConfig): Cfg {
  return {
    days: Math.max(1, Math.floor(cfg.days)),
    tracesPerDay: Math.max(1, Math.floor(cfg.tracesPerDay)),
    seed: cfg.seed,
    now: cfg.now ?? Date.now(),
  };
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

// ── RAG demo helpers: retrieved documents + topic-clustered embeddings ───────────
const NUM_TOPICS = 6;
const EMBED_DIM = 16;
const DOC_SOURCES = ["kb://faq", "kb://docs", "web://blog", "kb://runbook"] as const;
const DOC_SNIPPETS = [
  "See the configuration reference for the relevant setting.",
  "This behavior changed in a recent release; check the migration notes.",
  "The retriever ranks candidates by cosine similarity over embeddings.",
  "Rate limits apply per project; increase them in settings.",
  "Costs are computed from token usage against the model price registry.",
  "Traces group by session id; users group by user id.",
] as const;

/** Deterministic topic id for a question (so embeddings form visible clusters). */
function topicOf(question: string): number {
  return fnv1a(question) % NUM_TOPICS;
}

/** A demo embedding centered on the question's topic cluster, plus small noise. */
function demoEmbedding(rng: Rng, topic: number): number[] {
  return Array.from({ length: EMBED_DIM }, (_, i) => Math.sin(topic * 1.3 + i * 0.7) + (rng() - 0.5) * 0.3);
}

/** N retrieved documents with descending relevance scores. */
function makeRetrievedDocs(rng: Rng, question: string, n: number) {
  const topic = topicOf(question);
  return Array.from({ length: n }, (_, i) => ({
    rank: i,
    score: Math.max(0, Number((0.95 - i * 0.15 - rng() * 0.05).toFixed(4))),
    content: `${pick(rng, DOC_SNIPPETS)} (re: ${question.slice(0, 40)})`,
    id: `doc-${topic}-${i}`,
    metadata: { source: pick(rng, DOC_SOURCES) },
  }));
}

/** Builds all ingest events for one trace. Fully deterministic from (SEED, dayIndex, traceIndex). */
export function makeTrace(
  cfg: Cfg,
  dayIndex: number,
  traceIndex: number,
  dayStartMs: number,
  dayCutoffMs: number,
): IngestEvent[] {
  const rng = mulberry32(fnv1a(`${cfg.seed}:${dayIndex}:${traceIndex}`));
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
      embedding: demoEmbedding(rng, topicOf(question)),
      ...gen.body,
    });
    cursor += gen.durationMs;
  } else if (scenario === "rag-pipeline") {
    const retrieveMs = randInt(rng, 40, 280);
    const numDocs = randInt(rng, 2, 5);
    const spanId = addObservation(ctx, "span-create", cursor, cursor + retrieveMs, {
      name: "retrieve-docs",
      input: { query: question, topK: 5 },
      output: { hits: numDocs },
      retrievedDocuments: makeRetrievedDocs(rng, question, numDocs),
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
      embedding: demoEmbedding(rng, topicOf(question)),
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

  const releaseIdx = Math.min(
    RELEASES.length - 1,
    Math.floor((1 - dayIndex / Math.max(1, cfg.days)) * RELEASES.length),
  );
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
export function tracesForDay(cfg: Cfg, dayIndex: number, dayStartMs: number): number {
  const dow = new Date(dayStartMs).getUTCDay();
  const weekday = dow === 0 || dow === 6 ? 0.45 : 1;
  const growth = 0.6 + 0.4 * (1 - dayIndex / Math.max(1, cfg.days - 1));
  const jitter = 0.9 + mulberry32(fnv1a(`${cfg.seed}:day:${dayIndex}`))() * 0.2;
  return Math.max(1, Math.round(cfg.tracesPerDay * weekday * growth * jitter));
}

// ── Batching + sending ──────────────────────────────────────────────────────────

const MAX_BATCH_EVENTS = 1000;
const MAX_BATCH_BYTES = 10 * 1024 * 1024; // stay well under the API's 12 MB body limit

export function packBatches(events: IngestEvent[]): IngestEvent[][] {
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

// ── Public API ──────────────────────────────────────────────────────────────────

/** UTC-midnight window for `dayIndex` days ago; the cutoff never runs into the future. */
export function demoDayWindow(cfg: DemoDataConfig, dayIndex: number): { dayStartMs: number; dayCutoffMs: number } {
  const c = resolveCfg(cfg);
  const dayStartMs = Math.floor(c.now / DAY_MS) * DAY_MS - dayIndex * DAY_MS;
  return { dayStartMs, dayCutoffMs: Math.min(dayStartMs + DAY_MS, c.now - 120_000) };
}

/** All ingest events for one backdated day (oldest day = `cfg.days - 1`). */
export function generateDemoDay(cfg: DemoDataConfig, dayIndex: number): IngestEvent[] {
  const c = resolveCfg(cfg);
  const { dayStartMs, dayCutoffMs } = demoDayWindow(c, dayIndex);
  const count = tracesForDay(c, dayIndex, dayStartMs);
  const events: IngestEvent[] = [];
  for (let i = 0; i < count; i++) events.push(...makeTrace(c, dayIndex, i, dayStartMs, dayCutoffMs));
  return events;
}

/**
 * Every day's events, pre-batched — the convenience entry point for small datasets
 * (the demo-sandbox seeder). Large runs should stream with `generateDemoDay` +
 * `packBatches` per day instead of materializing the whole set.
 */
export function generateDemoBatches(cfg: DemoDataConfig): IngestEvent[][] {
  const c = resolveCfg(cfg);
  const events: IngestEvent[] = [];
  for (let day = c.days - 1; day >= 0; day--) events.push(...generateDemoDay(c, day));
  return packBatches(events);
}

export { resolveCfg as resolveDemoConfig };
