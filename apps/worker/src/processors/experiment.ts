import type { ExperimentJob } from "@memoturn/db/queue";
import { runExperiment } from "@memoturn/server";
import type { Job } from "bullmq";
import { logJson } from "../metrics.js";

/**
 * Experiment processor — thin wrapper around `runExperiment` (all orchestration lives in
 * @memoturn/server so it stays testable). Idempotent under retries via the per-item
 * checkpoint table; a lock prevents two workers running the same experiment concurrently.
 */
export async function processExperiment(job: Job<ExperimentJob>): Promise<void> {
  const { projectId, experimentId } = job.data;
  logJson("info", "experiment run start", { jobId: job.id, projectId, experimentId });
  const result = await runExperiment(projectId, experimentId);
  logJson("info", "experiment run done", { jobId: job.id, experimentId, ...result });
}
