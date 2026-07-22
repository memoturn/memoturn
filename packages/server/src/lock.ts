import { randomBytes } from "node:crypto";
import { redisConnection } from "@memoturn/db/queue";

/**
 * Best-effort distributed lock (Redis SET NX EX). Maintenance crons (retention, exports)
 * have no coordination — two workers, or a manual API trigger overlapping the cron, could
 * run them concurrently and produce duplicate exports / racing deletes. `withLock` lets a
 * named job run at most once at a time.
 *
 * Returns the fn result, or null if the lock was already held (skipped). While the job runs
 * the TTL is renewed on a heartbeat, so a job slower than `ttlSeconds` can't have its lock
 * expire mid-run and let a second replica start; if the process dies, renewal stops and the
 * TTL lets another replica take over. Release is an atomic owner-checked compare-and-delete.
 */

// Only delete / renew if we still own the lock — a plain GET+DEL races with another holder
// that acquired after our TTL expired. Run atomically as a Lua script.
const RELEASE_LUA = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";
const RENEW_LUA =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('expire', KEYS[1], ARGV[2]) else return 0 end";

export interface LockOptions {
  /**
   * What to do when Redis is unreachable. Default (false) runs the job WITHOUT the lock rather
   * than skipping maintenance — fine for idempotent jobs. Set true for DESTRUCTIVE jobs
   * (retention deletes): running unlocked means every replica races, so skip instead.
   */
  failClosed?: boolean;
}

export async function withLock<T>(
  name: string,
  ttlSeconds: number,
  fn: () => Promise<T>,
  opts: LockOptions = {},
): Promise<T | null> {
  const key = `memoturn:lock:${name}`;
  const token = randomBytes(12).toString("hex");
  const redis = redisConnection();

  let acquired = false;
  try {
    acquired = (await redis.set(key, token, "EX", ttlSeconds, "NX")) === "OK";
  } catch {
    if (opts.failClosed) return null; // destructive job: don't run without coordination
    return fn(); // idempotent job: Redis down, run unlocked rather than skip
  }
  if (!acquired) return null;

  // Renew at a third of the TTL so a couple of missed heartbeats still don't drop the lock.
  const renewMs = Math.max(1000, Math.floor((ttlSeconds * 1000) / 3));
  const heartbeat = setInterval(() => {
    redis.eval(RENEW_LUA, 1, key, token, String(ttlSeconds)).catch(() => {});
  }, renewMs);
  heartbeat.unref?.();

  try {
    return await fn();
  } finally {
    clearInterval(heartbeat);
    try {
      await redis.eval(RELEASE_LUA, 1, key, token);
    } catch {
      // best-effort release; the TTL expires it anyway
    }
  }
}
