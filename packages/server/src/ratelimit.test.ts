import { describe, expect, it } from "vitest";
import { rateLimitWindow } from "./ratelimit.js";

describe("rateLimitWindow", () => {
  it("aligns to the window start and counts down to reset", () => {
    expect(rateLimitWindow(125, 60)).toEqual({ windowStart: 120, resetSeconds: 55 });
    expect(rateLimitWindow(120, 60)).toEqual({ windowStart: 120, resetSeconds: 60 });
    expect(rateLimitWindow(179, 60)).toEqual({ windowStart: 120, resetSeconds: 1 });
  });
  it("respects a custom window", () => {
    expect(rateLimitWindow(1005, 10)).toEqual({ windowStart: 1000, resetSeconds: 5 });
  });
});
