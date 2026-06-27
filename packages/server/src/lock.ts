import { randomBytes } from "node:crypto";
import { redisConnection } from "@memoturn/db/queue";

/**
 * Best-effort distributed lock (Redis SET NX EX). Maintenance crons (retention, exports)
 * have no coordination — two workers, or a manual API trigger overlapping the cron, could
 * run them concurrently and produce duplicate exports / racing deletes. `withLock` lets a
 * named job run at most once at a time.
 *
 * Returns the fn result, or null if the lock was already held (skipped). If Redis is
 * unavailable it runs WITHOUT the lock rather than skipping maintenance entirely.
 */
export async function withLock<T>(name: string, ttlSeconds: number, fn: () => Promise<T>): Promise<T | null> {
  const key = `memoturn:lock:${name}`;
  const token = randomBytes(12).toString("hex");
  const redis = redisConnection();

  let acquired = false;
  try {
    const res = await redis.set(key, token, "EX", ttlSeconds, "NX");
    acquired = res === "OK";
  } catch {
    return fn(); // Redis down — don't block maintenance
  }
  if (!acquired) return null;

  try {
    return await fn();
  } finally {
    try {
      // Release only if we still own the lock (avoid deleting someone else's after TTL).
      if ((await redis.get(key)) === token) await redis.del(key);
    } catch {
      // best-effort release; the TTL will expire it anyway
    }
  }
}
