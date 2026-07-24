import type { SandboxJob } from "@memoturn/db/queue";
import { seedSandbox } from "@memoturn/server";
import type { Job } from "bullmq";
import { logJson } from "../metrics.js";

/**
 * Seeds a freshly provisioned public-demo sandbox. Thin wrapper — the orchestration lives
 * in @memoturn/server so it stays unit-testable, matching the experiment processor.
 */
export async function processSandbox(job: Job<SandboxJob>): Promise<void> {
  const { organizationId, projectId } = job.data;
  logJson("info", "sandbox seed start", { organizationId, projectId });
  await seedSandbox(organizationId, projectId);
  logJson("info", "sandbox seed done", { organizationId, projectId });
}
