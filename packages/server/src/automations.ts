import { prisma } from "@memoturn/db";
import { redisConnection } from "@memoturn/db/queue";
import { mapConcurrent } from "./concurrency.js";
import { isPublicUrl } from "./net.js";

/**
 * Generalized trigger->action automations. A successful trigger (score.created,
 * trace.created, eval.completed) runs each enabled automation's action: a webhook
 * (POST JSON) or a Slack message (POST { text } to an incoming webhook URL).
 *
 * Dispatch is best-effort — a failing target never breaks ingestion. Score triggers
 * honor an optional low-value `threshold`; any trigger honors an optional `filter`
 * substring matched against the entity name.
 */
export const AUTOMATION_TRIGGERS = ["score.created", "trace.created", "eval.completed"] as const;
export const AUTOMATION_ACTIONS = ["webhook", "slack"] as const;

export interface CreateAutomationInput {
  name: string;
  trigger?: string;
  action?: string;
  target: string;
  threshold?: number | null;
  filter?: string;
}

interface AutomationRow {
  id: string;
  name: string;
  trigger: string;
  action: string;
  target: string;
  threshold: number | null;
  filter: string;
  enabled: boolean;
  createdAt: Date;
}

function shape(a: AutomationRow) {
  return {
    id: a.id,
    name: a.name,
    trigger: a.trigger,
    action: a.action,
    target: a.target,
    threshold: a.threshold,
    filter: a.filter,
    enabled: a.enabled,
    createdAt: a.createdAt.toISOString(),
  };
}

// Enabled-automation lists are Redis-cached per project+trigger (same pattern as the
// masking policy / analytics sink) so batch dispatch on the ingest hot path doesn't
// hit Postgres per event. Rows carry no secrets, so caching them is safe.
const CACHE_TTL_SECONDS = 30;
const cacheKey = (projectId: string, trigger: string) => `memoturn:automations:${projectId}:${trigger}`;

/** The row fields dispatch needs (cached shape). */
interface DispatchableAutomation {
  id: string;
  action: string;
  target: string;
  threshold: number | null;
  filter: string;
}

async function loadEnabledAutomations(projectId: string, trigger: string): Promise<DispatchableAutomation[]> {
  try {
    const raw = await redisConnection().get(cacheKey(projectId, trigger));
    if (raw) return JSON.parse(raw) as DispatchableAutomation[];
  } catch {
    // fall through to DB
  }
  const rows = await prisma.automation.findMany({
    where: { projectId, trigger, enabled: true },
    select: { id: true, action: true, target: true, threshold: true, filter: true },
  });
  try {
    await redisConnection().set(cacheKey(projectId, trigger), JSON.stringify(rows), "EX", CACHE_TTL_SECONDS);
  } catch {
    // best-effort
  }
  return rows;
}

async function bustCache(projectId: string): Promise<void> {
  // deleteAutomation doesn't know the row's trigger — bust every trigger key.
  try {
    await redisConnection().del(...AUTOMATION_TRIGGERS.map((t) => cacheKey(projectId, t)));
  } catch {
    // best-effort
  }
}

export async function createAutomation(projectId: string, input: CreateAutomationInput) {
  const a = await prisma.automation.create({
    data: {
      projectId,
      name: input.name,
      trigger: input.trigger ?? "score.created",
      action: input.action ?? "webhook",
      target: input.target,
      threshold: input.threshold ?? null,
      filter: input.filter ?? "",
    },
  });
  await bustCache(projectId);
  return shape(a);
}

export async function listAutomations(projectId: string) {
  const rows = await prisma.automation.findMany({ where: { projectId }, orderBy: { createdAt: "desc" } });
  return rows.map(shape);
}

export async function deleteAutomation(projectId: string, id: string) {
  await prisma.automation.deleteMany({ where: { projectId, id } });
  await bustCache(projectId);
  return { deleted: true };
}

export interface AutomationEvent {
  name?: string;
  value?: number | null;
  traceId?: string;
  [key: string]: unknown;
}

function slackText(event: string, projectId: string, payload: AutomationEvent): string {
  const bits = [`*memoturn* trigger \`${event}\``];
  if (payload.name) bits.push(`name: ${payload.name}`);
  if (payload.value != null) bits.push(`value: ${payload.value}`);
  if (payload.traceId) bits.push(`trace: ${payload.traceId}`);
  bits.push(`project: ${projectId}`);
  return bits.join(" · ");
}

/**
 * Whether an automation should fire for a payload: an optional low-value `threshold`
 * (fire only when value < threshold) and an optional name-substring `filter`.
 */
export function automationMatches(
  rule: { threshold?: number | null; filter?: string | null },
  payload: { value?: number | null; name?: string },
): boolean {
  if (rule.threshold != null && !(payload.value != null && payload.value < rule.threshold)) return false;
  if (rule.filter && !(payload.name ?? "").includes(rule.filter)) return false;
  return true;
}

/** Outbound deliveries in flight at once per dispatch call. */
const DISPATCH_CONCURRENCY = 8;

/** A notification channel — shared by automations and the alert engine. */
export type ChannelType = "slack" | "webhook";
export interface Channel {
  type: ChannelType;
  target: string;
}

/**
 * Deliver a message to one channel. Never throws. Slack channels POST `{ text }`; webhook
 * channels POST the given JSON body. Re-checks SSRF safety at dispatch time (DNS rebinding)
 * and bounds the request to 5s. Shared by automations and alerts so the delivery hardening
 * lives in one place.
 */
export async function deliverToChannel(
  channel: Channel,
  message: { slackText: string; webhookBody: unknown },
): Promise<boolean> {
  if (!(await isPublicUrl(channel.target))) return false; // SSRF re-check at dispatch (DNS rebinding)
  const body =
    channel.type === "slack" ? JSON.stringify({ text: message.slackText }) : JSON.stringify(message.webhookBody);
  try {
    await fetch(channel.target, {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": "memoturn-automations/1" },
      body,
      signal: AbortSignal.timeout(5_000),
    });
    return true;
  } catch {
    return false; // best-effort; a failing target never breaks ingestion
  }
}

/** Deliver one payload to one automation target. Never throws. */
async function deliverAutomation(
  a: DispatchableAutomation,
  projectId: string,
  event: string,
  payload: AutomationEvent,
): Promise<boolean> {
  return deliverToChannel(
    { type: a.action as ChannelType, target: a.target },
    { slackText: slackText(event, projectId, payload), webhookBody: { event, projectId, ...payload } },
  );
}

/**
 * Fire all enabled automations for a batch of payloads: ONE (Redis-cached) config
 * lookup for the whole batch, deliveries with bounded concurrency. Threshold/filter
 * matching applies per payload.
 */
export async function dispatchAutomationsBatch(
  projectId: string,
  event: string,
  payloads: AutomationEvent[],
): Promise<number> {
  if (payloads.length === 0) return 0;
  const automations = await loadEnabledAutomations(projectId, event);
  if (automations.length === 0) return 0;
  const jobs = automations.flatMap((a) =>
    payloads.filter((payload) => automationMatches(a, payload)).map((payload) => ({ a, payload })),
  );
  const results = await mapConcurrent(jobs, DISPATCH_CONCURRENCY, ({ a, payload }) =>
    deliverAutomation(a, projectId, event, payload),
  );
  return results.filter(Boolean).length;
}

/** Fire all enabled automations whose trigger matches the event. Returns count fired. */
export async function dispatchAutomations(projectId: string, event: string, payload: AutomationEvent): Promise<number> {
  return dispatchAutomationsBatch(projectId, event, [payload]);
}
