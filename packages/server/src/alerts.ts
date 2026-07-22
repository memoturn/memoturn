import { prisma } from "@memoturn/db";
import { telemetry, type WindowMetric } from "@memoturn/telemetry";
import { type Channel, type ChannelMessage, type ChannelType, deliverToChannel } from "./automations.js";
import { mapConcurrent } from "./concurrency.js";

/**
 * Stateful alert rules + cost budgets. Unlike the event-triggered Automations (which fire
 * on the ingest hot path), alerts are evaluated by a worker cron: each rule computes a
 * metric over a trailing window via the telemetry store, compares it to a threshold, and
 * transitions firing/resolved state — notifying only on a transition (dedup). Cost budgets
 * compare month-to-date spend to percentage steps of a monthly USD budget.
 *
 * Delivery reuses `deliverToChannel` from automations so SSRF re-check / timeout hardening
 * lives in one place. No hard caps — budgets are soft (memoturn is not a gateway).
 */

export const ALERT_METRICS = [
  "error_rate",
  "latency_p95",
  "cost_per_day",
  "ingest_volume",
  "dlq_depth",
  "rehydrate_rate",
] as const;
export type AlertMetric = (typeof ALERT_METRICS)[number];

/** Process-global signals the worker injects for metrics that aren't a Doris window query. */
export interface AlertContext {
  dlqDepth?: number;
  rehydrateRate?: number;
}
export const ALERT_COMPARATORS = ["gt", "gte", "lt", "lte", "anomaly_high", "anomaly_low"] as const;
export type AlertComparator = (typeof ALERT_COMPARATORS)[number];

const DISPATCH_CONCURRENCY = 8;
/** Distinct-window telemetry reads (and budget reads) in flight at once per sweep. */
const METRIC_FETCH_CONCURRENCY = 8;

export interface AlertRuleInput {
  name: string;
  metric: AlertMetric;
  window?: number;
  threshold: number;
  comparator?: AlertComparator;
  channels?: Channel[];
  enabled?: boolean;
}

interface AlertRuleRow {
  id: string;
  name: string;
  metric: string;
  window: number;
  threshold: number;
  comparator: string;
  channels: unknown;
  enabled: boolean;
  createdAt: Date;
  state?: {
    status: string;
    lastValue: number | null;
    lastFiredAt: Date | null;
    lastResolvedAt: Date | null;
  } | null;
}

/** Coerce the JSON `channels` column into a validated Channel[] (drops malformed entries). */
function parseChannels(raw: unknown): Channel[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((c) => {
    const t = (c as { type?: unknown })?.type;
    const target = (c as { target?: unknown })?.target;
    return (t === "slack" || t === "webhook") && typeof target === "string" ? [{ type: t as ChannelType, target }] : [];
  });
}

function shape(r: AlertRuleRow) {
  return {
    id: r.id,
    name: r.name,
    metric: r.metric,
    window: r.window,
    threshold: r.threshold,
    comparator: r.comparator,
    channels: parseChannels(r.channels),
    enabled: r.enabled,
    createdAt: r.createdAt.toISOString(),
    status: r.state?.status ?? "ok",
    lastValue: r.state?.lastValue ?? null,
    lastFiredAt: r.state?.lastFiredAt?.toISOString() ?? null,
    lastResolvedAt: r.state?.lastResolvedAt?.toISOString() ?? null,
  };
}

export type AlertRuleShape = ReturnType<typeof shape>;

// ── CRUD ─────────────────────────────────────────────────────────────────────────

export async function listAlertRules(projectId: string): Promise<AlertRuleShape[]> {
  const rows = await prisma.alertRule.findMany({
    where: { projectId },
    include: { state: true },
    orderBy: { createdAt: "desc" },
  });
  return rows.map(shape);
}

export async function createAlertRule(projectId: string, input: AlertRuleInput): Promise<AlertRuleShape> {
  const r = await prisma.alertRule.create({
    data: {
      projectId,
      name: input.name,
      metric: input.metric,
      window: input.window ?? 5,
      threshold: input.threshold,
      comparator: input.comparator ?? "gt",
      channels: (input.channels ?? []) as object,
      enabled: input.enabled ?? true,
    },
    include: { state: true },
  });
  return shape(r);
}

export async function updateAlertRule(
  projectId: string,
  id: string,
  patch: Partial<AlertRuleInput>,
): Promise<AlertRuleShape | null> {
  const { count } = await prisma.alertRule.updateMany({
    where: { projectId, id },
    data: {
      ...(patch.name !== undefined && { name: patch.name }),
      ...(patch.metric !== undefined && { metric: patch.metric }),
      ...(patch.window !== undefined && { window: patch.window }),
      ...(patch.threshold !== undefined && { threshold: patch.threshold }),
      ...(patch.comparator !== undefined && { comparator: patch.comparator }),
      ...(patch.channels !== undefined && { channels: patch.channels as object }),
      ...(patch.enabled !== undefined && { enabled: patch.enabled }),
    },
  });
  if (count === 0) return null;
  const r = await prisma.alertRule.findFirst({ where: { projectId, id }, include: { state: true } });
  return r ? shape(r) : null;
}

export async function deleteAlertRule(projectId: string, id: string) {
  await prisma.alertRule.deleteMany({ where: { projectId, id } });
  return { deleted: true };
}

// ── Cost budgets ─────────────────────────────────────────────────────────────────

interface CostBudgetRow {
  monthlyUsd: number;
  thresholds: unknown;
  notifiedThreshold: number;
  channels: unknown;
  createdAt: Date;
}

function shapeBudget(b: CostBudgetRow | null) {
  if (!b) return null;
  return {
    monthlyUsd: b.monthlyUsd,
    thresholds: parseThresholds(b.thresholds),
    channels: parseChannels(b.channels),
    createdAt: b.createdAt.toISOString(),
  };
}

function parseThresholds(raw: unknown): number[] {
  if (!Array.isArray(raw)) return [0.5, 0.8, 1.0];
  const steps = raw.filter((n): n is number => typeof n === "number" && n > 0).sort((a, b) => a - b);
  return steps.length > 0 ? steps : [0.5, 0.8, 1.0];
}

export async function getCostBudget(projectId: string) {
  const b = await prisma.costBudget.findUnique({ where: { projectId } });
  return shapeBudget(b);
}

export interface CostBudgetInput {
  monthlyUsd: number;
  thresholds?: number[];
  channels?: Channel[];
}

export async function setCostBudget(projectId: string, input: CostBudgetInput) {
  const data = {
    monthlyUsd: input.monthlyUsd,
    thresholds: (input.thresholds ?? [0.5, 0.8, 1.0]) as object,
    channels: (input.channels ?? []) as object,
  };
  const b = await prisma.costBudget.upsert({
    where: { projectId },
    // Changing the budget resets the notified step so the new budget re-notifies cleanly.
    update: { ...data, notifiedThreshold: 0 },
    create: { projectId, ...data },
  });
  return shapeBudget(b);
}

export async function deleteCostBudget(projectId: string) {
  await prisma.costBudget.deleteMany({ where: { projectId } });
  return { deleted: true };
}

// ── Evaluation (worker cron) ───────────────────────────────────────────────────────

/** Whether `value` breaches `threshold` under `comparator`. */
function breaches(value: number, comparator: string, threshold: number): boolean {
  switch (comparator) {
    case "gte":
      return value >= threshold;
    case "lt":
      return value < threshold;
    case "lte":
      return value <= threshold;
    default:
      return value > threshold; // gt
  }
}

// Anomaly detection: instead of a fixed threshold, compare the current window to a rolling
// baseline. `threshold` is reused as the z-score sensitivity (e.g. 3 = 3σ).
const ANOMALY_BUCKETS = Number(process.env.ALERT_ANOMALY_BUCKETS ?? 12);
const ANOMALY_MIN_BASELINE = Number(process.env.ALERT_ANOMALY_MIN_BASELINE ?? 5);

export function isAnomalyComparator(comparator: string): boolean {
  return comparator === "anomaly_high" || comparator === "anomaly_low";
}

/** Extract an alert metric's scalar from a window aggregate (null = not a window-based metric). */
function metricFromWindow(metric: string, win: WindowMetric): number | null {
  switch (metric) {
    case "error_rate":
      return win.generations > 0 ? win.errors / win.generations : 0;
    case "latency_p95":
      return win.p95_latency_ms;
    case "cost_per_day":
      return win.total_cost;
    case "ingest_volume":
      return win.trace_count;
    default:
      return null;
  }
}

/**
 * Z-score the newest value (last element) against the rolling baseline (all prior buckets).
 * Returns null — no fire — when there's too little history or the baseline is flat (stddev≈0),
 * so a brand-new or perfectly-steady metric never false-positives. `sensitivity` is the z
 * threshold; `anomaly_high` fires on spikes, `anomaly_low` on drops.
 */
export function anomalyBreach(
  values: number[],
  direction: "high" | "low",
  sensitivity: number,
): { breached: boolean; value: number; z: number } | null {
  if (values.length < ANOMALY_MIN_BASELINE + 1) return null;
  const current = values[values.length - 1]!;
  const baseline = values.slice(0, -1);
  const mean = baseline.reduce((a, b) => a + b, 0) / baseline.length;
  const std = Math.sqrt(baseline.reduce((a, b) => a + (b - mean) ** 2, 0) / baseline.length);
  if (std < 1e-9) return null;
  const z = (current - mean) / std;
  const breached = direction === "high" ? z >= sensitivity : z <= -sensitivity;
  return { breached, value: current, z };
}

const windowKey = (projectId: string, window: number) => `${projectId}:${window}`;

/**
 * Prefetch the window metrics every rule needs, batched by window: one grouped Doris query
 * per distinct window (across all its projects), run with bounded concurrency. This makes a
 * sweep O(distinct windows) queries instead of O(rules) — the key scalability lever as the
 * project/rule count grows. dlq_depth rules need no telemetry read (injected by the worker).
 */
async function prefetchWindows(
  rules: { projectId: string; metric: string; window: number }[],
): Promise<Map<string, WindowMetric>> {
  const projectsByWindow = new Map<number, Set<string>>();
  for (const r of rules) {
    if (r.metric === "dlq_depth") continue;
    (projectsByWindow.get(r.window) ?? projectsByWindow.set(r.window, new Set()).get(r.window)!).add(r.projectId);
  }
  const cache = new Map<string, WindowMetric>();
  await mapConcurrent([...projectsByWindow.entries()], METRIC_FETCH_CONCURRENCY, async ([window, projectIds]) => {
    try {
      const byProject = await telemetry().metricsWindowByProjects([...projectIds], window);
      for (const [projectId, metric] of byProject) cache.set(windowKey(projectId, window), metric);
    } catch (err) {
      // Leave this window's projects uncached → those rules skip this tick (no false transition).
      console.error(`[alerts] window ${window}m fetch failed:`, err instanceof Error ? err.message : err);
    }
  });
  return cache;
}

/** The current value of an alert metric from the prefetched cache. Null → can't compute (skip). */
function ruleValue(
  rule: { projectId: string; metric: string; window: number },
  cache: Map<string, WindowMetric>,
  ctx: AlertContext,
): number | null {
  if (rule.metric === "dlq_depth") return ctx.dlqDepth ?? null; // global queue depth, injected by the worker
  if (rule.metric === "rehydrate_rate") return ctx.rehydrateRate ?? null; // global rehydrate/min, injected too
  const win = cache.get(windowKey(rule.projectId, rule.window));
  if (!win) return null; // fetch failed for this window → skip
  return metricFromWindow(rule.metric, win);
}

/**
 * Prefetch the trailing metric series each anomaly rule needs (one per distinct project+window).
 * Threshold rules don't use this. Kept separate from prefetchWindows so non-anomaly sweeps pay
 * nothing.
 */
async function prefetchSeries(
  rules: { projectId: string; metric: string; window: number; comparator: string }[],
): Promise<Map<string, WindowMetric[]>> {
  const targets = new Map<string, { projectId: string; window: number }>();
  for (const r of rules) {
    if (!isAnomalyComparator(r.comparator) || r.metric === "dlq_depth" || r.metric === "rehydrate_rate") continue;
    targets.set(windowKey(r.projectId, r.window), { projectId: r.projectId, window: r.window });
  }
  const cache = new Map<string, WindowMetric[]>();
  await mapConcurrent([...targets.entries()], METRIC_FETCH_CONCURRENCY, async ([key, { projectId, window }]) => {
    try {
      cache.set(key, await telemetry().metricWindowSeries(projectId, window, ANOMALY_BUCKETS));
    } catch (err) {
      console.error(`[alerts] series ${window}m fetch failed:`, err instanceof Error ? err.message : err);
    }
  });
  return cache;
}

function alertSlackText(rule: AlertRuleRow, projectId: string, value: number, firing: boolean): string {
  const state = firing ? ":rotating_light: FIRING" : ":white_check_mark: RESOLVED";
  return `*memoturn alert* ${state} — \`${rule.name}\` · ${rule.metric} ${rule.comparator} ${rule.threshold} (now ${round(value)}) · project: ${projectId}`;
}

const round = (n: number) => Math.round(n * 1000) / 1000;

/** Build the full multi-channel message for an alert transition (slack/webhook/pagerduty/email). */
function alertMessage(rule: AlertRuleRow, projectId: string, value: number, firing: boolean): ChannelMessage {
  const summary = `memoturn alert ${firing ? "FIRING" : "RESOLVED"} — ${rule.name}: ${rule.metric} ${rule.comparator} ${rule.threshold} (now ${round(value)}) · project ${projectId}`;
  return {
    slackText: alertSlackText(rule, projectId, value, firing),
    webhookBody: {
      alert: rule.name,
      projectId,
      metric: rule.metric,
      comparator: rule.comparator,
      threshold: rule.threshold,
      value,
      status: firing ? "firing" : "resolved",
    },
    summary,
    body: summary,
    severity: firing ? "critical" : "info",
    // Stable per rule so PagerDuty pairs the trigger + resolve and auto-closes the incident.
    dedupKey: `memoturn-alert-${rule.id}`,
    resolved: !firing,
  };
}

/**
 * Deliver a message to every channel. Returns true when there was nothing to send (no channels
 * configured — the transition is UI-only) OR at least one channel accepted it. A false return
 * means every channel failed, and the caller must NOT commit the state transition yet, so the
 * next tick retries instead of silently dropping the page.
 */
async function notify(channels: Channel[], message: ChannelMessage): Promise<boolean> {
  if (channels.length === 0) return true;
  const results = await mapConcurrent(channels, DISPATCH_CONCURRENCY, (ch) => deliverToChannel(ch, message));
  return results.some((ok) => ok);
}

/**
 * Evaluate every enabled alert rule across all projects and transition firing/resolved
 * state, notifying only on transitions. Called by the worker `alert-eval` cron under a lock.
 * `ctx.dlqDepth` (global DLQ queue depth) is injected by the worker for dlq_depth rules.
 * Never throws for one bad rule — failures are isolated so the sweep completes.
 */
export async function evaluateAllAlerts(ctx: AlertContext = {}): Promise<{ evaluated: number; fired: number }> {
  const rules = await prisma.alertRule.findMany({ where: { enabled: true }, include: { state: true } });
  const [windows, seriesCache] = await Promise.all([prefetchWindows(rules), prefetchSeries(rules)]);
  let fired = 0;
  for (const rule of rules) {
    try {
      let value: number;
      let breached: boolean;
      if (isAnomalyComparator(rule.comparator)) {
        const series = seriesCache.get(windowKey(rule.projectId, rule.window));
        if (!series) continue; // fetch failed
        const values = series.map((w) => metricFromWindow(rule.metric, w));
        if (values.some((v) => v === null)) continue; // anomaly unsupported for this metric (e.g. dlq_depth)
        const res = anomalyBreach(
          values as number[],
          rule.comparator === "anomaly_high" ? "high" : "low",
          rule.threshold,
        );
        if (!res) continue; // insufficient history / flat baseline → no fire
        value = res.value;
        breached = res.breached;
      } else {
        const v = ruleValue(rule, windows, ctx);
        if (v === null) continue;
        value = v;
        breached = breaches(value, rule.comparator, rule.threshold);
      }
      const status = rule.state?.status ?? "ok";
      const channels = parseChannels(rule.channels);
      if (breached && status !== "firing") {
        // Notify FIRST and only commit "firing" once a channel accepts the page. If we persisted
        // "firing" before a failed delivery, the next tick would see status=firing, treat it as
        // "no transition", and never retry — the page would be lost forever. On failure keep the
        // prior status so the next tick retries, while still refreshing lastValue for the UI.
        const delivered = await notify(channels, alertMessage(rule, rule.projectId, value, true));
        await prisma.alertState.upsert({
          where: { ruleId: rule.id },
          update: delivered ? { status: "firing", lastValue: value, lastFiredAt: new Date() } : { lastValue: value },
          create: delivered
            ? { ruleId: rule.id, status: "firing", lastValue: value, lastFiredAt: new Date() }
            : { ruleId: rule.id, status, lastValue: value },
        });
        if (delivered) fired++;
      } else if (!breached && status === "firing") {
        // Same rule for the all-clear: don't claim "resolved" until the notification lands, so a
        // failed delivery is retried next tick rather than silently dropped.
        const delivered = await notify(channels, alertMessage(rule, rule.projectId, value, false));
        await prisma.alertState.upsert({
          where: { ruleId: rule.id },
          update: delivered
            ? { status: "resolved", lastValue: value, lastResolvedAt: new Date() }
            : { lastValue: value },
          create: delivered
            ? { ruleId: rule.id, status: "resolved", lastValue: value, lastResolvedAt: new Date() }
            : { ruleId: rule.id, status, lastValue: value },
        });
      } else {
        // No transition — keep lastValue fresh for the UI.
        await prisma.alertState.upsert({
          where: { ruleId: rule.id },
          update: { lastValue: value },
          create: { ruleId: rule.id, status, lastValue: value },
        });
      }
    } catch (err) {
      console.error(`[alerts] rule ${rule.id} failed:`, err instanceof Error ? err.message : err);
    }
  }
  return { evaluated: rules.length, fired };
}

/** Days elapsed since the start of the current UTC month (so metricsByModel covers MTD). */
function daysSinceMonthStart(): number {
  return new Date().getUTCDate() - 1;
}

/**
 * Evaluate cost budgets: compare month-to-date spend to each percentage step of the
 * monthly budget and notify once per newly-crossed step. When MTD spend drops below the
 * lowest step (a new month), reset the notified marker so the next month re-notifies.
 */
export async function evaluateBudgets(): Promise<{ evaluated: number; notified: number }> {
  const budgets = await prisma.costBudget.findMany();
  const daysAgo = daysSinceMonthStart();
  const active = budgets.filter((b) => b.monthlyUsd > 0);

  // Batch the month-to-date cost reads (one metricsByModel per project) with bounded
  // concurrency so the budget sweep doesn't serialize a Doris query per project.
  const costByProject = new Map<string, number>();
  await mapConcurrent(active, METRIC_FETCH_CONCURRENCY, async (b) => {
    try {
      const byModel = await telemetry().metricsByModel(b.projectId, daysAgo);
      costByProject.set(
        b.projectId,
        byModel.reduce((s, m) => s + m.total_cost, 0),
      );
    } catch (err) {
      console.error(`[budgets] project ${b.projectId} fetch failed:`, err instanceof Error ? err.message : err);
    }
  });

  let notified = 0;
  for (const b of active) {
    try {
      const mtdCost = costByProject.get(b.projectId);
      if (mtdCost === undefined) continue; // fetch failed → skip this tick
      const ratio = mtdCost / b.monthlyUsd;
      const steps = parseThresholds(b.thresholds);
      const channels = parseChannels(b.channels);

      // New billing cycle: spend fell below the lowest step → reset notifications.
      if (ratio < steps[0]! && b.notifiedThreshold > 0) {
        await prisma.costBudget.update({ where: { id: b.id }, data: { notifiedThreshold: 0 } });
        continue;
      }
      // Highest step crossed but not yet notified.
      const crossed = steps.filter((s) => ratio >= s && s > b.notifiedThreshold);
      if (crossed.length === 0) continue;
      const step = Math.max(...crossed);
      const pct = Math.round(step * 100);
      const summary = `memoturn budget ${pct}% of $${b.monthlyUsd}/mo reached — spent $${round(mtdCost)} · project ${b.projectId}`;
      // Notify FIRST: only advance notifiedThreshold once delivery lands, else a failed
      // notification would permanently suppress this step (next tick sees it already "notified").
      const delivered = await notify(channels, {
        slackText: `*memoturn budget* :moneybag: ${summary}`,
        webhookBody: { budget: b.projectId, monthlyUsd: b.monthlyUsd, spent: mtdCost, step, ratio },
        summary,
        body: summary,
        severity: step >= 1 ? "critical" : "warning",
        // Per budget+step so PagerDuty shows each threshold crossing as its own alert.
        dedupKey: `memoturn-budget-${b.id}-${pct}`,
      });
      if (!delivered) continue; // retry on the next tick
      await prisma.costBudget.update({ where: { id: b.id }, data: { notifiedThreshold: step } });
      notified++;
    } catch (err) {
      console.error(`[budgets] project ${b.projectId} failed:`, err instanceof Error ? err.message : err);
    }
  }
  return { evaluated: budgets.length, notified };
}
