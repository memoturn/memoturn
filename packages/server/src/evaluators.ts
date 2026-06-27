import type { EvaluatorAnalytics } from "@memoturn/contracts";
import { isoNow, newId } from "@memoturn/core";
import { prisma } from "@memoturn/db";
import { clickhouse } from "@memoturn/db/clickhouse";
import { generate, type Provider } from "@memoturn/llm";
import { submitBatch } from "./ingest.js";
import { resolveProviderKey } from "./providers.js";

/**
 * LLM-as-judge evaluators. An evaluator is a judge prompt + model; running it scores a
 * trace's input/output and writes the score back through the ingest pipeline
 * (source=EVAL), so it lands in ClickHouse alongside API/annotation scores.
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
  const data = {
    prompt: input.prompt,
    provider: input.provider ?? "mock",
    model: input.model,
    online: input.online ?? false,
    samplingRate: input.samplingRate ?? 1.0,
    filterName: input.filterName ?? "",
  };
  const ev = await prisma.evaluator.upsert({
    where: { projectId_name: { projectId, name: input.name } },
    update: data,
    create: { projectId, name: input.name, ...data },
  });
  return {
    name: ev.name,
    provider: ev.provider,
    model: ev.model,
    online: ev.online,
    samplingRate: ev.samplingRate,
    filterName: ev.filterName,
  };
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
    createdAt: e.createdAt.toISOString(),
  }));
}

/** Online evaluators for a project (run automatically on sampled incoming traces). */
export async function listOnlineEvaluators(projectId: string) {
  return prisma.evaluator.findMany({ where: { projectId, online: true } });
}

/**
 * Score trends for EVAL-sourced scores (evaluator output) over the last `days`.
 * Reads `scores FINAL` (ReplacingMergeTree de-dup) and returns a per-evaluator
 * summary plus a daily trend. ClickHouse count()/avg() come back as strings in
 * JSONEachRow, so coerce with Number().
 */
export async function getEvaluatorAnalytics(projectId: string, days = 30): Promise<EvaluatorAnalytics> {
  const ch = clickhouse();

  const summaryRs = await ch.query({
    query: `
      SELECT
        name,
        count() AS count,
        avg(value) AS avgValue
      FROM scores FINAL
      WHERE project_id = {projectId:String}
        AND source = 'EVAL'
        AND timestamp >= now() - toIntervalDay({days:UInt32})
        AND value IS NOT NULL
      GROUP BY name
      ORDER BY count DESC
    `,
    query_params: { projectId, days },
    format: "JSONEachRow",
  });
  const summaryRows = await summaryRs.json<{ name: string; count: string; avgValue: string }>();

  const trendRs = await ch.query({
    query: `
      SELECT
        toString(toDate(timestamp)) AS date,
        name,
        count() AS count,
        avg(value) AS avgValue
      FROM scores FINAL
      WHERE project_id = {projectId:String}
        AND source = 'EVAL'
        AND timestamp >= now() - toIntervalDay({days:UInt32})
        AND value IS NOT NULL
      GROUP BY date, name
      ORDER BY date ASC, name ASC
    `,
    query_params: { projectId, days },
    format: "JSONEachRow",
  });
  const trendRows = await trendRs.json<{ date: string; name: string; count: string; avgValue: string }>();

  return {
    days,
    summary: summaryRows.map((r) => ({ name: r.name, count: Number(r.count), avgValue: Number(r.avgValue) })),
    trend: trendRows.map((r) => ({
      date: r.date,
      name: r.name,
      count: Number(r.count),
      avgValue: Number(r.avgValue),
    })),
  };
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

export async function runEvaluator(projectId: string, name: string, input: RunEvaluatorInput) {
  const ev = await prisma.evaluator.findUnique({ where: { projectId_name: { projectId, name } } });
  if (!ev) return null;

  const apiKey = await resolveProviderKey(projectId, ev.provider as Provider);
  const result = await generate({
    provider: ev.provider as Provider,
    model: ev.model,
    apiKey,
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

  // Write the score back through the ingest pipeline (lands in ClickHouse, source=EVAL).
  await submitBatch(projectId, {
    batch: [
      {
        id: newId(),
        type: "score-create",
        timestamp: isoNow(),
        body: {
          id: newId(),
          traceId: input.traceId,
          name: ev.name,
          value: judged.score,
          source: "EVAL",
          dataType: "NUMERIC",
          comment: judged.reasoning,
          environment: "default",
        },
      },
    ],
  });

  return { evaluator: ev.name, traceId: input.traceId, ...judged };
}
