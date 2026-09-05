import { redisConnection } from "@memoturn/db/queue";

/**
 * Optional `Idempotency-Key` support for `POST /v1/ingest`. A client that retries after a
 * timeout-that-actually-succeeded would otherwise create a second batch: harmless for the
 * telemetry rows (last-writer-wins) but it double-counts usage metering and re-runs online
 * evaluators (LLM spend). With a key, the first response is cached for 24 h and replayed
 * verbatim to any retry. Fails open on a Redis outage (the retry is processed normally).
 */
const TTL_S = 24 * 60 * 60;
const KEY_RE = /^[A-Za-z0-9_.:-]{1,128}$/;

export function isValidIdempotencyKey(key: string | undefined): key is string {
  return typeof key === "string" && KEY_RE.test(key);
}

export type IdempotencyClaim = { status: "new" } | { status: "replay"; body: string } | { status: "pending" };

/**
 * Claim the key for this request. "new" → process and then call storeIdempotentResponse;
 * "replay" → return the stored body as-is; "pending" → a concurrent request with the same
 * key is still in flight (respond 409 so the client retries shortly).
 */
export async function claimIdempotencyKey(projectId: string, key: string): Promise<IdempotencyClaim> {
  const redis = redisConnection();
  const k = `memoturn:idem:${projectId}:${key}`;
  try {
    const claimed = await redis.set(k, "__pending__", "EX", TTL_S, "NX");
    if (claimed === "OK") return { status: "new" };
    const existing = await redis.get(k);
    if (existing === null) return { status: "new" }; // expired between calls — treat as fresh
    if (existing === "__pending__") return { status: "pending" };
    return { status: "replay", body: existing };
  } catch {
    return { status: "new" }; // fail open
  }
}

export async function storeIdempotentResponse(projectId: string, key: string, body: string): Promise<void> {
  try {
    await redisConnection().set(`memoturn:idem:${projectId}:${key}`, body, "EX", TTL_S);
  } catch {
    // best-effort
  }
}

/** Release a claim when processing failed, so the client's retry is not answered "pending". */
export async function releaseIdempotencyKey(projectId: string, key: string): Promise<void> {
  try {
    await redisConnection().del(`memoturn:idem:${projectId}:${key}`);
  } catch {
    // best-effort
  }
}
