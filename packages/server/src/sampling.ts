import type { SamplingPolicy } from "@memoturn/contracts";
import { prisma } from "@memoturn/db";

/**
 * Ingest sampling config — head + tail.
 *
 * `rate` (0–100) is HEAD sampling: the percent of traces KEPT in the query store, decided
 * by a stable per-trace hash so whole traces are kept/dropped consistently. 100 (the
 * default when no policy exists) keeps everything.
 *
 * The keep-rules are TAIL sampling: a trace is ALSO kept — regardless of the head dice —
 * when it looks worth debugging (`keepOnError`: has an ERROR-level span; `keepLatencyMs`:
 * a span at/over that latency; `keepMinCostUsd`: total cost at/over that spend). So a low
 * rate can shed routine volume while never dropping the interesting traces.
 *
 * The raw batch always lands in blob regardless, so sampling only trims the queryable
 * store. The worker applies the decision (see apps/worker/src/sampling.ts).
 */

const DEFAULT: SamplingPolicy = { rate: 100, keepOnError: false, keepLatencyMs: null, keepMinCostUsd: null };

export async function getSamplingPolicy(projectId: string): Promise<SamplingPolicy> {
  const p = await prisma.samplingPolicy.findUnique({ where: { projectId } });
  if (!p) return { ...DEFAULT };
  return {
    rate: p.rate,
    keepOnError: p.keepOnError,
    keepLatencyMs: p.keepLatencyMs,
    keepMinCostUsd: p.keepMinCostUsd,
  };
}

/** @deprecated prefer getSamplingPolicy — kept for callers that only need the head rate. */
export async function getSamplingRate(projectId: string): Promise<number> {
  return (await getSamplingPolicy(projectId)).rate;
}

export async function getSampling(projectId: string): Promise<SamplingPolicy> {
  return getSamplingPolicy(projectId);
}

/** Non-negative integer, or null when the input is null/undefined/blank. */
function posIntOrNull(v: number | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  return Math.max(0, Math.floor(v));
}
function posNumOrNull(v: number | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  return Math.max(0, v);
}

export async function setSampling(projectId: string, input: Partial<SamplingPolicy>): Promise<SamplingPolicy> {
  const rate = Math.max(0, Math.min(100, Math.floor(input.rate ?? 100)));
  const keepOnError = input.keepOnError ?? false;
  const keepLatencyMs = posIntOrNull(input.keepLatencyMs);
  const keepMinCostUsd = posNumOrNull(input.keepMinCostUsd);
  const p = await prisma.samplingPolicy.upsert({
    where: { projectId },
    update: { rate, keepOnError, keepLatencyMs, keepMinCostUsd },
    create: { projectId, rate, keepOnError, keepLatencyMs, keepMinCostUsd },
  });
  return {
    rate: p.rate,
    keepOnError: p.keepOnError,
    keepLatencyMs: p.keepLatencyMs,
    keepMinCostUsd: p.keepMinCostUsd,
  };
}
