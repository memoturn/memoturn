import { redisConnection } from "@memoturn/db/queue";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withLock } from "./lock.js";

/**
 * The lock guards every destructive cron (retention, state prune, sandbox prune) and the DLQ
 * replay. Needs a real Redis (REDIS_URL) — the semantics under test ARE the Redis semantics.
 */
const HAS_REDIS = Boolean(process.env.REDIS_URL);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!HAS_REDIS)("withLock", () => {
  const name = `test-${Date.now()}`;
  beforeAll(async () => {
    await redisConnection().del(`memoturn:lock:${name}`);
  });
  afterAll(async () => {
    await redisConnection().del(`memoturn:lock:${name}`);
  });

  it("runs the job, releases, and lets the next holder in", async () => {
    expect(await withLock(name, 5, async () => "first")).toBe("first");
    expect(await redisConnection().exists(`memoturn:lock:${name}`)).toBe(0);
    expect(await withLock(name, 5, async () => "second")).toBe("second");
  });

  it("a second caller is skipped (null) while the first holds the lock", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const holder = withLock(name, 5, async () => {
      await gate;
      return "held";
    });
    await sleep(20);
    expect(await withLock(name, 5, async () => "intruder")).toBeNull();
    release();
    expect(await holder).toBe("held");
  });

  it("releases only its own token — an expired-and-reacquired lock is not deleted by the old holder", async () => {
    const key = `memoturn:lock:${name}`;
    const slow = withLock(name, 1, async () => {
      // Simulate the TTL lapsing and another replica taking the lock in the meantime.
      await redisConnection().set(key, "someone-else", "EX", 30);
      await sleep(10);
      return "slow";
    });
    expect(await slow).toBe("slow");
    // The other holder's token survived our release.
    expect(await redisConnection().get(key)).toBe("someone-else");
    await redisConnection().del(key);
  });

  it("renews the TTL while the job runs so a slow job keeps its lock", async () => {
    const key = `memoturn:lock:${name}`;
    const result = await withLock(name, 3, async () => {
      await sleep(1500); // > TTL/3 → at least one heartbeat renewal
      const ttl = await redisConnection().ttl(key);
      return ttl;
    });
    expect(result).not.toBeNull();
    expect(result as number).toBeGreaterThan(1);
  });
});
