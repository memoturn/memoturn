import { prisma } from "@memoturn/db";
import { telemetry } from "@memoturn/telemetry";

/**
 * Data retention — delete telemetry older than a per-project cutoff via the telemetry
 * store. days=0 means keep forever.
 */
export async function getRetention(projectId: string) {
  const p = await prisma.retentionPolicy.findUnique({ where: { projectId } });
  return { days: p?.days ?? 0 };
}

export async function setRetention(projectId: string, days: number) {
  const p = await prisma.retentionPolicy.upsert({
    where: { projectId },
    update: { days },
    create: { projectId, days },
  });
  return { days: p.days };
}

export interface RetentionResult {
  projectId: string;
  days: number;
  deletedTraces: number;
}

/** Apply retention for one project. Returns how many traces were removed. */
export async function applyRetention(projectId: string, days: number): Promise<RetentionResult> {
  if (days <= 0) return { projectId, days, deletedTraces: 0 };
  const store = telemetry();
  const before = await store.countTracesOlderThan(projectId, days);
  await store.deleteOlderThan(projectId, days);
  return { projectId, days, deletedTraces: before };
}

/** Apply retention across every project that has a policy (worker cron). */
export async function applyAllRetention(): Promise<RetentionResult[]> {
  const policies = await prisma.retentionPolicy.findMany({ where: { days: { gt: 0 } } });
  const results: RetentionResult[] = [];
  for (const p of policies) {
    try {
      results.push(await applyRetention(p.projectId, p.days));
    } catch {
      /* skip a project on failure */
    }
  }
  return results;
}
