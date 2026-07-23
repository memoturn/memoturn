import type { UsageSummary } from "@memoturn/contracts";
import { prisma } from "@memoturn/db";

/**
 * Volume-based usage metering — bytes/events/traces ingested per project per UTC day.
 *
 * Measured on the RAW batch at ingest time (before sampling), so usage reflects
 * everything a project sends, independent of what the query store keeps. Persisted to the
 * `UsageDaily` Postgres table (the in-process metrics counters are ephemeral and unfit
 * for billing). The foundation for cloud billing by GB ingested.
 */

/** UTC 'YYYY-MM-DD' for a Date (defaults to now). */
export function usageDay(at: Date = new Date()): string {
  return at.toISOString().slice(0, 10);
}

export interface UsageIncrement {
  bytes: number;
  events: number;
  traces: number;
}

/**
 * Increment a project's usage counters for the current UTC day. Idempotent by key (the
 * upsert increments an existing row), NOT idempotent per call — callers that may retry
 * (the worker) must guard against double-counting (see the ingest processor's
 * first-attempt gate). Best-effort: callers wrap this so a metering failure never fails
 * ingestion.
 */
export async function recordUsage(projectId: string, inc: UsageIncrement, at: Date = new Date()): Promise<void> {
  const date = usageDay(at);
  const bytes = BigInt(Math.max(0, Math.floor(inc.bytes)));
  const events = Math.max(0, Math.floor(inc.events));
  const traces = Math.max(0, Math.floor(inc.traces));
  await prisma.usageDaily.upsert({
    where: { projectId_date: { projectId, date } },
    create: { projectId, date, bytes, events, traces },
    update: { bytes: { increment: bytes }, events: { increment: events }, traces: { increment: traces } },
  });
}

/** Per-project ingested-volume summary over the trailing `days`, oldest→newest, zero-filled. */
export async function getUsage(projectId: string, days = 30): Promise<UsageSummary> {
  const n = Math.max(1, Math.min(365, Math.floor(days)));
  const since = usageDay(new Date(Date.now() - (n - 1) * 86_400_000));
  const rows = await prisma.usageDaily.findMany({
    where: { projectId, date: { gte: since } },
    orderBy: { date: "asc" },
  });
  const byDate = new Map(rows.map((r) => [r.date, r]));

  const byDay = Array.from({ length: n }, (_, i) => {
    const date = usageDay(new Date(Date.now() - (n - 1 - i) * 86_400_000));
    const r = byDate.get(date);
    return {
      date,
      // BigInt → number at the boundary (JS number is exact to 2^53 bytes = 9 PB/day — ample).
      bytes: r ? Number(r.bytes) : 0,
      events: r?.events ?? 0,
      traces: r?.traces ?? 0,
    };
  });

  return {
    total_bytes: byDay.reduce((s, d) => s + d.bytes, 0),
    total_events: byDay.reduce((s, d) => s + d.events, 0),
    total_traces: byDay.reduce((s, d) => s + d.traces, 0),
    byDay,
  };
}
