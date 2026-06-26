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

/** Count one request against a project's window. `limit <= 0` disables (always allowed). */
export async function checkRateLimit(
  projectId: string,
  limit: number,
  window = WINDOW_SECONDS,
): Promise<RateLimitResult> {
  if (limit <= 0) return { allowed: true, limit: 0, remaining: -1, resetSeconds: 0 };
  const now = Math.floor(Date.now() / 1000);
  const windowStart = now - (now % window);
  const resetSeconds = windowStart + window - now;
  const key = `memoturn:ratelimit:${projectId}:${windowStart}`;
  try {
    const redis = redisConnection();
    const count = await redis.incr(key);
    if (count === 1) await redis.expire(key, window);
    return { allowed: count <= limit, limit, remaining: Math.max(0, limit - count), resetSeconds };
  } catch {
    // fail-open: never block traffic on a Redis outage
    return { allowed: true, limit, remaining: -1, resetSeconds };
  }
}
