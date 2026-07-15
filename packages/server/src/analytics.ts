import { prisma } from "@memoturn/db";
import { redisConnection } from "@memoturn/db/queue";
import { decryptSecret, encryptSecret, maskSecret } from "@memoturn/llm";
import { isPublicUrl } from "./net.js";

/**
 * Event sink (CDP forwarding): forward trace/score events to a customer's product-analytics
 * endpoint so teams can build funnels/retention over their LLM usage. The wire format is
 * PostHog's capture `/batch/` API (also accepted by Segment, Jitsu, and self-hosted PostHog),
 * hence the internal `type: "posthog"` discriminator. Config is per-project and cached in
 * Redis; forwarding is best-effort (a failing sink never breaks ingestion).
 *
 * The capture API key is encrypted at rest (AES-256-GCM, same scheme as provider keys) and
 * only ever returned masked. Redis caches the ciphertext form — never plaintext.
 */
const CACHE_TTL_SECONDS = 30;
const cacheKey = (projectId: string) => `memoturn:analytics:${projectId}`;

/** Raw stored sink — `encryptedKey` holds ciphertext (or "" when unset). */
interface StoredSink {
  enabled: boolean;
  type: string;
  host: string;
  encryptedKey: string;
}

/** Resolved sink for dispatch — `apiKey` is the decrypted plaintext. */
interface ResolvedSink {
  enabled: boolean;
  type: string;
  host: string;
  apiKey: string;
}

const DEFAULT: StoredSink = { enabled: false, type: "posthog", host: "https://us.i.posthog.com", encryptedKey: "" };

/** Decrypt a stored key; "" if unset or unreadable (e.g. after an ENCRYPTION_KEY rotation). */
function decryptKey(encryptedKey: string): string {
  if (!encryptedKey) return "";
  try {
    return decryptSecret(encryptedKey);
  } catch {
    return "";
  }
}

async function getStoredSink(projectId: string): Promise<StoredSink> {
  const s = await prisma.analyticsSink.findUnique({ where: { projectId } });
  return s ? { enabled: s.enabled, type: s.type, host: s.host, encryptedKey: s.apiKey } : DEFAULT;
}

/** Masked view for the config endpoint — the key is never returned in plaintext. */
function maskedView(s: StoredSink) {
  const key = decryptKey(s.encryptedKey);
  return { enabled: s.enabled, type: s.type, host: s.host, apiKey: key ? maskSecret(key) : "" };
}

export async function getAnalyticsSink(projectId: string) {
  return maskedView(await getStoredSink(projectId));
}

export interface SetAnalyticsSinkInput {
  enabled?: boolean;
  host?: string;
  apiKey?: string;
}

export async function setAnalyticsSink(projectId: string, input: SetAnalyticsSinkInput) {
  const existing = await prisma.analyticsSink.findUnique({ where: { projectId } });
  // Re-encrypt only when a real new key is supplied. The console only ever sees the masked
  // value (leading "…"), so an omitted/empty/masked input preserves the stored key.
  const fresh = input.apiKey && !input.apiKey.startsWith("…") ? input.apiKey : undefined;
  const data = {
    enabled: input.enabled ?? false,
    host: input.host ?? DEFAULT.host,
    apiKey: fresh ? encryptSecret(fresh) : (existing?.apiKey ?? ""),
  };
  const s = await prisma.analyticsSink.upsert({
    where: { projectId },
    update: data,
    create: { projectId, type: "posthog", ...data },
  });
  await bustCache(projectId);
  return maskedView({ enabled: s.enabled, type: s.type, host: s.host, encryptedKey: s.apiKey });
}

/** Load the sink for dispatch (decrypted). Redis holds only the ciphertext form. */
async function loadSink(projectId: string): Promise<ResolvedSink> {
  let stored: StoredSink | null = null;
  try {
    const raw = await redisConnection().get(cacheKey(projectId));
    if (raw) stored = JSON.parse(raw) as StoredSink;
  } catch {
    // fall through to DB
  }
  if (!stored) {
    stored = await getStoredSink(projectId);
    try {
      await redisConnection().set(cacheKey(projectId), JSON.stringify(stored), "EX", CACHE_TTL_SECONDS);
    } catch {
      // best-effort
    }
  }
  return { enabled: stored.enabled, type: stored.type, host: stored.host, apiKey: decryptKey(stored.encryptedKey) };
}

async function bustCache(projectId: string) {
  try {
    await redisConnection().del(cacheKey(projectId));
  } catch {
    // best-effort
  }
}

export interface AnalyticsEvent {
  event: string;
  distinctId: string;
  properties: Record<string, unknown>;
}

/** PostHog /batch/ payload cap per request. */
const BATCH_CHUNK = 500;

/**
 * Forward a batch of events to the project's analytics sink (best-effort, no-op if
 * disabled). One sink load + SSRF check + one POST to PostHog's /batch/ endpoint per
 * chunk — the per-event variant was one HTTP roundtrip per event on the ingest path.
 * Returns the number of events sent.
 */
export async function forwardEvents(projectId: string, events: AnalyticsEvent[]): Promise<number> {
  if (events.length === 0) return 0;
  const sink = await loadSink(projectId);
  if (!sink?.enabled || sink.type !== "posthog" || !sink.apiKey) return 0;
  const batchUrl = `${sink.host.replace(/\/$/, "")}/batch/`;
  if (!(await isPublicUrl(batchUrl))) return 0; // SSRF re-check at dispatch
  let sent = 0;
  for (let i = 0; i < events.length; i += BATCH_CHUNK) {
    const chunk = events.slice(i, i + BATCH_CHUNK);
    try {
      await fetch(batchUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          api_key: sink.apiKey,
          batch: chunk.map((e) => ({
            event: e.event,
            distinct_id: e.distinctId || `project:${projectId}`,
            properties: { ...e.properties, memoturn_project: projectId },
          })),
        }),
        signal: AbortSignal.timeout(5_000),
      });
      sent += chunk.length;
    } catch {
      // best-effort per chunk
    }
  }
  return sent;
}

/** Forward one event to the project's analytics sink (best-effort, no-op if disabled). */
export async function forwardEvent(
  projectId: string,
  event: string,
  distinctId: string,
  properties: Record<string, unknown>,
): Promise<boolean> {
  return (await forwardEvents(projectId, [{ event, distinctId, properties }])) > 0;
}
