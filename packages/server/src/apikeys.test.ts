import { describe, expect, it } from "vitest";
import { requiredScope, resolveKeyControls } from "./apikeys.js";

describe("requiredScope", () => {
  it("ingest endpoints require the ingest scope", () => {
    expect(requiredScope("POST", "/v1/ingest")).toBe("ingest");
    expect(requiredScope("POST", "/v1/otel/v1/traces")).toBe("ingest");
  });
  it("GET is read; other methods are write (case-insensitive)", () => {
    expect(requiredScope("GET", "/v1/traces")).toBe("read");
    expect(requiredScope("get", "/v1/metrics")).toBe("read");
    expect(requiredScope("POST", "/v1/datasets")).toBe("write");
    expect(requiredScope("DELETE", "/v1/api-keys/x")).toBe("write");
  });
});

describe("resolveKeyControls", () => {
  const now = 1_700_000_000_000;
  it("defaults to all scopes and drops unknown ones", () => {
    expect(resolveKeyControls({}).scopes).toEqual(["read", "write", "ingest"]);
    expect(resolveKeyControls({ scopes: ["read", "bogus"] }).scopes).toEqual(["read"]);
    expect(resolveKeyControls({ scopes: [] }).scopes).toEqual(["read", "write", "ingest"]);
  });
  it("computes expiry from days (null/0 = never)", () => {
    expect(resolveKeyControls({ expiresInDays: 2 }, now).expiresAt?.getTime()).toBe(now + 2 * 86_400_000);
    expect(resolveKeyControls({ expiresInDays: null }, now).expiresAt).toBeNull();
    expect(resolveKeyControls({ expiresInDays: 0 }, now).expiresAt).toBeNull();
  });
  it("passes the per-key rate limit through", () => {
    expect(resolveKeyControls({ rateLimitPerMinute: 60 }).rateLimitPerMinute).toBe(60);
    expect(resolveKeyControls({}).rateLimitPerMinute).toBeNull();
  });
});
