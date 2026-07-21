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

// Acquire ALL keys or NONE (rolling back any taken in this attempt), so concurrent callers can't
// deadlock on partial ordering. Release only deletes keys we still own.
const MULTI_ACQUIRE_LUA = `
for i=1,#KEYS do
  if not redis.call('set', KEYS[i], ARGV[1], 'NX', 'EX', ARGV[2]) then
    for j=1,i-1 do redis.call('del', KEYS[j]) end
    return 0
  end
end
return 1`;
const MULTI_RELEASE_LUA = `
for i=1,#KEYS do
  if redis.call('get', KEYS[i]) == ARGV[1] then redis.call('del', KEYS[i]) end
end
return 1`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Run `fn` while holding a lock on every one of `names` — used to serialize the ingest
 * read-merge→insert per entity id. Two batches patching the same trace would otherwise each read
 * the same stored base, materialize a full row from only their own fields, and let merge-on-write
 * (LWW) keep one and silently drop the other's fields. Holding per-entity locks makes the second
 * batch read the first's already-written row as its base.
 *
 * Best-effort: acquires all-or-nothing with jittered backoff up to ~maxWaitMs; if it can't (a
 * genuinely stuck holder) or Redis is unreachable, it runs `fn` WITHOUT the locks rather than
 * failing ingestion — `onDegraded` is called so the caller can count it. Locks auto-expire via TTL.
 */
export async function withEntityLocks<T>(
  names: string[],
  ttlSeconds: number,
  fn: () => Promise<T>,
  opts: { maxWaitMs?: number; onDegraded?: () => void } = {},
): Promise<T> {
  if (names.length === 0) return fn();
  const keys = [...new Set(names)].sort().map((n) => `memoturn:elock:${n}`);
  const token = randomBytes(12).toString("hex");
  const redis = redisConnection();
  const deadline = Date.now() + (opts.maxWaitMs ?? 3000);

  let held = false;
  let backoff = 20;
  while (!held) {
    let res: unknown;
    try {
      res = await redis.eval(MULTI_ACQUIRE_LUA, keys.length, ...keys, token, String(ttlSeconds));
    } catch {
      opts.onDegraded?.(); // Redis unreachable — proceed unlocked rather than stall ingestion
      return fn();
    }
    if (res === 1) {
      held = true;
      break;
    }
    if (Date.now() >= deadline) {
      opts.onDegraded?.(); // stuck holder — degrade rather than block ingestion indefinitely
      return fn();
    }
    await sleep(backoff + Math.floor(Math.random() * backoff)); // jitter to avoid lockstep retries
    backoff = Math.min(backoff * 2, 200);
  }

  try {
    return await fn();
  } finally {
    try {
      await redis.eval(MULTI_RELEASE_LUA, keys.length, ...keys, token);
    } catch {
      // best-effort release; TTL expires the keys anyway
    }
  }
}
