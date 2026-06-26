import { prisma } from "@memoturn/db";

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
  return shape(a);
}

export async function listAutomations(projectId: string) {
  const rows = await prisma.automation.findMany({ where: { projectId }, orderBy: { createdAt: "desc" } });
  return rows.map(shape);
}

export async function deleteAutomation(projectId: string, id: string) {
  await prisma.automation.deleteMany({ where: { projectId, id } });
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

/** Fire all enabled automations whose trigger matches the event. Returns count fired. */
export async function dispatchAutomations(projectId: string, event: string, payload: AutomationEvent): Promise<number> {
  const automations = await prisma.automation.findMany({ where: { projectId, trigger: event, enabled: true } });
  let fired = 0;
  await Promise.all(
    automations.map(async (a) => {
      // Score threshold: only fire when value is below the threshold.
      if (a.threshold != null && !(payload.value != null && payload.value < a.threshold)) return;
      // Name filter: substring match against the entity name.
      if (a.filter && !(payload.name ?? "").includes(a.filter)) return;

      const body =
        a.action === "slack"
          ? JSON.stringify({ text: slackText(event, projectId, payload) })
          : JSON.stringify({ event, projectId, ...payload });
      try {
        await fetch(a.target, {
          method: "POST",
          headers: { "content-type": "application/json", "user-agent": "memoturn-automations/1" },
          body,
          signal: AbortSignal.timeout(5_000),
        });
        fired++;
      } catch {
        // best-effort; a failing target never breaks ingestion
      }
    }),
  );
  return fired;
}
