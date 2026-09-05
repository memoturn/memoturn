import { redisConnection } from "@memoturn/db/queue";

/**
 * Per-project cap on concurrently open SSE streams (live tail, playground/assistant
 * streaming). Each stream holds an API connection and — for the LLM-backed ones — a
 * provider request, so an unbounded count is both a DoS lever and a cost lever.
 *
 * Counted in Redis so the cap is shared across API replicas. The key carries a TTL so a
 * slot leaked by a crashed replica (no release) frees itself; `release` is idempotent.
 * Fails open on a Redis outage (streams keep working; the cap simply isn't enforced).
 */
function maxStreams(): number {
  const n = Number(process.env.SSE_MAX_STREAMS_PER_PROJECT);
  return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : 20;
}
const SLOT_TTL_S = 60 * 60;

export interface StreamSlot {
  release(): Promise<void>;
}

const noop: StreamSlot = { release: async () => {} };

export async function acquireStreamSlot(projectId: string): Promise<StreamSlot | null> {
  const max = maxStreams();
  if (max <= 0) return noop;
  const key = `memoturn:sse:${projectId}`;
  let redis: ReturnType<typeof redisConnection>;
  try {
    redis = redisConnection();
    const n = await redis.incr(key);
    await redis.expire(key, SLOT_TTL_S);
    if (n > max) {
      await redis.decr(key);
      return null;
    }
  } catch {
    return noop; // fail open
  }
  let released = false;
  return {
    release: async () => {
      if (released) return;
      released = true;
      try {
        const left = await redis.decr(key);
        if (left < 0) await redis.set(key, "0", "EX", SLOT_TTL_S);
      } catch {
        // best-effort; the TTL reclaims the slot
      }
    },
  };
}
