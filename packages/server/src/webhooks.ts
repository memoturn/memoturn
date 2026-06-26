import { prisma } from "@memoturn/db";

/**
 * Outbound webhooks / automations. A webhook POSTs a JSON payload to its URL when its
 * event fires. Dispatch is best-effort (short timeout, never throws into the caller).
 * Supported event: "score.created" (with an optional low-score `threshold`).
 */
export interface CreateWebhookInput {
  url: string;
  event?: string;
  threshold?: number | null;
}

export async function createWebhook(projectId: string, input: CreateWebhookInput) {
  const w = await prisma.webhook.create({
    data: { projectId, url: input.url, event: input.event ?? "score.created", threshold: input.threshold ?? null },
  });
  return { id: w.id, url: w.url, event: w.event, threshold: w.threshold, enabled: w.enabled };
}

export async function listWebhooks(projectId: string) {
  const ws = await prisma.webhook.findMany({ where: { projectId }, orderBy: { createdAt: "desc" } });
  return ws.map((w) => ({
    id: w.id,
    url: w.url,
    event: w.event,
    threshold: w.threshold,
    enabled: w.enabled,
    createdAt: w.createdAt.toISOString(),
  }));
}

export async function deleteWebhook(projectId: string, id: string) {
  await prisma.webhook.deleteMany({ where: { projectId, id } });
  return { deleted: true };
}

export interface ScoreEvent {
  traceId: string;
  name: string;
  value: number | null;
  source: string;
}

/** Fire all enabled webhooks for an event. `score.created` honors the `threshold` filter. */
export async function dispatchWebhooks(projectId: string, event: string, payload: ScoreEvent): Promise<number> {
  const hooks = await prisma.webhook.findMany({ where: { projectId, event, enabled: true } });
  let fired = 0;
  await Promise.all(
    hooks.map(async (h) => {
      if (event === "score.created" && h.threshold != null && !(payload.value != null && payload.value < h.threshold)) {
        return; // below-threshold filter not met
      }
      try {
        await fetch(h.url, {
          method: "POST",
          headers: { "content-type": "application/json", "user-agent": "memoturn-webhooks/1" },
          body: JSON.stringify({ event, projectId, ...payload }),
          signal: AbortSignal.timeout(5_000),
        });
        fired++;
      } catch {
        // best-effort; a failing endpoint never breaks ingestion
      }
    }),
  );
  return fired;
}
