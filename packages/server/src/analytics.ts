import { prisma } from "@memoturn/db";
import { redisConnection } from "@memoturn/db/queue";

/**
 * Product-analytics sink: forward trace/score events to PostHog (capture API) so teams
 * can build funnels/retention over their LLM usage. Config is per-project and cached in
 * Redis; forwarding is best-effort (a failing sink never breaks ingestion).
 */
const CACHE_TTL_SECONDS = 30;
const cacheKey = (projectId: string) => `memoturn:analytics:${projectId}`;

interface SinkRow {
  enabled: boolean;
  type: string;
  host: string;
  apiKey: string;
}

const DEFAULT: SinkRow = { enabled: false, type: "posthog", host: "https://us.i.posthog.com", apiKey: "" };

export async function getAnalyticsSink(projectId: string) {
  const s = await prisma.analyticsSink.findUnique({ where: { projectId } });
  return s ? { enabled: s.enabled, type: s.type, host: s.host, apiKey: s.apiKey } : DEFAULT;
}

export interface SetAnalyticsSinkInput {
  enabled?: boolean;
  host?: string;
  apiKey?: string;
}

export async function setAnalyticsSink(projectId: string, input: SetAnalyticsSinkInput) {
  const data = {
    enabled: input.enabled ?? false,
    host: input.host ?? DEFAULT.host,
    apiKey: input.apiKey ?? "",
  };
  const s = await prisma.analyticsSink.upsert({
    where: { projectId },
    update: data,
    create: { projectId, type: "posthog", ...data },
  });
  await bustCache(projectId);
  return { enabled: s.enabled, type: s.type, host: s.host, apiKey: s.apiKey };
}

async function loadSink(projectId: string): Promise<SinkRow | null> {
  try {
    const raw = await redisConnection().get(cacheKey(projectId));
    if (raw) return JSON.parse(raw) as SinkRow;
  } catch {
    // fall through to DB
  }
  const sink = await getAnalyticsSink(projectId);
  try {
    await redisConnection().set(cacheKey(projectId), JSON.stringify(sink), "EX", CACHE_TTL_SECONDS);
  } catch {
    // best-effort
  }
  return sink;
}

async function bustCache(projectId: string) {
  try {
    await redisConnection().del(cacheKey(projectId));
  } catch {
    // best-effort
  }
}

/** Forward one event to the project's analytics sink (best-effort, no-op if disabled). */
export async function forwardEvent(
  projectId: string,
  event: string,
  distinctId: string,
  properties: Record<string, unknown>,
): Promise<boolean> {
  const sink = await loadSink(projectId);
  if (!sink?.enabled || sink.type !== "posthog" || !sink.apiKey) return false;
  try {
    await fetch(`${sink.host.replace(/\/$/, "")}/capture/`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        api_key: sink.apiKey,
        event,
        distinct_id: distinctId || `project:${projectId}`,
        properties: { ...properties, memoturn_project: projectId },
      }),
      signal: AbortSignal.timeout(5_000),
    });
    return true;
  } catch {
    return false; // best-effort
  }
}
