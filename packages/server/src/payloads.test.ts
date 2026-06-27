import { describe, expect, it } from "vitest";
import {
  MAX_INLINE_PAYLOAD_BYTES,
  offloadLargePayload,
  PAYLOAD_REF_PREFIX,
  type TruncatedPayload,
} from "./payloads.js";

describe("offloadLargePayload", () => {
  const stub = () => {
    const calls: { key: string; body: string }[] = [];
    const store = async (key: string, body: string) => {
      calls.push({ key, body });
      return key;
    };
    return { calls, store };
  };

  it("leaves small payloads untouched", async () => {
    const { calls, store } = stub();
    const value = { hello: "world" };
    const out = await offloadLargePayload("proj1", value, store);
    expect(out).toBe(value);
    expect(calls).toHaveLength(0);
  });

  it("offloads oversized payloads to blob and returns a marker", async () => {
    const { calls, store } = stub();
    const big = "x".repeat(MAX_INLINE_PAYLOAD_BYTES + 1);
    const out = (await offloadLargePayload("proj1", big, store)) as TruncatedPayload;
    expect(out._truncated).toBe(true);
    expect(out.ref.startsWith(PAYLOAD_REF_PREFIX)).toBe(true);
    expect(out.bytes).toBe(big.length);
    expect(out.preview.length).toBeLessThanOrEqual(512);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.key).toContain("payloads/proj1/");
    expect(calls[0]?.body).toBe(big);
  });

  it("passes through null/undefined", async () => {
    const { store } = stub();
    expect(await offloadLargePayload("p", undefined, store)).toBeUndefined();
    expect(await offloadLargePayload("p", null, store)).toBeNull();
  });
});
