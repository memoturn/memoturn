import { prisma } from "@memoturn/db";
import { headBucket } from "@memoturn/db/blob";
import { redisConnection } from "@memoturn/db/queue";
import { telemetry } from "@memoturn/telemetry";

/**
 * Readiness = "can this replica do useful work right now". Distinct from liveness
 * (`/health`, `/v1/health`), which only says the process is up: a pod whose Postgres pool
 * is dead is alive but must be taken out of rotation, and Kubernetes only does that when
 * the readiness probe fails. Each dependency is pinged with a short timeout; the result is
 * cached briefly so a probe storm can't itself load the datastores.
 */
export interface ReadinessCheck {
  ok: boolean;
  ms: number;
}

export interface ReadinessReport {
  ok: boolean;
  checks: Record<string, ReadinessCheck>;
  checkedAt: string;
}

const CHECK_TIMEOUT_MS = 2_000;
const CACHE_MS = 5_000;

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

async function probe(name: string, fn: () => Promise<unknown>, log: (msg: string) => void): Promise<ReadinessCheck> {
  const start = performance.now();
  try {
    await withTimeout(fn(), CHECK_TIMEOUT_MS, name);
    return { ok: true, ms: Math.round(performance.now() - start) };
  } catch (err) {
    log(`${name}: ${err instanceof Error ? err.message : String(err)}`);
    return { ok: false, ms: Math.round(performance.now() - start) };
  }
}

let cached: { at: number; report: ReadinessReport } | undefined;

/**
 * Probe Postgres, Redis, the telemetry store, and the blob bucket. Errors are logged via
 * `log` (server-side only — the report carries just ok/ms, since readiness endpoints are
 * unauthenticated) and never thrown.
 */
export async function readiness(log: (msg: string) => void = () => {}): Promise<ReadinessReport> {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.report;
  const [postgres, redis, telemetryStore, blob] = await Promise.all([
    probe("postgres", () => prisma.$queryRaw`SELECT 1`, log),
    probe("redis", () => redisConnection().ping(), log),
    probe(
      "telemetry",
      async () => {
        if (!(await telemetry().ping())) throw new Error("store ping returned false");
      },
      log,
    ),
    probe("blob", () => headBucket(), log),
  ]);
  const checks = { postgres, redis, telemetry: telemetryStore, blob };
  const report: ReadinessReport = {
    ok: Object.values(checks).every((c) => c.ok),
    checks,
    checkedAt: new Date().toISOString(),
  };
  cached = { at: Date.now(), report };
  return report;
}

/** Test/ops hook: drop the cached report so the next call re-probes. */
export function resetReadinessCache(): void {
  cached = undefined;
}
