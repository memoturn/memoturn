import { describe, expect, it } from "vitest";
import { assertPublicUrl, isBlockedIp } from "./net.js";

describe("isBlockedIp", () => {
  it("blocks loopback, private, link-local and metadata addresses", () => {
    for (const ip of [
      "127.0.0.1",
      "10.0.0.1",
      "172.16.5.4",
      "172.31.255.255",
      "192.168.1.1",
      "169.254.169.254", // cloud metadata
      "0.0.0.0",
      "::1",
      "fc00::1",
      "fd12:3456::1",
      "fe80::1",
      "::ffff:127.0.0.1", // IPv4-mapped loopback (dotted form)
      "::ffff:7f00:1", // IPv4-mapped loopback (hex-normalized form the URL parser emits)
      "::ffff:a9fe:a9fe", // IPv4-mapped 169.254.169.254 (cloud metadata), hex form
      "::ffff:169.254.169.254", // same, dotted form
      "::127.0.0.1", // deprecated IPv4-compatible loopback
      "2002:7f00:1::", // 6to4 wrapping 127.0.0.1
      "64:ff9b::a9fe:a9fe", // NAT64 wrapping 169.254.169.254
    ]) {
      expect(isBlockedIp(ip), ip).toBe(true);
    }
  });

  it("allows public addresses", () => {
    for (const ip of [
      "8.8.8.8",
      "1.1.1.1",
      "203.0.113.7",
      "2606:4700:4700::1111",
      "::ffff:8.8.8.8", // IPv4-mapped public address stays allowed
      "::ffff:808:808", // same, hex form
    ]) {
      expect(isBlockedIp(ip), ip).toBe(false);
    }
  });
});

describe("assertPublicUrl (production policy)", () => {
  // Force the strict policy regardless of the test runner's NODE_ENV.
  const orig = { node: process.env.NODE_ENV, allow: process.env.ALLOW_PRIVATE_WEBHOOK_TARGETS };
  const strict = async <T>(fn: () => Promise<T>): Promise<T> => {
    process.env.NODE_ENV = "production";
    process.env.ALLOW_PRIVATE_WEBHOOK_TARGETS = "0";
    try {
      return await fn();
    } finally {
      process.env.NODE_ENV = orig.node;
      if (orig.allow === undefined) delete process.env.ALLOW_PRIVATE_WEBHOOK_TARGETS;
      else process.env.ALLOW_PRIVATE_WEBHOOK_TARGETS = orig.allow;
    }
  };

  it("rejects http://", async () => {
    await strict(async () => {
      await expect(assertPublicUrl("http://example.com/hook")).rejects.toThrow();
    });
  });

  it("rejects literal private IPs", async () => {
    await strict(async () => {
      await expect(assertPublicUrl("https://127.0.0.1/x")).rejects.toThrow();
      await expect(assertPublicUrl("https://169.254.169.254/latest/meta-data")).rejects.toThrow();
      await expect(assertPublicUrl("https://10.1.2.3/x")).rejects.toThrow();
    });
  });

  it("rejects IPv4-mapped IPv6 literals that the URL parser normalizes to hex", async () => {
    await strict(async () => {
      // new URL("https://[::ffff:169.254.169.254]/").hostname === "::ffff:a9fe:a9fe"
      await expect(assertPublicUrl("https://[::ffff:169.254.169.254]/latest/meta-data")).rejects.toThrow();
      await expect(assertPublicUrl("https://[::ffff:127.0.0.1]/x")).rejects.toThrow();
    });
  });

  it("rejects malformed URLs", async () => {
    await strict(async () => {
      await expect(assertPublicUrl("not a url")).rejects.toThrow();
    });
  });
});

describe("assertPublicUrl (default policy)", () => {
  const orig = { node: process.env.NODE_ENV, allow: process.env.ALLOW_PRIVATE_WEBHOOK_TARGETS };
  const withEnv = async (allow: string | undefined, fn: () => Promise<void>): Promise<void> => {
    process.env.NODE_ENV = "test"; // NOT production — strictness must not depend on it
    if (allow === undefined) delete process.env.ALLOW_PRIVATE_WEBHOOK_TARGETS;
    else process.env.ALLOW_PRIVATE_WEBHOOK_TARGETS = allow;
    try {
      await fn();
    } finally {
      process.env.NODE_ENV = orig.node;
      if (orig.allow === undefined) delete process.env.ALLOW_PRIVATE_WEBHOOK_TARGETS;
      else process.env.ALLOW_PRIVATE_WEBHOOK_TARGETS = orig.allow;
    }
  };

  it("is strict outside production when the opt-in is unset", async () => {
    await withEnv(undefined, async () => {
      await expect(assertPublicUrl("http://localhost:9999/hook")).rejects.toThrow();
      await expect(assertPublicUrl("https://169.254.169.254/latest/meta-data")).rejects.toThrow();
    });
  });

  it("permits http:// and private targets with ALLOW_PRIVATE_WEBHOOK_TARGETS=1", async () => {
    await withEnv("1", async () => {
      await expect(assertPublicUrl("http://localhost:9999/hook")).resolves.toBeUndefined();
      await expect(assertPublicUrl("http://192.168.1.10/hook")).resolves.toBeUndefined();
    });
  });
});
