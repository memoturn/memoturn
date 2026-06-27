import { createHash } from "node:crypto";
import { getBlobBytes, putBlobObject } from "@memoturn/db/blob";

/**
 * Large-payload offload. The ClickHouse schema documents that oversized input/output is
 * kept in blob storage with only a reference inline — but nothing implemented it, so big
 * payloads were written to ClickHouse verbatim (insert failures, memory pressure). This
 * offloads any input/output field over a soft threshold to blob (project-scoped key) and
 * replaces it with a small marker. The full value stays replayable from the raw batch and
 * the offloaded copy. Runs AFTER masking so redacted PII is never stored in the clear.
 */
export const PAYLOAD_REF_PREFIX = "memoturn-blob://";

/** Soft threshold (chars ≈ bytes) above which a payload field is offloaded to blob. */
export const MAX_INLINE_PAYLOAD_BYTES = 256 * 1024; // 256 KB

export interface TruncatedPayload {
  _truncated: true;
  ref: string;
  bytes: number;
  preview: string;
}

/**
 * If `value` serializes larger than MAX_INLINE_PAYLOAD_BYTES, store it to blob and return
 * a marker; otherwise return the value unchanged. `store` is injectable for testing.
 */
export async function offloadLargePayload(
  projectId: string,
  value: unknown,
  store: (key: string, body: string) => Promise<string> = (k, b) => putBlobObject(k, b, "application/json"),
): Promise<unknown> {
  if (value === undefined || value === null) return value;
  const serialized = typeof value === "string" ? value : JSON.stringify(value);
  if (serialized.length <= MAX_INLINE_PAYLOAD_BYTES) return value;

  const hash = createHash("sha256").update(serialized).digest("hex").slice(0, 32);
  const date = new Date().toISOString().slice(0, 10);
  const key = `payloads/${projectId}/${date}/${hash}.json`;
  await store(key, serialized);
  const marker: TruncatedPayload = {
    _truncated: true,
    ref: `${PAYLOAD_REF_PREFIX}${key}`,
    bytes: serialized.length,
    preview: serialized.slice(0, 512),
  };
  return marker;
}

/**
 * Fetch a previously-offloaded payload by its blob key (or `memoturn-blob://` ref),
 * scoped to the project. Keys are `payloads/<projectId>/…`, so a caller can only read its
 * own project's payloads. Returns the raw serialized string, or null if missing/out-of-scope.
 */
export async function getOffloadedPayload(
  projectId: string,
  keyOrRef: string,
  fetch: (key: string) => Promise<{ body: Uint8Array } | null> = getBlobBytes,
): Promise<string | null> {
  const key = keyOrRef.startsWith(PAYLOAD_REF_PREFIX) ? keyOrRef.slice(PAYLOAD_REF_PREFIX.length) : keyOrRef;
  if (!key.startsWith(`payloads/${projectId}/`)) return null; // cross-project / malformed
  const obj = await fetch(key);
  if (!obj) return null;
  return new TextDecoder().decode(obj.body);
}
