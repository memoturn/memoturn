import type { SandboxJob } from "@memoturn/db/queue";
import { finalizeSandbox, seedSandbox } from "@memoturn/server";
import type { Job } from "bullmq";
import { logJson } from "../metrics.js";

/**
 * Drives a public-demo sandbox through its two-phase lifecycle. Thin wrapper — the
 * orchestration lives in @memoturn/server so it stays unit-testable, matching the experiment
 * processor.
 *
 *  - "seed" (default, back-compat): submit telemetry, then enqueue the delayed finalize job.
 *  - "finalize": seed entities + the 3D projection (now that telemetry has drained), mark
 *    READY, and — for the email-after-ready flow — send the deferred magic link.
 */
export async function processSandbox(job: Job<SandboxJob>): Promise<void> {
  const { organizationId, projectId, phase = "seed", email, sendMagicLink } = job.data;
  logJson("info", `sandbox ${phase} start`, { organizationId, projectId });
  if (phase === "finalize") {
    await finalizeSandbox(organizationId, projectId, { email, sendMagicLink });
  } else {
    await seedSandbox(organizationId, projectId, { email, sendMagicLink });
  }
  logJson("info", `sandbox ${phase} done`, { organizationId, projectId });
}
