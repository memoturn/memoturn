import { checkRateLimit, rateLimitConfig } from "@memoturn/server";
import type { Context, Next } from "hono";
import type { AuthVars } from "./auth.js";

/**
 * Rate limiting. Runs after requireAuth. A per-key limit (apiKeyRateLimit) takes
 * precedence and applies even when the global RATE_LIMIT_PER_MINUTE is disabled,
 * counted per key; otherwise the global per-project limit applies when configured.
 * Sets X-RateLimit-* headers and returns 429 + Retry-After when the window is exceeded.
 */
export async function rateLimit(c: Context<{ Variables: AuthVars }>, next: Next) {
  const projectId = c.get("projectId");
  if (!projectId) return next(); // unauthenticated routes (e.g. health) aren't limited

  const { limit: globalLimit, window } = rateLimitConfig();
  const apiKeyId = c.get("apiKeyId");
  const keyLimit = c.get("apiKeyRateLimit");

  let id: string;
  let limit: number;
  if (apiKeyId && keyLimit && keyLimit > 0) {
    id = `key:${apiKeyId}`;
    limit = keyLimit;
  } else if (globalLimit > 0) {
    id = projectId;
    limit = globalLimit;
  } else {
    return next(); // no limiting configured
  }

  const result = await checkRateLimit(id, limit, window);
  c.header("X-RateLimit-Limit", String(result.limit));
  if (result.remaining >= 0) c.header("X-RateLimit-Remaining", String(result.remaining));
  c.header("X-RateLimit-Reset", String(result.resetSeconds));
  if (!result.allowed) {
    c.header("Retry-After", String(result.resetSeconds));
    return c.json({ error: "rate limit exceeded", limit: result.limit, retryAfter: result.resetSeconds }, 429);
  }
  return next();
}
