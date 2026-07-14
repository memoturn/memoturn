import { createHmac, randomBytes } from "node:crypto";
import { prisma } from "@memoturn/db";
import { mapConcurrent } from "./concurrency.js";
import { isPublicUrl } from "./net.js";

/**
 * Outbound webhooks / automations. A webhook POSTs a JSON payload to its URL when its
 * event fires. Dispatch is best-effort (short timeout, never throws into the caller).
 * Supported event: "score.created" (with an optional low-score `threshold`).
 *
 * Each webhook has a signing `secret` (generated on create, returned ONCE). Dispatched
 * requests carry `X-Memoturn-Signature: sha256=<hmac>` and `X-Memoturn-Timestamp` so the
 * receiver can verify authenticity: hmac = HMAC_SHA256(secret, `${timestamp}.${body}`).
 */
export interface CreateWebhookInput {
  url: string;
  event?: string;
  threshold?: number | null;
}

/** Compute the signature header value for a webhook delivery. */
export function signWebhook(secret: string, timestamp: string, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;
}

export async function createWebhook(projectId: string, input: CreateWebhookInput) {
  const secret = `whsec_${randomBytes(24).toString("base64url")}`;
  const w = await prisma.webhook.create({
    data: {
      projectId,
      url: input.url,
      event: input.event ?? "score.created",
      threshold: input.threshold ?? null,
      secret,
    },
  });
  // `secret` is returned only here (never by list) so the caller can configure verification.
  return { id: w.id, url: w.url, event: w.event, threshold: w.threshold, enabled: w.enabled, secret };
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
    lastStatus: w.lastStatus,
    lastError: w.lastError,
    lastAttemptAt: w.lastAttemptAt ? w.lastAttemptAt.toISOString() : null,
    failureCount: w.failureCount,
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

/** The row fields dispatch needs (structurally satisfied by the Prisma webhook row). */
interface DispatchableWebhook {
  id: string;
  url: string;
  threshold: number | null;
  secret: string | null;
}

/** Outbound deliveries in flight at once per dispatch call. */
const DISPATCH_CONCURRENCY = 8;

/** Deliver one payload to one hook; returns whether the receiver 2xx'd. Never throws. */
async function deliverWebhook(
  h: DispatchableWebhook,
  projectId: string,
  event: string,
  payload: ScoreEvent,
): Promise<boolean> {
  if (event === "score.created" && h.threshold != null && !(payload.value != null && payload.value < h.threshold)) {
    return false; // below-threshold filter not met
  }
  if (!(await isPublicUrl(h.url))) return false; // SSRF re-check at dispatch (DNS rebinding)
  const body = JSON.stringify({ event, projectId, ...payload });
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const headers = {
    "content-type": "application/json",
    "user-agent": "memoturn-webhooks/1",
    "x-memoturn-timestamp": timestamp,
    ...(h.secret ? { "x-memoturn-signature": signWebhook(h.secret, timestamp, body) } : {}),
  };

  // Up to 3 attempts; retry only on 5xx / network errors (4xx is the receiver's choice).
  let status: number | null = null;
  let error = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(h.url, { method: "POST", headers, body, signal: AbortSignal.timeout(5_000) });
      status = res.status;
      if (res.ok) {
        error = "";
        break;
      }
      error = `HTTP ${res.status}`;
      if (res.status < 500) break; // client error — don't retry
    } catch (e) {
      status = null;
      error = e instanceof Error ? e.message : String(e);
    }
    if (attempt < 2) await new Promise((r) => setTimeout(r, 250 * 2 ** attempt));
  }

  const ok = status != null && status >= 200 && status < 300;
  // Record delivery outcome (best-effort — never throw into ingestion).
  await prisma.webhook
    .update({
      where: { id: h.id },
      data: {
        lastStatus: status,
        lastError: ok ? "" : error,
        lastAttemptAt: new Date(),
        failureCount: ok ? 0 : { increment: 1 },
      },
    })
    .catch(() => {});
  return ok;
}

/**
 * Fire all enabled webhooks for a batch of payloads: ONE config lookup for the whole
 * batch (the per-payload variant was an N+1 on the ingest hot path), deliveries with
 * bounded concurrency. `score.created` honors the `threshold` filter per payload.
 */
export async function dispatchWebhooksBatch(projectId: string, event: string, payloads: ScoreEvent[]): Promise<number> {
  if (payloads.length === 0) return 0;
  const hooks = await prisma.webhook.findMany({ where: { projectId, event, enabled: true } });
  if (hooks.length === 0) return 0;
  const jobs = hooks.flatMap((h) => payloads.map((payload) => ({ h, payload })));
  const results = await mapConcurrent(jobs, DISPATCH_CONCURRENCY, ({ h, payload }) =>
    deliverWebhook(h, projectId, event, payload),
  );
  return results.filter(Boolean).length;
}

/** Fire all enabled webhooks for one event payload. */
export async function dispatchWebhooks(projectId: string, event: string, payload: ScoreEvent): Promise<number> {
  return dispatchWebhooksBatch(projectId, event, [payload]);
}
