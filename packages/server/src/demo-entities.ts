import { type PromptType, prisma } from "@memoturn/db";
import { telemetry } from "@memoturn/telemetry";
import { createAlertRule, setCostBudget } from "./alerts.js";
import { setAnalyticsSink } from "./analytics.js";
import { createAutomation } from "./automations.js";
import { addDatasetItems, createDataset, createDatasetVersion, type DatasetItemInput, recordRun } from "./datasets.js";
import { createEvaluator } from "./evaluators.js";
import { createPromptVersion } from "./prompts.js";
import { addReviewItems, createReviewQueue } from "./review.js";
import { createWebhook } from "./webhooks.js";

/**
 * Populate EVERY non-telemetry product entity for a demo-sandbox project so the whole
 * console UI is alive: prompts (+versions), datasets (+items +a cut version), evaluators,
 * experiments (+item results wired to real seeded traces), monitors (alert rules + state),
 * a cost budget, automations, review queues (+items), and a disabled webhook / analytics sink.
 *
 * Called by `seedSandbox` AFTER the telemetry batches are submitted — entities that need
 * real trace ids query whatever telemetry already landed in the store. Deterministic per
 * project (RNG seeded from projectId) and idempotent: every group either upserts by a stable
 * name or checks existence first, so re-seeding the same project never collides. Each group
 * is best-effort (its own try/catch) — one failing group never aborts the rest, and the whole
 * function is designed to NEVER throw the sandbox into a FAILED state (telemetry is the
 * critical part; entities are cosmetic).
 */

// ── Deterministic PRNG (same shape as demodata.ts) ────────────────────────────────
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
const pick = <T>(rng: Rng, arr: readonly T[]): T => arr[Math.floor(rng() * arr.length)] as T;

/** Best-effort wrapper: log and swallow so one failing group never aborts the rest. */
async function group(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    console.error(`[demo-entities] ${name} failed:`, err instanceof Error ? err.message : err);
  }
}

// ── Content pools ─────────────────────────────────────────────────────────────────
const QA_PAIRS: readonly (readonly [string, string])[] = [
  [
    "How do I reset my password?",
    "Go to Settings → Security → Reset password; a confirmation link arrives within a minute.",
  ],
  [
    "Why was my card charged twice?",
    "The second entry is a temporary authorization hold that drops off in 3-5 business days.",
  ],
  [
    "Can I export my data as CSV?",
    "Yes — open the table view and use Export → CSV. Exports over 10k rows are emailed to you.",
  ],
  [
    "How do I invite a teammate?",
    "From the Organization page, click Invite member, enter their email, and pick a role.",
  ],
  [
    "Does the API support pagination?",
    "Yes, list endpoints accept `page` and `limit` (max 500) and return a `total` count.",
  ],
  [
    "My webhook stopped firing, what should I check?",
    "Check the delivery log for recent 4xx/5xx and verify the signing secret.",
  ],
  [
    "What's the difference between staging and production keys?",
    "Staging keys write to an isolated environment; nothing crosses into production data.",
  ],
  [
    "How long are traces retained?",
    "Retention defaults to 30 days and is configurable per project under Settings → Retention.",
  ],
  ["Can I self-host this?", "Yes — the whole stack ships as a Docker Compose file; see the deployment docs."],
  [
    "Why is my dashboard empty?",
    "Data is ingested asynchronously — allow a few seconds, and confirm the project selector matches your key.",
  ],
  [
    "How do I rotate an API key?",
    "Create a new key, deploy it, then revoke the old one from the API Keys page — revocation is immediate.",
  ],
  [
    "Is there a rate limit on ingestion?",
    "Hosted projects meter events per minute and return 429 with a Retry-After header.",
  ],
  [
    "How do I filter traces by user?",
    "Use the filter builder on the Traces page and add a `user_id` equals condition.",
  ],
  [
    "Can I compare two prompt versions?",
    "Yes — open the prompt and use the A/B split, or run an experiment across both versions.",
  ],
  [
    "What models are supported in the playground?",
    "Any provider you've connected under Settings → Providers, plus the built-in mock provider.",
  ],
  [
    "How are costs calculated?",
    "Costs are computed from token usage against the model price registry, per generation.",
  ],
  [
    "Do you support OpenTelemetry?",
    "Yes — point your OTLP exporter at /v1/otel and spans map to traces automatically.",
  ],
  [
    "How do I set up an alert?",
    "Create a monitor under Monitors, pick a metric and threshold, and add a notification channel.",
  ],
  [
    "Can I annotate a trace manually?",
    "Open the trace and add an annotation score, or route it through a review queue.",
  ],
  [
    "How do I score model outputs automatically?",
    "Create an evaluator (LLM-as-judge or heuristic) and enable it online with a sampling rate.",
  ],
] as const;

const AGENT_TASKS: readonly (readonly [string, string])[] = [
  ["Look up order #4471 and tell me its status", "Order #4471 shipped on the 12th and is out for delivery today."],
  [
    "Draft a reply apologizing for a late shipment",
    "Hi — apologies for the delay on your order; it's now in transit and should arrive tomorrow.",
  ],
  ["Find the customer's most recent invoice", "The most recent invoice is #INV-2098, dated last Tuesday, for $84.00."],
  [
    "Summarize the open tickets for account ACME",
    "ACME has 3 open tickets: a billing question, a webhook retry, and a feature request.",
  ],
  [
    "Check whether refund policy allows a 45-day return",
    "The standard policy is 30 days; a 45-day return requires a manager override.",
  ],
  [
    "Escalate this conversation to a human agent",
    "I've escalated this to a human agent; someone will follow up within the hour.",
  ],
  [
    "Search the knowledge base for SSO setup",
    "SSO is configured under Organization → SSO by registering your OIDC/SAML provider.",
  ],
  [
    "Cancel the pending subscription change",
    "The pending plan change has been cancelled; your current plan continues unchanged.",
  ],
  [
    "What is the total spend this month for this project?",
    "Month-to-date spend for this project is $312.40 across 6 models.",
  ],
  [
    "Compile a list of failing evaluators",
    "Two evaluators are below threshold this week: answer-relevance and correctness.",
  ],
  ["Reset the demo environment", "The demo environment has been reset; fresh sample data is loading now."],
  [
    "Explain why a trace was marked as an error",
    "The final generation returned an upstream timeout after 30000ms and was marked ERROR.",
  ],
] as const;

// ── Prompts ───────────────────────────────────────────────────────────────────────
interface PromptSpec {
  name: string;
  type: PromptType;
  versions: { content: unknown; config?: Record<string, unknown>; labels?: string[] }[];
  folder?: string;
}

const PROMPT_SPECS: PromptSpec[] = [
  {
    name: "chat-completion",
    type: "CHAT",
    folder: "support",
    versions: [
      {
        content: [
          { role: "system", content: "You are a concise, friendly support assistant." },
          { role: "user", content: "{{question}}" },
        ],
        config: { provider: "mock", temperature: 0.3 },
      },
      {
        content: [
          {
            role: "system",
            content: "You are a concise, friendly support assistant. Cite the relevant setting when possible.",
          },
          { role: "user", content: "{{question}}" },
        ],
        config: { provider: "mock", temperature: 0.2 },
        labels: ["production"],
      },
      {
        content: [
          {
            role: "system",
            content: "You are a support assistant. Answer in <=3 sentences and never invent product features.",
          },
          { role: "user", content: "{{question}}" },
        ],
        config: { provider: "mock", temperature: 0.2 },
      },
    ],
  },
  {
    name: "rag-pipeline",
    type: "CHAT",
    folder: "support",
    versions: [
      {
        content: [
          {
            role: "system",
            content: "Answer using ONLY the retrieved context. If unsure, say so.\n\nContext:\n{{context}}",
          },
          { role: "user", content: "{{question}}" },
        ],
        config: { provider: "mock", temperature: 0.1 },
      },
      {
        content: [
          {
            role: "system",
            content:
              "You are a grounded RAG assistant. Use the context; quote the source id you relied on.\n\nContext:\n{{context}}",
          },
          { role: "user", content: "{{question}}" },
        ],
        config: { provider: "mock", temperature: 0.1 },
        labels: ["production", "staging"],
      },
    ],
  },
  {
    name: "agent-loop",
    type: "TEXT",
    folder: "agents",
    versions: [
      {
        content: "You are an autonomous support agent. Plan, call tools, and finalize when you have the answer.",
        config: { provider: "mock" },
      },
      {
        content:
          "You are an autonomous support agent. Think step by step, prefer tools over guessing, and stop as soon as the goal is met.",
        config: { provider: "mock" },
        labels: ["staging"],
      },
    ],
  },
  {
    name: "summarizer",
    type: "TEXT",
    folder: "utility",
    versions: [
      { content: "Summarize the conversation below in 2 sentences.\n\n{{transcript}}", config: { provider: "mock" } },
      {
        content:
          "Summarize the conversation below in 2 sentences, highlighting the customer's unresolved need.\n\n{{transcript}}",
        config: { provider: "mock" },
        labels: ["production"],
      },
    ],
  },
  {
    name: "support-reply",
    type: "CHAT",
    folder: "support",
    versions: [
      {
        content: [
          { role: "system", content: "Draft a warm, professional support reply grounded in the retrieved docs." },
          { role: "user", content: "{{question}}" },
        ],
        config: { provider: "mock", temperature: 0.4 },
        labels: ["production"],
      },
      {
        content: [
          {
            role: "system",
            content:
              "Draft a warm, professional support reply. Keep it under 4 sentences and end with a clear next step.",
          },
          { role: "user", content: "{{question}}" },
        ],
        config: { provider: "mock", temperature: 0.3 },
        labels: ["production"],
      },
    ],
  },
];

async function seedPrompts(projectId: string): Promise<void> {
  for (const spec of PROMPT_SPECS) {
    await group(`prompt:${spec.name}`, async () => {
      // Idempotency: createPromptVersion always appends a version, so skip a prompt that
      // already has any versions (a re-seed shouldn't keep bumping version numbers).
      const existing = await prisma.prompt.findUnique({
        where: { projectId_name: { projectId, name: spec.name } },
        include: { _count: { select: { versions: true } } },
      });
      if (existing && existing._count.versions > 0) return;
      for (const v of spec.versions) {
        await createPromptVersion(projectId, {
          name: spec.name,
          type: spec.type,
          content: v.content,
          config: v.config,
          folder: spec.folder,
          labels: v.labels,
        });
      }
    });
  }
}

// ── Datasets ──────────────────────────────────────────────────────────────────────
async function seedDatasets(projectId: string): Promise<string[]> {
  const created: string[] = [];
  const specs: { name: string; description: string; items: DatasetItemInput[] }[] = [
    {
      name: "support-qa",
      description: "Curated support Q&A pairs for regression testing the chat assistant.",
      items: QA_PAIRS.slice(0, 15).map(([q, a], i) => ({
        input: { question: q },
        expectedOutput: a,
        metadata: { source: "curated", topic: i % 6 },
      })),
    },
    {
      name: "rag-eval-set",
      description: "Grounded question set for evaluating the RAG pipeline's faithfulness.",
      items: QA_PAIRS.slice(0, 18).map(([q, a], i) => ({
        input: { question: q, context: "See the configuration reference for the relevant setting." },
        expectedOutput: a,
        metadata: { source: "kb", hasContext: true, topic: i % 6 },
      })),
    },
    {
      name: "agent-tasks",
      description: "Multi-step agent tasks that exercise tool use and finalization.",
      items: AGENT_TASKS.slice(0, 12).map(([goal, expected], i) => ({
        input: { goal },
        expectedOutput: expected,
        metadata: { source: "synthetic", steps: 2 + (i % 3) },
      })),
    },
  ];

  for (const spec of specs) {
    await group(`dataset:${spec.name}`, async () => {
      await createDataset(projectId, { name: spec.name, description: spec.description });
      created.push(spec.name);
      // Only add items when the dataset is empty (addDatasetItems always inserts new rows).
      const ds = await prisma.dataset.findUnique({
        where: { projectId_name: { projectId, name: spec.name } },
        include: { _count: { select: { items: true, versions: true } } },
      });
      if (ds && ds._count.items === 0) await addDatasetItems(projectId, spec.name, spec.items);
      // Cut a v1 snapshot only if none exists yet.
      const after = await prisma.dataset.findUnique({
        where: { projectId_name: { projectId, name: spec.name } },
        include: { _count: { select: { versions: true } } },
      });
      if (after && after._count.versions === 0)
        await createDatasetVersion(projectId, spec.name, { label: "v1 baseline" });
    });
  }
  return created;
}

// ── Evaluators ──────────────────────────────────────────────────────────────────
// createEvaluator upserts by name and only version-bumps on a config change, so this is
// naturally idempotent. There is no first-class "heuristic/code vs LLM" type in the schema —
// every evaluator is a prompt + model judge; the "heuristic" ones just run a rule-style prompt
// on the mock provider (a real deploy would point them at a code runner / cheap model).
async function seedEvaluators(projectId: string): Promise<string[]> {
  const evaluators: {
    name: string;
    prompt: string;
    model: string;
    online?: boolean;
    samplingRate?: number;
    scope?: string;
  }[] = [
    {
      name: "correctness",
      prompt:
        "Judge whether the output is factually correct given the input and expected answer. 1 = correct, 0 = wrong.",
      model: "mock-gpt-4o",
      online: true,
      samplingRate: 0.5,
    },
    {
      name: "answer-relevance",
      prompt:
        "Rate how directly the output answers the user's question, ignoring style. 1 = fully on-topic, 0 = off-topic.",
      model: "mock-gpt-4o",
      online: true,
      samplingRate: 0.4,
    },
    {
      name: "toxicity",
      prompt: "Heuristic check: return 0 if the output contains insults, slurs, or hostile language, else 1.",
      model: "mock-heuristic",
    },
    {
      name: "pii-leak",
      prompt: "Heuristic check: return 0 if the output leaks emails, phone numbers, or card numbers, else 1.",
      model: "mock-heuristic",
    },
    {
      name: "sentiment",
      prompt: "Classify the assistant's tone. Score 1 for warm/helpful, 0.5 for neutral, 0 for curt/negative.",
      model: "mock-gpt-4o",
    },
    {
      name: "conversation-resolution",
      prompt:
        "Given a whole conversation transcript, judge whether the user's issue was resolved. 1 = resolved, 0 = unresolved.",
      model: "mock-gpt-4o",
      online: true,
      scope: "thread",
    },
  ];

  const names: string[] = [];
  for (const ev of evaluators) {
    await group(`evaluator:${ev.name}`, async () => {
      await createEvaluator(projectId, {
        name: ev.name,
        prompt: ev.prompt,
        provider: "mock",
        model: ev.model,
        online: ev.online,
        samplingRate: ev.samplingRate,
        scope: ev.scope,
      });
      names.push(ev.name);
    });
  }
  return names;
}

// ── Experiments ─────────────────────────────────────────────────────────────────
// createExperiment enqueues an async worker job (runs the playground per item) — unsuitable
// for standalone seeding, which has no worker draining the queue. Instead we build a
// COMPLETED experiment directly via Prisma, mark every ExperimentItemResult DONE against a
// real seeded trace, and recordRun() a matching DatasetRun so the dataset-comparison / detail
// views render the traces' existing (seeded) scores. Idempotent via the [datasetId, name] key.
async function seedExperiments(
  projectId: string,
  datasetNames: string[],
  evaluatorNames: string[],
  traceIds: string[],
  rng: Rng,
): Promise<void> {
  if (datasetNames.length === 0 || traceIds.length === 0) return;
  const plans: { experiment: string; dataset: string; model: string; promptName: string; evaluators: string[] }[] = [
    {
      experiment: "chat-baseline-vs-v2",
      dataset: "support-qa",
      model: "mock-gpt-4o",
      promptName: "chat-completion",
      evaluators: evaluatorNames.slice(0, 2),
    },
    {
      experiment: "rag-faithfulness-run",
      dataset: "rag-eval-set",
      model: "mock-gpt-4o-mini",
      promptName: "rag-pipeline",
      evaluators: evaluatorNames.slice(0, 3),
    },
    {
      experiment: "agent-tool-use-run",
      dataset: "agent-tasks",
      model: "mock-claude-sonnet",
      promptName: "agent-loop",
      evaluators: evaluatorNames.slice(0, 1),
    },
  ];

  for (const plan of plans) {
    if (!datasetNames.includes(plan.dataset)) continue;
    await group(`experiment:${plan.experiment}`, async () => {
      const dataset = await prisma.dataset.findUnique({
        where: { projectId_name: { projectId, name: plan.dataset } },
        include: { items: { orderBy: { createdAt: "asc" } } },
      });
      if (!dataset || dataset.items.length === 0) return;
      const dupe = await prisma.experiment.findUnique({
        where: { datasetId_name: { datasetId: dataset.id, name: plan.experiment } },
      });
      if (dupe) return;

      // Assign each dataset item a (deterministic) seeded trace so scores render.
      const links = dataset.items.map((it) => ({ datasetItemId: it.id, traceId: pick(rng, traceIds) }));

      await prisma.experiment.create({
        data: {
          projectId,
          datasetId: dataset.id,
          name: plan.experiment,
          status: "COMPLETED",
          provider: "mock",
          model: plan.model,
          params: { temperature: 0.2 } as object,
          promptName: plan.promptName,
          promptChannel: "production",
          promptVersion: 1,
          evaluators: plan.evaluators,
          totalItems: dataset.items.length,
          completedItems: dataset.items.length,
          failedItems: 0,
          startedAt: new Date(Date.now() - 3_600_000),
          completedAt: new Date(Date.now() - 3_000_000),
          items: {
            create: links.map((l) => ({
              datasetItemId: l.datasetItemId,
              status: "DONE",
              traceId: l.traceId,
              attempts: 1,
            })),
          },
        },
      });
      // The DatasetRun (named after the experiment) is what the comparison view reads.
      await recordRun(projectId, plan.dataset, plan.experiment, links);
    });
  }
}

// ── Monitors (alert rules + state) + cost budget ──────────────────────────────────
async function seedMonitors(projectId: string): Promise<void> {
  const rules: {
    name: string;
    metric: string;
    window: number;
    threshold: number;
    comparator: string;
    firing?: boolean;
    lastValue: number;
  }[] = [
    {
      name: "High error rate",
      metric: "error_rate",
      window: 15,
      threshold: 0.05,
      comparator: "gt",
      firing: true,
      lastValue: 0.082,
    },
    { name: "P95 latency SLO", metric: "latency_p95", window: 10, threshold: 4000, comparator: "gt", lastValue: 2450 },
    {
      name: "Daily cost ceiling",
      metric: "cost_per_day",
      window: 1440,
      threshold: 25,
      comparator: "gt",
      firing: true,
      lastValue: 31.4,
    },
    {
      name: "Ingest dead-letter backlog",
      metric: "dlq_depth",
      window: 5,
      threshold: 10,
      comparator: "gt",
      lastValue: 0,
    },
  ];

  for (const r of rules) {
    await group(`monitor:${r.name}`, async () => {
      const existing = await prisma.alertRule.findFirst({ where: { projectId, name: r.name }, select: { id: true } });
      const ruleId =
        existing?.id ??
        (
          await createAlertRule(projectId, {
            name: r.name,
            metric: r.metric as never,
            window: r.window,
            threshold: r.threshold,
            comparator: r.comparator as never,
            channels: [],
            enabled: true,
          })
        ).id;
      // AlertState is normally written by the worker cron; seed it so the Monitors list shows status.
      await prisma.alertState.upsert({
        where: { ruleId },
        update: {
          status: r.firing ? "firing" : "ok",
          lastValue: r.lastValue,
          lastFiredAt: r.firing ? new Date(Date.now() - 600_000) : null,
        },
        create: {
          ruleId,
          status: r.firing ? "firing" : "ok",
          lastValue: r.lastValue,
          lastFiredAt: r.firing ? new Date(Date.now() - 600_000) : null,
        },
      });
    });
  }

  await group("cost-budget", async () => {
    await setCostBudget(projectId, { monthlyUsd: 500, thresholds: [0.5, 0.8, 1.0], channels: [] });
  });
}

// ── Automations ───────────────────────────────────────────────────────────────────
async function seedAutomations(projectId: string): Promise<void> {
  const automations: {
    name: string;
    trigger: string;
    action: string;
    target: string;
    threshold?: number | null;
    filter?: string;
  }[] = [
    {
      name: "Slack on low score",
      trigger: "score.created",
      action: "slack",
      target: "https://hooks.slack.example.com/services/T000/B000/demo",
      threshold: 0.3,
    },
    {
      name: "Webhook on new eval",
      trigger: "eval.completed",
      action: "webhook",
      target: "https://ops.example.com/webhooks/memoturn-evals",
    },
    {
      name: "Slack on error trace",
      trigger: "trace.created",
      action: "slack",
      target: "https://hooks.slack.example.com/services/T000/B001/demo",
      filter: "agent",
    },
  ];
  for (const a of automations) {
    await group(`automation:${a.name}`, async () => {
      const existing = await prisma.automation.findFirst({ where: { projectId, name: a.name }, select: { id: true } });
      if (existing) return;
      await createAutomation(projectId, {
        name: a.name,
        trigger: a.trigger,
        action: a.action,
        target: a.target,
        threshold: a.threshold ?? null,
        filter: a.filter,
      });
    });
  }
}

// ── Review queues (+items) ─────────────────────────────────────────────────────────
async function seedReviewQueues(projectId: string, traceIds: string[], rng: Rng): Promise<void> {
  const queues: {
    name: string;
    description: string;
    scoreName: string;
    dataType: "NUMERIC" | "CATEGORICAL" | "BOOLEAN" | "TEXT";
    count: number;
  }[] = [
    {
      name: "Human quality review",
      description: "Manually rate assistant answers on a 0-1 quality scale.",
      scoreName: "human-quality",
      dataType: "NUMERIC",
      count: 15,
    },
    {
      name: "Escalation review",
      description: "Flag conversations that should have been escalated to a human.",
      scoreName: "needs-escalation",
      dataType: "BOOLEAN",
      count: 12,
    },
  ];
  for (const q of queues) {
    await group(`review-queue:${q.name}`, async () => {
      await createReviewQueue(projectId, {
        name: q.name,
        description: q.description,
        scoreName: q.scoreName,
        dataType: q.dataType,
      });
      if (traceIds.length === 0) return; // create the queue gracefully even with no traces yet
      // Deterministic distinct sample of trace ids (addReviewItems dedups on re-seed).
      const pool = [...traceIds];
      const chosen: string[] = [];
      for (let i = 0; i < q.count && pool.length > 0; i++) {
        chosen.push(pool.splice(Math.floor(rng() * pool.length), 1)[0] as string);
      }
      await addReviewItems(projectId, q.name, chosen);
    });
  }
}

// ── Settings examples (disabled webhook + analytics sink) ──────────────────────────
async function seedSettingsExamples(projectId: string): Promise<void> {
  await group("webhook-example", async () => {
    const url = "https://ops.example.com/webhooks/memoturn-scores";
    const existing = await prisma.webhook.findFirst({ where: { projectId, url }, select: { id: true } });
    if (existing) return;
    const w = await createWebhook(projectId, { url, event: "score.created", threshold: 0.3 });
    // Ship it DISABLED so the demo shows a configured-but-inert example (no real deliveries).
    await prisma.webhook.updateMany({ where: { projectId, id: w.id }, data: { enabled: false } });
  });

  await group("analytics-sink-example", async () => {
    await setAnalyticsSink(projectId, {
      enabled: false,
      host: "https://us.i.posthog.com",
      apiKey: "phc_demo_example_key",
    });
  });
}

/**
 * Seed every non-telemetry product entity for one project. Resolves everything from the
 * projectId alone (queries the telemetry store for real trace ids), so it can be invoked
 * standalone against any existing project. Best-effort and idempotent; never throws.
 */
export async function seedSandboxEntities(projectId: string): Promise<void> {
  const rng = mulberry32(fnv1a(`entities:${projectId}`));

  // Real trace ids for the entities that reference telemetry (experiments, review queues).
  let traceIds: string[] = [];
  try {
    const traces = await telemetry().listTraces(projectId, { limit: 300 });
    traceIds = traces.map((t) => t.id);
  } catch (err) {
    console.error("[demo-entities] listTraces failed:", err instanceof Error ? err.message : err);
  }

  await seedPrompts(projectId);
  const datasetNames = await seedDatasets(projectId);
  const evaluatorNames = await seedEvaluators(projectId);
  await seedExperiments(projectId, datasetNames, evaluatorNames, traceIds, rng);
  await seedMonitors(projectId);
  await seedAutomations(projectId);
  await seedReviewQueues(projectId, traceIds, rng);
  await seedSettingsExamples(projectId);
}
