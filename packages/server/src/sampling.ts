import { prisma } from "@memoturn/db";

/**
 * Head-based ingest sampling config. `rate` (0–100) is the percent of traces KEPT in the query
 * store at ingest; 100 (the default when no policy exists) keeps everything. The worker applies
 * the decision as a stable per-trace hash, so whole traces are kept/dropped consistently. The
 * raw batch always lands in blob regardless, so this only trims the queryable store.
 */
export async function getSamplingRate(projectId: string): Promise<number> {
  const p = await prisma.samplingPolicy.findUnique({ where: { projectId } });
  return p?.rate ?? 100;
}

export async function getSampling(projectId: string): Promise<{ rate: number }> {
  return { rate: await getSamplingRate(projectId) };
}

export async function setSampling(projectId: string, rate: number): Promise<{ rate: number }> {
  const clamped = Math.max(0, Math.min(100, Math.floor(rate)));
  const p = await prisma.samplingPolicy.upsert({
    where: { projectId },
    update: { rate: clamped },
    create: { projectId, rate: clamped },
  });
  return { rate: p.rate };
}
