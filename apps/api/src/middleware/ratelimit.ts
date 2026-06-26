import { checkRateLimit, rateLimitConfig } from "@memoturn/server";
import type { Context, Next } from "hono";
import type { AuthVars } from "./auth.js";

/**
 * Per-project rate limiting. Runs after requireAuth (so projectId is set); disabled
 * unless RATE_LIMIT_PER_MINUTE > 0. Sets X-RateLimit-* headers and returns 429 +
 * Retry-After when a project exceeds its window.
 */
export async function rateLimit(c: Context<{ Variables: AuthVars }>, next: Next) {
  const { limit, window } = rateLimitConfig();
  if (limit <= 0) return next();
  const projectId = c.get("projectId");
  if (!projectId) return next(); // unauthenticated routes (e.g. health) aren't limited

  const result = await checkRateLimit(projectId, limit, window);
  c.header("X-RateLimit-Limit", String(result.limit));
  if (result.remaining >= 0) c.header("X-RateLimit-Remaining", String(result.remaining));
  c.header("X-RateLimit-Reset", String(result.resetSeconds));
  if (!result.allowed) {
    c.header("Retry-After", String(result.resetSeconds));
    return c.json({ error: "rate limit exceeded", limit: result.limit, retryAfter: result.resetSeconds }, 429);
  }
  return next();
}
