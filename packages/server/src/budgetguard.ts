import { prisma } from "@memoturn/db";
import { redisConnection } from "@memoturn/db/queue";
import { telemetry } from "@memoturn/telemetry";
import { BudgetExceededError } from "./errors.js";

/**
 * Hard cost cap. `CostBudget.hardCap` turns the (notify-only) monthly budget into a gate:
 * every LLM-backed feature resolves its provider config through `assertWithinBudget`, and
 * once month-to-date spend reaches the budget the call is refused with a 402 instead of
 * charging the operator's key. Spend is the same month-to-date cost the budget cron
 * reads, cached in Redis for a minute so the gate costs one analytical query per project
 * per minute rather than one per LLM call. Fails OPEN on a Redis/store error (a cache
 * outage must not stop the playground) — the cron still notifies.
 */
const CACHE_TTL_S = 60;
const key = (projectId: string) => `memoturn:budgetguard:${projectId}`;

interface GuardState {
  hardCap: boolean;
  monthlyUsd: number;
  spentUsd: number;
}

function daysSinceMonthStart(now = new Date()): number {
  return Math.max(1, Math.ceil((now.getTime() - Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)) / 86_400_000));
}

async function load(projectId: string): Promise<GuardState> {
  const budget = await prisma.costBudget.findUnique({ where: { projectId } });
  if (!budget?.hardCap || budget.monthlyUsd <= 0) return { hardCap: false, monthlyUsd: 0, spentUsd: 0 };
  const byModel = await telemetry().metricsByModel(projectId, daysSinceMonthStart());
  const spentUsd = byModel.reduce((s, m) => s + m.total_cost, 0);
  return { hardCap: true, monthlyUsd: budget.monthlyUsd, spentUsd };
}

/** Throws BudgetExceededError when the project's hard cap is exhausted; otherwise returns. */
export async function assertWithinBudget(projectId: string): Promise<void> {
  let state: GuardState | null = null;
  try {
    const cached = await redisConnection().get(key(projectId));
    if (cached) state = JSON.parse(cached) as GuardState;
  } catch {
    // cache miss on error
  }
  if (!state) {
    try {
      state = await load(projectId);
      await redisConnection()
        .set(key(projectId), JSON.stringify(state), "EX", CACHE_TTL_S)
        .catch(() => {});
    } catch {
      return; // fail open
    }
  }
  if (state.hardCap && state.spentUsd >= state.monthlyUsd) {
    throw new BudgetExceededError(state.spentUsd, state.monthlyUsd);
  }
}

/** Drop the cached state (budget changed) so the next call re-reads it. */
export async function invalidateBudgetGuard(projectId: string): Promise<void> {
  try {
    await redisConnection().del(key(projectId));
  } catch {
    // best-effort
  }
}
