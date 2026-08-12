import type {
  EvaluatorAnalytics,
  EvaluatorVariableBinding,
  ExpressionTestResult,
  ExprPreset,
} from "@memoturn/contracts";
import {
  compileExpression,
  deterministicId,
  EVALUATOR_TEMPLATES,
  EXPR_PRESETS,
  type ExprValue,
  evaluateExpression,
  getEvaluatorTemplate,
  isoNow,
  newId,
  runExpression,
} from "@memoturn/core";
import { prisma } from "@memoturn/db";
import { generate, type Provider } from "@memoturn/llm";
import { telemetry } from "@memoturn/telemetry";
import { parseVariableMapping, renderPrompt, resolveVariables, type VariableContext } from "./evaluator-variables.js";
import { submitBatch } from "./ingest.js";
import { resolveProviderConfig } from "./providers.js";

/**
 * Evaluators. Two kinds, behind one interface:
 *
 *  - **LLM** — a judge prompt + model (optionally an ensemble jury). Costs a provider call.
 *  - **CODE** — a deterministic expression evaluated locally by @memoturn/core's safe
 *    interpreter. Free, instant, reproducible, and needs no provider key. The right home for
 *    regex / JSON-shape / exact-match / length checks that don't deserve a judge.
 *
 * Running either scores a trace's input/output and writes the score back through the ingest
 * pipeline (source=EVAL), so it lands in the telemetry store alongside API/annotation scores.
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

/** Thrown when an evaluator's config is invalid (→ 400), e.g. an expression that won't compile. */
export class EvaluatorConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvaluatorConfigError";
  }
}

export interface CreateEvaluatorInput {
  name: string;
  /** "LLM" (default) judges with a prompt + model; "CODE" runs `expression` deterministically. */
  kind?: string;
  /** Required when kind = "LLM"; unused (and not required) for CODE evaluators. */
  prompt?: string;
  /** Required when kind = "CODE" — validated at write time so a bad check is a 400, not a
   *  silent per-event failure in the worker. */
  expression?: string;
  provider?: string;
  model: string;
  online?: boolean;
  samplingRate?: number;
  filterName?: string;
  /** LLM jury members. When non-empty, the evaluator becomes an ensemble (mean of votes). */
  jurors?: Juror[];
  /**
   * "trace" (default) scores each trace inline; "thread" scores whole settled conversations;
   * "observation" scores individual spans (targeted by `filterName` on the SPAN name).
   */
  scope?: string;
  /** For scope="thread": seconds of session inactivity before the conversation is judged. */
  cooldownSeconds?: number;
  /** Judge-prompt variable bindings. Empty keeps the built-in {input, output, expectedOutput}. */
  variableMapping?: EvaluatorVariableBinding[];
  /** Name the emitted score. Empty = name it after the evaluator (the historical behavior). */
  scoreName?: string;
  /** What the judge produces: NUMERIC (default), CATEGORICAL (a label), or BOOLEAN. */
  scoreDataType?: string;
  /** Allowed labels for CATEGORICAL. Empty = accept whatever the judge returns. */
  scoreCategories?: string[];
}

/** The scopes an evaluator may declare; anything else falls back to "trace". */
const SCOPES = new Set(["trace", "thread", "observation"]);

export async function createEvaluator(projectId: string, input: CreateEvaluatorInput) {
  const provider = input.provider ?? "mock";
  const jurors = parseJurors(input.jurors ?? []);
  const kind = input.kind === "CODE" ? "CODE" : "LLM";
  const expression = input.expression ?? "";
  const prompt = input.prompt ?? "";
  if (kind === "LLM" && prompt.trim() === "") {
    throw new EvaluatorConfigError("an LLM evaluator needs a prompt");
  }
  if (kind === "CODE") {
    // Compile now so an unparseable check is rejected at write time. Left to run time it would
    // fail once per sampled event in the shared worker, where failures are swallowed
    // best-effort — the author would never find out.
    try {
      compileExpression(expression);
    } catch (err) {
      throw new EvaluatorConfigError(err instanceof Error ? err.message : String(err));
    }
  }
  const data = {
    kind,
    prompt,
    expression,
    provider,
    model: input.model,
    jurors: jurors as unknown as object,
    online: input.online ?? false,
    samplingRate: input.samplingRate ?? 1.0,
    filterName: input.filterName ?? "",
    scope: input.scope && SCOPES.has(input.scope) ? input.scope : "trace",
    cooldownSeconds: input.cooldownSeconds ?? 900,
    variableMapping: parseVariableMapping(input.variableMapping ?? []) as unknown as object,
    scoreName: (input.scoreName ?? "").trim(),
    scoreDataType: OUTPUT_TYPES.has((input.scoreDataType ?? "").toUpperCase())
      ? (input.scoreDataType as string).toUpperCase()
      : "NUMERIC",
    scoreCategories: [...new Set((input.scoreCategories ?? []).map((c) => c.trim()).filter(Boolean))],
  };
  // Version bump: an edit that changes the judge config (prompt/model/provider/jurors) is a
  // new immutable version; unrelated edits (toggling online, sampling) don't bump. A snapshot
  // row is written per version so score drift can be attributed to a config change.
  const ev = await prisma.$transaction(async (tx) => {
    const existing = await tx.evaluator.findUnique({ where: { projectId_name: { projectId, name: input.name } } });
    const jurorsChanged = !existing || !jurorsEqual(parseJurors(existing.jurors), jurors);
    const configChanged =
      !existing ||
      existing.kind !== data.kind ||
      existing.prompt !== data.prompt ||
      existing.expression !== data.expression ||
      existing.model !== data.model ||
      existing.provider !== provider ||
      // The output declaration is part of the judged contract: a judge that switches from a
      // number to a label produces incomparable scores, so it must be a new version.
      existing.scoreName !== data.scoreName ||
      existing.scoreDataType !== data.scoreDataType ||
      existing.scoreCategories.join("\u0000") !== data.scoreCategories.join("\u0000") ||
      jurorsChanged;
    const version = existing ? existing.version + (configChanged ? 1 : 0) : 1;
    const row = await tx.evaluator.upsert({
      where: { projectId_name: { projectId, name: input.name } },
      update: { ...data, version },
      create: { projectId, name: input.name, ...data, version },
    });
    if (configChanged) {
      await tx.evaluatorVersion.create({
        data: {
          evaluatorId: row.id,
          version,
          kind: data.kind,
          prompt: data.prompt,
          expression: data.expression,
          provider,
          model: data.model,
          jurors: data.jurors,
          scoreName: data.scoreName,
          scoreDataType: data.scoreDataType,
          scoreCategories: data.scoreCategories,
        },
      });
    }
    return row;
  });
  return {
    name: ev.name,
    kind: ev.kind,
    expression: ev.expression,
    provider: ev.provider,
    model: ev.model,
    jurors: parseJurors(ev.jurors),
    online: ev.online,
    samplingRate: ev.samplingRate,
    filterName: ev.filterName,
    scope: ev.scope,
    cooldownSeconds: ev.cooldownSeconds,
    variableMapping: parseVariableMapping(ev.variableMapping),
    scoreName: ev.scoreName,
    scoreDataType: ev.scoreDataType,
    scoreCategories: ev.scoreCategories,
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
    kind: v.kind,
    prompt: v.prompt,
    expression: v.expression,
    provider: v.provider,
    model: v.model,
    jurors: parseJurors(v.jurors),
    scoreName: v.scoreName,
    scoreDataType: v.scoreDataType,
    scoreCategories: v.scoreCategories,
    createdAt: v.createdAt.toISOString(),
  }));
}

export async function listEvaluators(projectId: string) {
  const evs = await prisma.evaluator.findMany({ where: { projectId }, orderBy: { name: "asc" } });
  return evs.map((e) => ({
    name: e.name,
    kind: e.kind,
    provider: e.provider,
    model: e.model,
    prompt: e.prompt,
    expression: e.expression,
    jurors: parseJurors(e.jurors),
    online: e.online,
    samplingRate: e.samplingRate,
    filterName: e.filterName,
    scope: e.scope,
    cooldownSeconds: e.cooldownSeconds,
    variableMapping: parseVariableMapping(e.variableMapping),
    scoreName: e.scoreName,
    scoreDataType: e.scoreDataType,
    scoreCategories: e.scoreCategories,
    version: e.version,
    createdAt: e.createdAt.toISOString(),
  }));
}

/**
 * Online evaluators for a project (run automatically on sampled incoming telemetry). Both
 * "trace"- and "observation"-scope evaluators run inline at ingest — the first scores whole
 * runs, the second scores individual spans. "thread"-scope ones run on a cron (see
 * `runAllThreadEvaluations`), so they're excluded here.
 */
export async function listOnlineEvaluators(projectId: string) {
  return prisma.evaluator.findMany({ where: { projectId, online: true, scope: { in: ["trace", "observation"] } } });
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

/** The prebuilt CODE-evaluator check library, for the preset menu. */
export function listExprPresets(): ExprPreset[] {
  return EXPR_PRESETS.map((p) => ({ ...p, placeholders: p.placeholders.map((ph) => ({ ...ph })) }));
}

export interface TestExpressionInput {
  expression: string;
  input?: unknown;
  output?: unknown;
  expectedOutput?: unknown;
  metadata?: unknown;
}

/**
 * Dry-run an expression against a sample item for the editor — never persists anything.
 *
 * Errors are RETURNED, not thrown: the whole point of a test affordance is to show what went
 * wrong, and a compile error is the expected case while someone is still typing. It also
 * reports the raw value even when that value isn't score-shaped, which is exactly when the
 * author most needs to see it.
 */
export function testExpression(input: TestExpressionInput): ExpressionTestResult {
  const ctx = {
    input: (input.input ?? null) as ExprValue,
    output: (input.output ?? null) as ExprValue,
    expected: (input.expectedOutput ?? null) as ExprValue,
    metadata: (input.metadata ?? null) as ExprValue,
  };
  let value: ExprValue;
  try {
    value = evaluateExpression(input.expression, ctx);
  } catch (err) {
    return { ok: false, score: null, value: null, error: err instanceof Error ? err.message : String(err) };
  }
  try {
    const { score } = runExpression(input.expression, ctx);
    return { ok: true, score, value: JSON.stringify(value) ?? "null", error: null };
  } catch (err) {
    // Evaluated fine but isn't a valid score — surface the value alongside the reason.
    return {
      ok: false,
      score: null,
      value: JSON.stringify(value) ?? "null",
      error: err instanceof Error ? err.message : String(err),
    };
  }
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
  /** Bind the template prompt's variables to sources (e.g. a RAG judge → the retriever span). */
  variableMapping?: EvaluatorVariableBinding[];
  scoreName?: string;
  scoreDataType?: string;
  scoreCategories?: string[];
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
    variableMapping: overrides.variableMapping,
    scoreName: overrides.scoreName,
    scoreDataType: overrides.scoreDataType,
    scoreCategories: overrides.scoreCategories,
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

/**
 * The score-body fields a judged result writes. A label goes in `stringValue` with no numeric
 * `value` — writing 0 there would make a categorical judgement look like a failing number in
 * every average, chart, and gate that touches it.
 */
function scoreFieldsFor(judged: JudgeResult): {
  name: string;
  dataType: "NUMERIC" | "CATEGORICAL" | "BOOLEAN";
  value?: number;
  stringValue?: string;
} {
  if (judged.dataType === "CATEGORICAL") {
    return { name: judged.scoreName, dataType: "CATEGORICAL", stringValue: judged.label };
  }
  return { name: judged.scoreName, dataType: judged.dataType, value: judged.score ?? 0 };
}

export interface RunEvaluatorInput {
  traceId: string;
  input: unknown;
  output: unknown;
  expectedOutput?: unknown;
  /** Score THIS span rather than the whole trace (scope = "observation"). */
  observationId?: string;
  /** The trace's spans, for variable mappings that bind to a named observation. */
  observations?: JudgeInput["observations"];
}

/**
 * What a judge is asked to produce. NUMERIC is the historical contract; the other two exist
 * because plenty of judgements aren't a number — "which failure mode is this?" is a label, and
 * "did it cite a source?" is a yes/no that a 0.5 would only obscure.
 */
export type ScoreDataTypeOut = "NUMERIC" | "CATEGORICAL" | "BOOLEAN";
const OUTPUT_TYPES = new Set<string>(["NUMERIC", "CATEGORICAL", "BOOLEAN"]);

/** The output declaration of an evaluator row, with the historical defaults applied. */
export interface EvaluatorOutput {
  scoreName: string;
  dataType: ScoreDataTypeOut;
  categories: string[];
}

export function evaluatorOutput(ev: {
  name: string;
  scoreName?: string | null;
  scoreDataType?: string | null;
  scoreCategories?: string[] | null;
}): EvaluatorOutput {
  const declared = (ev.scoreDataType ?? "").toUpperCase();
  return {
    // An unnamed output keeps naming the score after the evaluator — what every judge did before.
    scoreName: (ev.scoreName ?? "").trim() || ev.name,
    dataType: OUTPUT_TYPES.has(declared) ? (declared as ScoreDataTypeOut) : "NUMERIC",
    categories: (ev.scoreCategories ?? []).map((c) => c.trim()).filter(Boolean),
  };
}

/** The response shape asked of the judge, spelled out per output type. */
function judgeInstruction(out: EvaluatorOutput): string {
  if (out.dataType === "BOOLEAN") {
    return 'Respond ONLY with strict JSON: {"pass": <true or false>, "reasoning": <string>}.';
  }
  if (out.dataType === "CATEGORICAL") {
    const allowed = out.categories.length > 0 ? ` The label MUST be one of: ${out.categories.join(", ")}.` : "";
    return `Respond ONLY with strict JSON: {"label": <string>, "reasoning": <string>}.${allowed}`;
  }
  return 'Respond ONLY with strict JSON: {"score": <number between 0 and 1>, "reasoning": <string>}.';
}

/** One judge's answer, normalized. `score` is null for a label — there is no number to invent. */
export interface JudgeVote {
  score: number | null;
  label: string;
  reasoning: string;
}

function parseJudge(text: string, out: EvaluatorOutput): JudgeVote {
  let parsed: Record<string, unknown>;
  try {
    const match = text.match(/\{[\s\S]*\}/);
    parsed = JSON.parse(match ? match[0] : text) as Record<string, unknown>;
  } catch {
    // Unparseable: keep the raw text as the reasoning so the failure is inspectable rather
    // than silently scoring zero with no explanation.
    return { score: out.dataType === "CATEGORICAL" ? null : 0, label: "", reasoning: text.slice(0, 500) };
  }
  const reasoning = String(parsed.reasoning ?? "");
  if (out.dataType === "BOOLEAN") {
    const pass = parsed.pass === true || parsed.pass === "true" || Number(parsed.pass) === 1;
    return { score: pass ? 1 : 0, label: "", reasoning };
  }
  if (out.dataType === "CATEGORICAL") {
    const raw = String(parsed.label ?? "").trim();
    // A declared category list is a contract: an off-list answer is a judge failure, not a new
    // category to silently accept (which would fragment the score's own distribution).
    const label = out.categories.length === 0 || out.categories.includes(raw) ? raw : "";
    return {
      score: null,
      label,
      reasoning: label === "" && raw !== "" ? `off-list label "${raw.slice(0, 80)}": ${reasoning}` : reasoning,
    };
  }
  const score = Math.max(0, Math.min(1, Number(parsed.score)));
  return { score: Number.isFinite(score) ? score : 0, label: "", reasoning };
}

export interface JudgeInput {
  input: unknown;
  output: unknown;
  expectedOutput?: unknown;
  /** Bound as `metadata` for CODE evaluators; a `trace.metadata` mapping source for LLM judges. */
  metadata?: unknown;
  /**
   * The trace's spans, so a variable mapping can bind to a NAMED observation (e.g. the
   * retriever's output). Omit when the caller has none — those bindings resolve to null.
   */
  observations?: VariableContext["observations"];
  /** Dataset-item fields for an experiment run; defaults to {input, expectedOutput, metadata}. */
  dataset?: VariableContext["dataset"];
}

export interface JudgeResult {
  evaluator: string;
  /** The score name this writes under — the evaluator's name unless it declares another. */
  scoreName: string;
  dataType: ScoreDataTypeOut;
  /**
   * The numeric judgement, or null for a CATEGORICAL evaluator — which has a label, not a
   * number. Callers that compare thresholds (guards, gates) must handle null rather than
   * treating a label as a zero.
   */
  score: number | null;
  /** The chosen label for CATEGORICAL; empty for the numeric types. */
  label: string;
  reasoning: string;
  /** Per-juror breakdown when this evaluator is an LLM jury (empty for a single judge). */
  votes?: { provider: string; model: string; score: number | null; label: string; reasoning: string }[];
}

/** Run one judge (a single provider/model) over the item and return its normalized vote. */
async function judgeOnce(
  projectId: string,
  prompt: string,
  provider: string,
  model: string,
  payload: unknown,
  out: EvaluatorOutput,
): Promise<JudgeVote> {
  const config = await resolveProviderConfig(projectId, provider as Provider);
  const result = await generate({
    provider: provider as Provider,
    model,
    ...config,
    temperature: 0,
    messages: [
      {
        role: "system",
        content: `${prompt}\n\n${judgeInstruction(out)}`,
      },
      { role: "user", content: JSON.stringify(payload) },
    ],
  });
  // mock provider can't actually judge — synthesize a deterministic answer for testing, in
  // whatever shape this evaluator declares.
  if (provider === "mock") {
    const label = out.dataType === "CATEGORICAL" ? (out.categories[0] ?? "mock") : "";
    return { score: out.dataType === "CATEGORICAL" ? null : 1, label, reasoning: result.content };
  }
  return parseJudge(result.content, out);
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

  // Variable mapping: when the evaluator declares one, the judge sees exactly the variables it
  // binds (and the prompt's `{{name}}` references are substituted); otherwise it sees the
  // built-in {input, output, expectedOutput}, which is what every pre-mapping evaluator expects.
  const out = evaluatorOutput(ev);
  const mapping = parseVariableMapping(ev.variableMapping);
  const vars = mapping.length
    ? resolveVariables(mapping, {
        trace: { input: input.input, output: input.output, metadata: input.metadata },
        observations: input.observations,
        dataset: input.dataset ?? {
          input: input.input,
          expectedOutput: input.expectedOutput,
          metadata: input.metadata,
        },
      })
    : null;

  // CODE evaluators are deterministic and local: no provider call, no key needed, no cost, and
  // the same answer every time. Dispatching here means every consumer — online evals, thread
  // evals, dataset experiments, and synchronous guardrail checks — gets them for free.
  if (ev.kind === "CODE") {
    const { score, value } = runExpression(ev.expression, {
      // Mapped variables are additional bindings, never replacements: an expression written
      // against `output` keeps working when a mapping is added.
      ...((vars ?? {}) as Record<string, ExprValue>),
      input: (input.input ?? null) as ExprValue,
      output: (input.output ?? null) as ExprValue,
      expected: (input.expectedOutput ?? null) as ExprValue,
      metadata: (input.metadata ?? null) as ExprValue,
    });
    // A code check is inherently numeric — an expression returns a number, not a label — so it
    // ignores a CATEGORICAL declaration rather than pretending to honor one.
    return {
      evaluator: ev.name,
      scoreName: out.scoreName,
      dataType: out.dataType === "CATEGORICAL" ? "NUMERIC" : out.dataType,
      score,
      label: "",
      reasoning: `${ev.expression} → ${JSON.stringify(value)}`,
    };
  }

  const prompt = vars ? renderPrompt(ev.prompt, vars) : ev.prompt;
  const payload = vars ?? { input: input.input, output: input.output, expectedOutput: input.expectedOutput };

  const jurors = parseJurors(ev.jurors);
  if (jurors.length === 0) {
    const judged = await judgeOnce(projectId, prompt, ev.provider, ev.model, payload, out);
    return { evaluator: ev.name, scoreName: out.scoreName, dataType: out.dataType, ...judged };
  }

  // Jury: fan out to every member concurrently, then aggregate — by mean for a number, by
  // majority for a label (a mean of labels is meaningless).
  const settled = await Promise.allSettled(
    jurors.map(async (j) => ({
      juror: j,
      vote: await judgeOnce(projectId, prompt, j.provider, j.model, payload, out),
    })),
  );
  const votes: NonNullable<JudgeResult["votes"]> = [];
  for (const r of settled) {
    if (r.status === "fulfilled") votes.push({ ...r.value.juror, ...r.value.vote });
  }
  if (votes.length === 0) {
    const firstErr = settled.find((r): r is PromiseRejectedResult => r.status === "rejected");
    throw firstErr ? firstErr.reason : new Error("jury produced no votes");
  }
  const base = { evaluator: ev.name, scoreName: out.scoreName, dataType: out.dataType, votes };

  if (out.dataType === "CATEGORICAL") {
    const tally = new Map<string, number>();
    for (const v of votes) if (v.label) tally.set(v.label, (tally.get(v.label) ?? 0) + 1);
    // Ties break by first-seen order, which is juror order — deterministic, not arbitrary.
    const [winner, count] = [...tally.entries()].reduce<[string, number]>(
      (best, cur) => (cur[1] > best[1] ? cur : best),
      ["", 0],
    );
    return {
      ...base,
      score: null,
      label: winner,
      reasoning: `Jury majority ${count}/${votes.length} for "${winner}": ${votes
        .map((v) => `${v.model}=${v.label || "?"}`)
        .join(", ")}`,
    };
  }

  const numeric = votes.map((v) => v.score ?? 0);
  const score = numeric.reduce((sum, v) => sum + v, 0) / numeric.length;
  const reasoning = `Jury mean of ${votes.length}/${jurors.length} vote(s): ${votes
    .map((v) => `${v.model}=${(v.score ?? 0).toFixed(2)}`)
    .join(", ")}`;
  return { ...base, score, label: "", reasoning };
}

export async function runEvaluator(projectId: string, name: string, input: RunEvaluatorInput) {
  const judged = await judgeWithEvaluator(projectId, name, {
    input: input.input,
    output: input.output,
    expectedOutput: input.expectedOutput,
    observations: input.observations,
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
          // Scoped to the span when one is given, so a span-scope evaluator writes one score
          // per observation instead of overwriting a single trace-level score.
          id: deterministicId(input.observationId ?? input.traceId, judged.evaluator),
          traceId: input.traceId,
          ...(input.observationId ? { observationId: input.observationId } : {}),
          ...scoreFieldsFor(judged),
          source: "EVAL",
          comment: judged.reasoning,
          environment: "default",
        },
      },
    ],
  });

  return {
    evaluator: judged.evaluator,
    traceId: input.traceId,
    observationId: input.observationId ?? "",
    // The caller shouldn't have to look up the evaluator to know what came back: `score` is
    // null for a label, and `label` carries the answer.
    scoreName: judged.scoreName,
    dataType: judged.dataType,
    score: judged.score,
    label: judged.label,
    reasoning: judged.reasoning,
  };
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
          ...scoreFieldsFor(judged),
          source: "EVAL",
          comment: judged.reasoning,
          environment: "default",
        },
      },
    ],
  });
  return true;
}
