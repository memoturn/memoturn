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
export interface CreateEvaluatorInput {
  name: string;
  prompt: string;
  provider?: string;
  model: string;
  online?: boolean;
  samplingRate?: number;
  filterName?: string;
}

export async function createEvaluator(projectId: string, input: CreateEvaluatorInput) {
  const provider = input.provider ?? "mock";
  const data = {
    prompt: input.prompt,
    provider,
    model: input.model,
    online: input.online ?? false,
    samplingRate: input.samplingRate ?? 1.0,
    filterName: input.filterName ?? "",
  };
  // Version bump: an edit that changes the judge config (prompt/model/provider) is a new
  // immutable version; unrelated edits (toggling online, sampling) don't bump. A snapshot
  // row is written per version so score drift can be attributed to a config change.
  const ev = await prisma.$transaction(async (tx) => {
    const existing = await tx.evaluator.findUnique({ where: { projectId_name: { projectId, name: input.name } } });
    const configChanged =
      !existing || existing.prompt !== data.prompt || existing.model !== data.model || existing.provider !== provider;
    const version = existing ? existing.version + (configChanged ? 1 : 0) : 1;
    const row = await tx.evaluator.upsert({
      where: { projectId_name: { projectId, name: input.name } },
      update: { ...data, version },
      create: { projectId, name: input.name, ...data, version },
    });
    if (configChanged) {
      await tx.evaluatorVersion.create({
        data: { evaluatorId: row.id, version, prompt: data.prompt, provider, model: data.model },
      });
    }
    return row;
  });
  return {
    name: ev.name,
    provider: ev.provider,
    model: ev.model,
    online: ev.online,
    samplingRate: ev.samplingRate,
    filterName: ev.filterName,
    version: ev.version,
  };
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
    online: e.online,
    samplingRate: e.samplingRate,
    filterName: e.filterName,
    version: e.version,
    createdAt: e.createdAt.toISOString(),
  }));
}

/** Online evaluators for a project (run automatically on sampled incoming traces). */
export async function listOnlineEvaluators(projectId: string) {
  return prisma.evaluator.findMany({ where: { projectId, online: true } });
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
}

/**
 * Run an evaluator's judge prompt and return {score, reasoning} — no telemetry write.
 * Used by `runEvaluator` (which adds the score-write) and by synchronous guard checks
 * (`runEvaluatorGuards` in guardrails.ts), which must NOT write a score per invocation:
 * a guard check can run many times per request with no natural traceId, and writing one
 * would pollute evaluator score analytics with call-count noise. Returns null when the
 * named evaluator doesn't exist for the project.
 */
export async function judgeWithEvaluator(
  projectId: string,
  name: string,
  input: JudgeInput,
): Promise<JudgeResult | null> {
  const ev = await prisma.evaluator.findUnique({ where: { projectId_name: { projectId, name } } });
  if (!ev) return null;

  const config = await resolveProviderConfig(projectId, ev.provider as Provider);
  const result = await generate({
    provider: ev.provider as Provider,
    model: ev.model,
    ...config,
    temperature: 0,
    messages: [
      {
        role: "system",
        content: `${ev.prompt}\n\nRespond ONLY with strict JSON: {"score": <number between 0 and 1>, "reasoning": <string>}.`,
      },
      {
        role: "user",
        content: JSON.stringify({ input: input.input, output: input.output, expectedOutput: input.expectedOutput }),
      },
    ],
  });

  // mock provider can't actually judge — synthesize a deterministic score for testing.
  const judged = ev.provider === "mock" ? { score: 1, reasoning: result.content } : parseJudge(result.content);
  return { evaluator: ev.name, ...judged };
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
