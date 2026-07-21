import { describe, expect, it } from "vitest";
import { clientIpFrom } from "./mcp.js";

describe("clientIpFrom", () => {
  it("trusts nothing with no proxy declared (XFF is client-spoofable)", () => {
    expect(clientIpFrom("1.2.3.4", "5.6.7.8", 0)).toBe("unknown");
  });

  it("reads the real client from the end, ignoring a spoofed prefix (1 trusted proxy)", () => {
    expect(clientIpFrom("9.9.9.9", undefined, 1)).toBe("9.9.9.9");
    // Attacker prepends a fake IP; the trusted proxy appends the real peer to the right.
    expect(clientIpFrom("6.6.6.6, 9.9.9.9", undefined, 1)).toBe("9.9.9.9");
  });

  it("honors multiple trusted proxies", () => {
    expect(clientIpFrom("fake, 5.5.5.5, 8.8.8.8", undefined, 2)).toBe("5.5.5.5");
  });

  it("falls back to x-real-ip then unknown when trusted", () => {
    expect(clientIpFrom(undefined, "7.7.7.7", 1)).toBe("7.7.7.7");
    expect(clientIpFrom(undefined, undefined, 1)).toBe("unknown");
  });
});
