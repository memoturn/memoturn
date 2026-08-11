import type { EvalBackfillJob } from "@memoturn/db/queue";
import { runEvaluatorBackfill } from "@memoturn/server";
import type { Job } from "bullmq";
import { logJson } from "../metrics.js";

/**
 * Evaluator-backfill processor — a thin wrapper around `runEvaluatorBackfill` (orchestration
 * lives in @memoturn/server so it stays testable). Safe under retries: a run that already
 * reached a terminal status returns immediately, and score ids are deterministic in
 * (target, evaluator), so a partial re-run overwrites rather than duplicating.
 */
export async function processEvalBackfill(job: Job<EvalBackfillJob>): Promise<void> {
  const { projectId, backfillId } = job.data;
  logJson("info", "evaluator backfill start", { jobId: job.id, projectId, backfillId });
  const result = await runEvaluatorBackfill(projectId, backfillId);
  logJson("info", "evaluator backfill done", { jobId: job.id, backfillId, ...result });
}
