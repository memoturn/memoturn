import { redisConnection } from "@memoturn/db/queue";

/**
 * Per-project API rate limiting, Redis-backed (fixed window). The limit is a global
 * default from RATE_LIMIT_PER_MINUTE (0 = disabled); each project gets its own counter,
 * so projects are isolated from one another. Fails open if Redis is unavailable — a
 * cache outage must never take the API down.
 */
const WINDOW_SECONDS = 60;

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetSeconds: number;
}

export function rateLimitConfig(): { limit: number; window: number } {
  return { limit: Number(process.env.RATE_LIMIT_PER_MINUTE ?? 0), window: WINDOW_SECONDS };
}

/**
 * Separate budget for ingested EVENTS per minute (INGEST_EVENTS_PER_MINUTE, 0 = disabled).
 * The request-count limit alone is bypassable by packing up to 1000 events into one POST;
 * this meters the actual event volume. Counted on a distinct key from the request limit.
 */
export function ingestRateLimitConfig(): { limit: number; window: number } {
  return { limit: Number(process.env.INGEST_EVENTS_PER_MINUTE ?? 0), window: WINDOW_SECONDS };
}

/**
 * Per-IP budget for the unauthenticated remote MCP endpoint (MCP_RATE_LIMIT_PER_MINUTE).
 * Unlike the project limiter this defaults to ON (120/min) because the endpoint runs a
 * credential lookup before auth resolves — an attacker shouldn't get unthrottled tries.
 * Set to 0 to disable.
 */
export function mcpRateLimitConfig(): { limit: number; window: number } {
  const raw = process.env.MCP_RATE_LIMIT_PER_MINUTE;
  return { limit: raw === undefined ? 120 : Number(raw), window: WINDOW_SECONDS };
}

/** Fixed-window math for a given clock (seconds): the window start + seconds until reset. */
export function rateLimitWindow(
  nowSeconds: number,
  window = WINDOW_SECONDS,
): { windowStart: number; resetSeconds: number } {
  const windowStart = nowSeconds - (nowSeconds % window);
  return { windowStart, resetSeconds: windowStart + window - nowSeconds };
}

/**
 * Count `cost` units against a project's window (default 1 = one request). `limit <= 0`
 * disables (always allowed). Pass cost = batch length to meter by event volume.
 */
export async function checkRateLimit(
  projectId: string,
  limit: number,
  window = WINDOW_SECONDS,
  cost = 1,
): Promise<RateLimitResult> {
  if (limit <= 0) return { allowed: true, limit: 0, remaining: -1, resetSeconds: 0 };
  const now = Math.floor(Date.now() / 1000);
  const { windowStart, resetSeconds } = rateLimitWindow(now, window);
  const key = `memoturn:ratelimit:${projectId}:${windowStart}`;
  try {
    const redis = redisConnection();
    const count = cost === 1 ? await redis.incr(key) : await redis.incrby(key, cost);
    if (count === cost) await redis.expire(key, window); // first write in this window
    return { allowed: count <= limit, limit, remaining: Math.max(0, limit - count), resetSeconds };
  } catch {
    // fail-open: never block traffic on a Redis outage
    return { allowed: true, limit, remaining: -1, resetSeconds };
  }
}
