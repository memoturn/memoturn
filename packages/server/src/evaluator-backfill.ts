import type { EvaluatorBackfill, SingleFilter } from "@memoturn/contracts";
import { prisma } from "@memoturn/db";
import { getEvalQueue } from "@memoturn/db/queue";
import { telemetry } from "@memoturn/telemetry";
import { mappingNeedsObservations, parseVariableMapping } from "./evaluator-variables.js";
import { EvaluatorConfigError, runEvaluator } from "./evaluators.js";

/**
 * Evaluator backfill — run an existing evaluator over traces that are ALREADY ingested.
 *
 * Online evaluation only ever sees new traffic, so a judge published today has nothing to say
 * about yesterday's incident. Targeting reuses the traces list's own model (time window +
 * structured filter set), so "the traces I'm looking at" and "the traces this will score" are
 * the same selection, and the console can show the match count before any judge call is paid for.
 *
 * Execution is a queued worker job: thousands of LLM calls can't live in a request. Progress
 * counters live on the row so the console polls instead of holding a connection. Re-running is
 * safe — score ids are deterministic in (target, evaluator), so a retry overwrites.
 */

/** Hard ceiling on one backfill, so a mis-aimed filter can't spend an unbounded amount on judges.
 *  The row records both the match count and the capped total, so the cap is never silent. */
export const MAX_BACKFILL_TARGETS = 5000;

/** Traces judged concurrently. Small: each is a provider call, and ingest shares this worker. */
const CONCURRENCY = 4;

const TERMINAL = new Set(["COMPLETED", "FAILED"]);

function toContract(row: {
  id: string;
  status: string;
  days: number;
  total: number;
  processed: number;
  failed: number;
  error: string;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  evaluator: { name: string };
}): EvaluatorBackfill {
  return {
    id: row.id,
    evaluator: row.evaluator.name,
    status: row.status,
    days: row.days,
    total: row.total,
    processed: row.processed,
    failed: row.failed,
    error: row.error,
    createdAt: row.createdAt.toISOString(),
    startedAt: row.startedAt?.toISOString() ?? null,
    finishedAt: row.finishedAt?.toISOString() ?? null,
  };
}

export interface BackfillTarget {
  days?: number;
  filters?: SingleFilter[];
}

/** Coerce the Prisma Json `filters` column into a filter set (a bad row simply targets nothing extra). */
function parseFilters(json: unknown): SingleFilter[] {
  return Array.isArray(json) ? (json as SingleFilter[]) : [];
}

/** How many traces a backfill would cover — the number shown before committing to the run. */
export async function previewEvaluatorBackfill(projectId: string, target: BackfillTarget): Promise<number> {
  return telemetry().countTraces(projectId, { days: target.days ?? 7, filters: target.filters ?? [] });
}

export async function listEvaluatorBackfills(projectId: string, name?: string): Promise<EvaluatorBackfill[]> {
  const rows = await prisma.evaluatorBackfill.findMany({
    where: { projectId, ...(name ? { evaluator: { name } } : {}) },
    include: { evaluator: { select: { name: true } } },
    orderBy: { createdAt: "desc" },
    take: 50,
  });
  return rows.map(toContract);
}

/**
 * Queue a backfill. Throws `EvaluatorConfigError` (→ 400) for an unknown evaluator or a
 * thread-scope one — whole-conversation judging is driven by session settling, not by a
 * trace selection, so a "run this over these traces" job has no meaning there.
 */
export async function createEvaluatorBackfill(
  projectId: string,
  name: string,
  target: BackfillTarget,
): Promise<EvaluatorBackfill> {
  const ev = await prisma.evaluator.findUnique({ where: { projectId_name: { projectId, name } } });
  if (!ev) throw new EvaluatorConfigError(`unknown evaluator: ${name}`);
  if (ev.scope === "thread") {
    throw new EvaluatorConfigError("thread-scope evaluators run on session settling and cannot be backfilled");
  }
  const row = await prisma.evaluatorBackfill.create({
    data: {
      projectId,
      evaluatorId: ev.id,
      days: target.days ?? 7,
      filters: (target.filters ?? []) as unknown as object,
    },
    include: { evaluator: { select: { name: true } } },
  });
  await getEvalQueue().add("backfill", { projectId, backfillId: row.id });
  return toContract(row);
}

/** Run `fn` over `items` with a small fixed concurrency, collecting per-item success/failure. */
async function forEachLimited<T>(items: T[], fn: (item: T) => Promise<void>): Promise<{ ok: number; failed: number }> {
  let ok = 0;
  let failed = 0;
  for (let i = 0; i < items.length; i += CONCURRENCY) {
    const settled = await Promise.allSettled(items.slice(i, i + CONCURRENCY).map(fn));
    for (const r of settled) {
      if (r.status === "fulfilled") ok++;
      else failed++;
    }
  }
  return { ok, failed };
}

/**
 * Execute a queued backfill. Pages the matching traces, judges each one (or each of its
 * matching spans, for an observation-scope evaluator), and keeps the row's counters current so
 * the console can watch it. Individual failures are counted, not fatal — one bad trace must not
 * abandon the rest of the run.
 */
export async function runEvaluatorBackfill(
  projectId: string,
  backfillId: string,
): Promise<{ processed: number; failed: number; total: number }> {
  const row = await prisma.evaluatorBackfill.findFirst({
    where: { id: backfillId, projectId },
    include: { evaluator: true },
  });
  if (!row) throw new Error(`unknown backfill: ${backfillId}`);
  // A retried job must not re-spend judge calls on a finished run.
  if (TERMINAL.has(row.status)) return { processed: row.processed, failed: row.failed, total: row.total };

  const store = telemetry();
  const filters = { days: row.days, filters: parseFilters(row.filters) };
  const matched = await store.countTraces(projectId, filters);
  const total = Math.min(matched, MAX_BACKFILL_TARGETS);
  await prisma.evaluatorBackfill.update({
    where: { id: row.id },
    data: {
      status: "RUNNING",
      startedAt: new Date(),
      total,
      // The cap is recorded, never silent: the console shows it next to the progress bar.
      error: matched > total ? `capped at ${total} of ${matched} matching traces` : "",
    },
  });

  const byObservation = row.evaluator.scope === "observation";
  const spanFilter = row.evaluator.filterName;
  // A trace-scope judge with an `observation.*` variable still needs the trace's spans, or those
  // variables would silently bind to null.
  const needsSpans = byObservation || mappingNeedsObservations(parseVariableMapping(row.evaluator.variableMapping));
  let processed = 0;
  let failed = 0;

  try {
    const PAGE = 100;
    for (let offset = 0; offset < total; offset += PAGE) {
      const page = await store.listTraces(projectId, { ...filters, limit: Math.min(PAGE, total - offset), offset });
      if (page.length === 0) break;
      const io = await store.getTraceIO(
        projectId,
        page.map((t) => t.id),
      );
      const ioById = new Map(io.map((r) => [r.id, r]));

      const result = await forEachLimited(page, async (t) => {
        const body = ioById.get(t.id);
        if (byObservation) {
          const spans = await store.listObservationsByTrace(projectId, t.id);
          const targets = spans.filter((o) => (spanFilter ? o.name.includes(spanFilter) : true));
          for (const o of targets) {
            await runEvaluator(projectId, row.evaluator.name, {
              traceId: t.id,
              observationId: o.id,
              input: o.input,
              output: o.output,
              observations: spans,
            });
          }
          return;
        }
        await runEvaluator(projectId, row.evaluator.name, {
          traceId: t.id,
          input: body?.input,
          output: body?.output,
          observations: needsSpans ? await store.listObservationsByTrace(projectId, t.id) : undefined,
        });
      });
      processed += result.ok;
      failed += result.failed;
      await prisma.evaluatorBackfill.update({ where: { id: row.id }, data: { processed, failed } });
    }
    await prisma.evaluatorBackfill.update({
      where: { id: row.id },
      data: { status: "COMPLETED", finishedAt: new Date() },
    });
  } catch (err) {
    await prisma.evaluatorBackfill.update({
      where: { id: row.id },
      data: {
        status: "FAILED",
        finishedAt: new Date(),
        error: err instanceof Error ? err.message : String(err),
        processed,
        failed,
      },
    });
    throw err;
  }
  return { processed, failed, total };
}
