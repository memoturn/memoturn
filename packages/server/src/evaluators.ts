import type { EvaluatorAnalytics } from "@memoturn/contracts";
import { deterministicId, EVALUATOR_TEMPLATES, getEvaluatorTemplate, isoNow, newId } from "@memoturn/core";
import { prisma } from "@memoturn/db";
import { generate, type Provider } from "@memoturn/llm";
import { telemetry } from "@memoturn/telemetry";
import { submitBatch } from "./ingest.js";
import { resolveProviderConfig } from "./providers.js";

/**
 * LLM-as-judge evaluators. An evaluator is a judge prompt + model; running it scores a
 * trace's input/output and writes the score back through the ingest pipeline
 * (source=EVAL), so it lands in the telemetry store alongside API/annotation scores.
 */
/** One member of an LLM jury: a provider + model that casts an independent judge vote. */
export interface Juror {
  provider: string;
  model: string;
}

/** Coerce the Prisma Json `jurors` column into a clean Juror[] (tolerant of legacy/bad rows). */
export function parseJurors(json: unknown): Juror[] {
  if (!Array.isArray(json)) return [];
  const out: Juror[] = [];
  for (const j of json) {
    if (j && typeof j === "object" && typeof (j as Juror).model === "string" && (j as Juror).model.length > 0) {
      out.push({ provider: String((j as Juror).provider ?? "mock"), model: (j as Juror).model });
    }
  }
  return out;
}

export interface CreateEvaluatorInput {
  name: string;
  prompt: string;
  provider?: string;
  model: string;
  online?: boolean;
  samplingRate?: number;
  filterName?: string;
  /** LLM jury members. When non-empty, the evaluator becomes an ensemble (mean of votes). */
  jurors?: Juror[];
  /** "trace" (default) scores each trace inline; "thread" scores whole settled conversations. */
  scope?: string;
  /** For scope="thread": seconds of session inactivity before the conversation is judged. */
  cooldownSeconds?: number;
}

export async function createEvaluator(projectId: string, input: CreateEvaluatorInput) {
  const provider = input.provider ?? "mock";
  const jurors = parseJurors(input.jurors ?? []);
  const data = {
    prompt: input.prompt,
    provider,
    model: input.model,
    jurors: jurors as unknown as object,
    online: input.online ?? false,
    samplingRate: input.samplingRate ?? 1.0,
    filterName: input.filterName ?? "",
    scope: input.scope === "thread" ? "thread" : "trace",
    cooldownSeconds: input.cooldownSeconds ?? 900,
  };
  // Version bump: an edit that changes the judge config (prompt/model/provider/jurors) is a
  // new immutable version; unrelated edits (toggling online, sampling) don't bump. A snapshot
  // row is written per version so score drift can be attributed to a config change.
  const ev = await prisma.$transaction(async (tx) => {
    const existing = await tx.evaluator.findUnique({ where: { projectId_name: { projectId, name: input.name } } });
    const jurorsChanged = !existing || !jurorsEqual(parseJurors(existing.jurors), jurors);
    const configChanged =
      !existing ||
      existing.prompt !== data.prompt ||
      existing.model !== data.model ||
      existing.provider !== provider ||
      jurorsChanged;
    const version = existing ? existing.version + (configChanged ? 1 : 0) : 1;
    const row = await tx.evaluator.upsert({
      where: { projectId_name: { projectId, name: input.name } },
      update: { ...data, version },
      create: { projectId, name: input.name, ...data, version },
    });
    if (configChanged) {
      await tx.evaluatorVersion.create({
        data: { evaluatorId: row.id, version, prompt: data.prompt, provider, model: data.model, jurors: data.jurors },
      });
    }
    return row;
  });
  return {
    name: ev.name,
    provider: ev.provider,
    model: ev.model,
    jurors: parseJurors(ev.jurors),
    online: ev.online,
    samplingRate: ev.samplingRate,
    filterName: ev.filterName,
    scope: ev.scope,
    cooldownSeconds: ev.cooldownSeconds,
    version: ev.version,
  };
}

function jurorsEqual(a: Juror[], b: Juror[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((x, i) => {
    const y = b[i];
    return y !== undefined && x.provider === y.provider && x.model === y.model;
  });
}

/** Immutable version history for one evaluator (newest first). */
export async function listEvaluatorVersions(projectId: string, name: string) {
  const ev = await prisma.evaluator.findUnique({
    where: { projectId_name: { projectId, name } },
    include: { versions: { orderBy: { version: "desc" } } },
  });
  if (!ev) return null;
  return ev.versions.map((v) => ({
    version: v.version,
    prompt: v.prompt,
    provider: v.provider,
    model: v.model,
    jurors: parseJurors(v.jurors),
    createdAt: v.createdAt.toISOString(),
  }));
}

export async function listEvaluators(projectId: string) {
  const evs = await prisma.evaluator.findMany({ where: { projectId }, orderBy: { name: "asc" } });
  return evs.map((e) => ({
    name: e.name,
    provider: e.provider,
    model: e.model,
    prompt: e.prompt,
    jurors: parseJurors(e.jurors),
    online: e.online,
    samplingRate: e.samplingRate,
    filterName: e.filterName,
    scope: e.scope,
    cooldownSeconds: e.cooldownSeconds,
    version: e.version,
    createdAt: e.createdAt.toISOString(),
  }));
}

/**
 * Online evaluators for a project (run automatically on sampled incoming traces). Only
 * "trace"-scope evaluators run inline at ingest; "thread"-scope ones run on a cron (see
 * `runAllThreadEvaluations`), so they're excluded here.
 */
export async function listOnlineEvaluators(projectId: string) {
  return prisma.evaluator.findMany({ where: { projectId, online: true, scope: "trace" } });
}

/** The prebuilt evaluator library (RAG/quality judge templates) — instantiate to use. */
export function listEvaluatorTemplates() {
  return EVALUATOR_TEMPLATES.map((t) => ({
    key: t.key,
    name: t.name,
    description: t.description,
    prompt: t.prompt,
    requires: t.requires,
    defaultModel: t.defaultModel ?? "",
  }));
}

export interface InstantiateTemplateInput {
  /** Override the evaluator name (defaults to the template's name). */
  name?: string;
  provider?: string;
  model?: string;
  online?: boolean;
  samplingRate?: number;
  filterName?: string;
  /** Optional LLM jury: run the template's prompt as an ensemble across these members. */
  jurors?: Juror[];
  scope?: string;
  cooldownSeconds?: number;
}

/**
 * Instantiate a prebuilt template into a real Evaluator row (a thin adapter over
 * `createEvaluator`). Returns null if the template key is unknown.
 */
export async function instantiateEvaluatorTemplate(
  projectId: string,
  key: string,
  overrides: InstantiateTemplateInput = {},
) {
  const template = getEvaluatorTemplate(key);
  if (!template) return null;
  return createEvaluator(projectId, {
    name: overrides.name ?? template.name,
    prompt: template.prompt,
    provider: overrides.provider ?? "mock",
    model: overrides.model ?? template.defaultModel ?? "mock-gpt-4o",
    online: overrides.online,
    samplingRate: overrides.samplingRate,
    filterName: overrides.filterName,
    jurors: overrides.jurors,
    scope: overrides.scope,
    cooldownSeconds: overrides.cooldownSeconds,
  });
}

/**
 * Score trends for EVAL-sourced scores (evaluator output) over the last `days`:
 * a per-evaluator summary plus a daily trend, from the telemetry store.
 */
export async function getEvaluatorAnalytics(projectId: string, days = 30): Promise<EvaluatorAnalytics> {
  const store = telemetry();
  const summary = await store.evaluatorScoreSummary(projectId, days);
  const trend = await store.evaluatorScoreTrend(projectId, days);
  return { days, summary, trend };
}

export interface RunEvaluatorInput {
  traceId: string;
  input: unknown;
  output: unknown;
  expectedOutput?: unknown;
}

function parseJudge(text: string): { score: number; reasoning: string } {
  try {
    const match = text.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(match ? match[0] : text);
    const score = Math.max(0, Math.min(1, Number(parsed.score)));
    return { score: Number.isFinite(score) ? score : 0, reasoning: String(parsed.reasoning ?? "") };
  } catch {
    return { score: 0, reasoning: text.slice(0, 500) };
  }
}

export interface JudgeInput {
  input: unknown;
  output: unknown;
  expectedOutput?: unknown;
}

export interface JudgeResult {
  evaluator: string;
  score: number;
  reasoning: string;
  /** Per-juror breakdown when this evaluator is an LLM jury (empty for a single judge). */
  votes?: { provider: string; model: string; score: number; reasoning: string }[];
}

/** Run one judge (a single provider/model) over the item and return its normalized vote. */
async function judgeOnce(
  projectId: string,
  prompt: string,
  provider: string,
  model: string,
  input: JudgeInput,
): Promise<{ score: number; reasoning: string }> {
  const config = await resolveProviderConfig(projectId, provider as Provider);
  const result = await generate({
    provider: provider as Provider,
    model,
    ...config,
    temperature: 0,
    messages: [
      {
        role: "system",
        content: `${prompt}\n\nRespond ONLY with strict JSON: {"score": <number between 0 and 1>, "reasoning": <string>}.`,
      },
      {
        role: "user",
        content: JSON.stringify({ input: input.input, output: input.output, expectedOutput: input.expectedOutput }),
      },
    ],
  });
  // mock provider can't actually judge — synthesize a deterministic score for testing.
  return provider === "mock" ? { score: 1, reasoning: result.content } : parseJudge(result.content);
}

/**
 * Run an evaluator's judge prompt and return {score, reasoning} — no telemetry write.
 * Used by `runEvaluator` (which adds the score-write) and by synchronous guard checks
 * (`runEvaluatorGuards` in guardrails.ts), which must NOT write a score per invocation:
 * a guard check can run many times per request with no natural traceId, and writing one
 * would pollute evaluator score analytics with call-count noise. Returns null when the
 * named evaluator doesn't exist for the project.
 *
 * If the evaluator defines an LLM jury (`jurors` non-empty), every juror votes independently
 * and the returned score is the MEAN of the votes (ensemble judging reduces single-judge
 * variance); the per-juror votes are attached for transparency. A juror that errors is
 * dropped so one flaky judge can't sink the panel; if every juror fails, the panel throws
 * (so the caller's retry/best-effort handling kicks in, same as a single-judge failure).
 */
export async function judgeWithEvaluator(
  projectId: string,
  name: string,
  input: JudgeInput,
): Promise<JudgeResult | null> {
  const ev = await prisma.evaluator.findUnique({ where: { projectId_name: { projectId, name } } });
  if (!ev) return null;

  const jurors = parseJurors(ev.jurors);
  if (jurors.length === 0) {
    const judged = await judgeOnce(projectId, ev.prompt, ev.provider, ev.model, input);
    return { evaluator: ev.name, ...judged };
  }

  // Jury: fan out to every member concurrently, aggregate the surviving votes by mean.
  const settled = await Promise.allSettled(
    jurors.map(async (j) => ({ juror: j, vote: await judgeOnce(projectId, ev.prompt, j.provider, j.model, input) })),
  );
  const votes: NonNullable<JudgeResult["votes"]> = [];
  for (const r of settled) {
    if (r.status === "fulfilled") votes.push({ ...r.value.juror, ...r.value.vote });
  }
  if (votes.length === 0) {
    const firstErr = settled.find((r): r is PromiseRejectedResult => r.status === "rejected");
    throw firstErr ? firstErr.reason : new Error("jury produced no votes");
  }
  const score = votes.reduce((s, v) => s + v.score, 0) / votes.length;
  const reasoning = `Jury mean of ${votes.length}/${jurors.length} vote(s): ${votes
    .map((v) => `${v.model}=${v.score.toFixed(2)}`)
    .join(", ")}`;
  return { evaluator: ev.name, score, reasoning, votes };
}

export async function runEvaluator(projectId: string, name: string, input: RunEvaluatorInput) {
  const judged = await judgeWithEvaluator(projectId, name, {
    input: input.input,
    output: input.output,
    expectedOutput: input.expectedOutput,
  });
  if (!judged) return null;

  // Write the score back through the ingest pipeline (lands in the telemetry store, source=EVAL).
  // The score id is DETERMINISTIC in (trace, evaluator): if this job is retried — e.g. the
  // ingest processor re-runs the eval phase after a post-insert failure — the same id is
  // produced, so merge-on-write overwrites the prior score instead of inserting a duplicate
  // (which would also double the LLM-judge cost). A trace has at most one score per evaluator.
  await submitBatch(projectId, {
    batch: [
      {
        id: newId(),
        type: "score-create",
        timestamp: isoNow(),
        body: {
          id: deterministicId(input.traceId, judged.evaluator),
          traceId: input.traceId,
          name: judged.evaluator,
          value: judged.score,
          source: "EVAL",
          dataType: "NUMERIC",
          comment: judged.reasoning,
          environment: "default",
        },
      },
    ],
  });

  return { evaluator: judged.evaluator, traceId: input.traceId, score: judged.score, reasoning: judged.reasoning };
}

// ── Thread-scope evaluation (whole-conversation judging after a cooldown) ──────────────

/**
 * How far past a session's quiet threshold we still pick it up. The cron runs every minute,
 * so this window (> the cadence) means a settled session is caught in ~1–2 runs; the
 * deterministic score id makes the rare double-run idempotent (it overwrites, at worst
 * wasting one judge call). Keep ≥ the cron period.
 */
const THREAD_SETTLE_WINDOW_MS = 120_000;
/** Cap transcript length (most-recent traces) sent to the judge, to bound judge cost/tokens. */
const THREAD_MAX_TRACES = 50;

export interface ThreadEvalResult {
  evaluated: number;
  scored: number;
}

/**
 * Score whole conversations that have just gone quiet. For every enabled thread-scope
 * evaluator, find sessions whose last activity crossed the evaluator's `cooldownSeconds`
 * within the settle window, assemble the session transcript, judge it, and write one score
 * attached to the session's latest trace. Best-effort per session — one failure never aborts
 * the sweep. Invoked by the per-minute maintenance cron (guarded by a Redis lock upstream).
 */
export async function runAllThreadEvaluations(now = new Date()): Promise<ThreadEvalResult> {
  const evaluators = await prisma.evaluator.findMany({ where: { online: true, scope: "thread" } });
  if (evaluators.length === 0) return { evaluated: 0, scored: 0 };
  const store = telemetry();
  let evaluated = 0;
  let scored = 0;

  // Group by project so each project's recent sessions are listed once.
  const byProject = new Map<string, typeof evaluators>();
  for (const ev of evaluators) {
    const arr = byProject.get(ev.projectId) ?? [];
    arr.push(ev);
    byProject.set(ev.projectId, arr);
  }

  for (const [projectId, evs] of byProject) {
    let sessions: Awaited<ReturnType<typeof store.listSessions>>;
    try {
      // One day of recent sessions covers any realistic cooldown; a session quiet for >1d is
      // long past its settle window and was already handled.
      sessions = await store.listSessions(projectId, { days: 1, limit: 1000 });
    } catch {
      continue; // store hiccup for one project shouldn't sink the whole sweep
    }
    for (const ev of evs) {
      const upper = now.getTime() - ev.cooldownSeconds * 1000; // "settled" = quiet at least this long
      const lower = upper - THREAD_SETTLE_WINDOW_MS; // but only those that JUST crossed it
      for (const s of sessions) {
        const last = Date.parse(s.last_seen);
        if (!Number.isFinite(last) || last >= upper || last < lower) continue;
        evaluated++;
        try {
          if (await scoreThread(store, projectId, ev.name, s.session_id)) scored++;
        } catch {
          // best-effort: a judge/transport failure on one session never aborts the sweep.
        }
      }
    }
  }
  return { evaluated, scored };
}

/** Assemble a session's transcript, judge it with `evaluatorName`, and write one thread score. */
async function scoreThread(
  store: ReturnType<typeof telemetry>,
  projectId: string,
  evaluatorName: string,
  sessionId: string,
): Promise<boolean> {
  const traces = await store.listTraces(projectId, { sessionId, limit: THREAD_MAX_TRACES });
  if (traces.length === 0) return false;
  const ordered = [...traces].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const io = await store.getTraceIO(
    projectId,
    ordered.map((t) => t.id),
  );
  const ioById = new Map(io.map((r) => [r.id, r]));
  const transcript = ordered
    .map((t, i) => {
      const r = ioById.get(t.id);
      return `Turn ${i + 1}${t.name ? ` (${t.name})` : ""}:\n  input: ${r?.input ?? ""}\n  output: ${r?.output ?? ""}`;
    })
    .join("\n\n");
  const latestTraceId = ordered[ordered.length - 1]!.id;

  const judged = await judgeWithEvaluator(projectId, evaluatorName, { input: transcript, output: "" });
  if (!judged) return false;

  // One score per (session, evaluator), attached to the latest trace so it surfaces in the
  // session/trace views. Deterministic id → a re-run within the settle window overwrites
  // instead of duplicating (and re-charging the judge).
  await submitBatch(projectId, {
    batch: [
      {
        id: newId(),
        type: "score-create",
        timestamp: isoNow(),
        body: {
          id: deterministicId(`thread:${sessionId}`, judged.evaluator),
          traceId: latestTraceId,
          name: judged.evaluator,
          value: judged.score,
          source: "EVAL",
          dataType: "NUMERIC",
          comment: judged.reasoning,
          environment: "default",
        },
      },
    ],
  });
  return true;
}
