import { describe, expect, it } from "vitest";
import {
  getOffloadedPayload,
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

describe("getOffloadedPayload", () => {
  const fetch = (key: string) =>
    Promise.resolve(key === "payloads/proj1/2026/abc.json" ? { body: new TextEncoder().encode('{"v":1}') } : null);

  it("returns the payload for an in-scope key (raw or memoturn-blob:// ref)", async () => {
    expect(await getOffloadedPayload("proj1", "payloads/proj1/2026/abc.json", fetch)).toBe('{"v":1}');
    expect(await getOffloadedPayload("proj1", `${PAYLOAD_REF_PREFIX}payloads/proj1/2026/abc.json`, fetch)).toBe(
      '{"v":1}',
    );
  });

  it("rejects a cross-project key without touching blob storage", async () => {
    let touched = false;
    const spy = (k: string) => {
      touched = true;
      return fetch(k);
    };
    // proj2 trying to read proj1's payload → null, and the fetch must not even run.
    expect(await getOffloadedPayload("proj2", "payloads/proj1/2026/abc.json", spy)).toBeNull();
    expect(touched).toBe(false);
  });

  it("returns null when the object is missing", async () => {
    expect(await getOffloadedPayload("proj1", "payloads/proj1/2026/missing.json", fetch)).toBeNull();
  });
});

describe("rehydratePayload", () => {
  const blob = (stored: Record<string, string>) => async (key: string) =>
    stored[key] ? { body: new TextEncoder().encode(stored[key]) } : null;

  it("passes non-marker values through unchanged", async () => {
    const { rehydratePayload } = await import("./payloads.js");
    expect(await rehydratePayload("p1", { q: "hi" }, blob({}))).toEqual({ q: "hi" });
    expect(await rehydratePayload("p1", "plain string", blob({}))).toBe("plain string");
    expect(await rehydratePayload("p1", null, blob({}))).toBeNull();
  });

  it("replaces a marker object with the original payload (parsed when JSON)", async () => {
    const { rehydratePayload, PAYLOAD_REF_PREFIX } = await import("./payloads.js");
    const key = "payloads/p1/2026-07-23/abc.json";
    const marker = { _truncated: true, ref: `${PAYLOAD_REF_PREFIX}${key}`, bytes: 10, preview: "" };
    const out = await rehydratePayload("p1", marker, blob({ [key]: '{"full":"payload"}' }));
    expect(out).toEqual({ full: "payload" });
  });

  it("replaces a marker serialized as a JSON string (trace IO columns store text)", async () => {
    const { rehydratePayload, PAYLOAD_REF_PREFIX } = await import("./payloads.js");
    const key = "payloads/p1/2026-07-23/def.json";
    const marker = JSON.stringify({ _truncated: true, ref: `${PAYLOAD_REF_PREFIX}${key}`, bytes: 3, preview: "" });
    expect(await rehydratePayload("p1", marker, blob({ [key]: "raw text payload" }))).toBe("raw text payload");
  });

  it("leaves the marker in place when the blob is missing or cross-project", async () => {
    const { rehydratePayload, PAYLOAD_REF_PREFIX } = await import("./payloads.js");
    const missing = { _truncated: true, ref: `${PAYLOAD_REF_PREFIX}payloads/p1/x.json`, bytes: 1, preview: "" };
    expect(await rehydratePayload("p1", missing, blob({}))).toEqual(missing);
    const foreign = { _truncated: true, ref: `${PAYLOAD_REF_PREFIX}payloads/OTHER/x.json`, bytes: 1, preview: "" };
    expect(await rehydratePayload("p1", foreign, blob({ "payloads/OTHER/x.json": "secret" }))).toEqual(foreign);
  });
});
