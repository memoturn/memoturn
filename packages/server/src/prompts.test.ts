import { describe, expect, it } from "vitest";
import { bucketOf } from "./prompts.js";

describe("bucketOf (A/B sticky assignment)", () => {
  it("is deterministic — same key always lands in the same bucket", () => {
    expect(bucketOf("session-abc")).toBe(bucketOf("session-abc"));
    expect(bucketOf("user-42")).toBe(bucketOf("user-42"));
  });

  it("returns a bucket in [0, 99]", () => {
    for (const k of ["", "a", "session-abc", "🎲", "a".repeat(200)]) {
      const b = bucketOf(k);
      expect(b).toBeGreaterThanOrEqual(0);
      expect(b).toBeLessThan(100);
    }
  });

  it("spreads keys across the range (a 50%% split lands both arms)", () => {
    let below = 0;
    const N = 1000;
    for (let i = 0; i < N; i++) if (bucketOf(`session-${i}`) < 50) below++;
    // With FNV over varied keys, a 50/50 split should be roughly balanced, never degenerate.
    expect(below).toBeGreaterThan(N * 0.35);
    expect(below).toBeLessThan(N * 0.65);
  });
});
