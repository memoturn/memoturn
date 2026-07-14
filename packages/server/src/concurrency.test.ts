import { describe, expect, it } from "vitest";
import { mapConcurrent } from "./concurrency.js";

describe("mapConcurrent", () => {
  it("preserves input order in the results", async () => {
    const out = await mapConcurrent([3, 1, 2], 2, async (n) => {
      await new Promise((r) => setTimeout(r, n * 10));
      return n * 10;
    });
    expect(out).toEqual([30, 10, 20]);
  });

  it("never exceeds the concurrency limit", async () => {
    let inFlight = 0;
    let peak = 0;
    await mapConcurrent(
      Array.from({ length: 20 }, (_, i) => i),
      4,
      async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
      },
    );
    expect(peak).toBeLessThanOrEqual(4);
    expect(peak).toBeGreaterThan(1); // it did actually run concurrently
  });

  it("propagates rejections", async () => {
    await expect(
      mapConcurrent([1, 2], 2, async (n) => {
        if (n === 2) throw new Error("boom");
        return n;
      }),
    ).rejects.toThrow("boom");
  });

  it("handles empty input and limit larger than the input", async () => {
    expect(await mapConcurrent([], 8, async (x) => x)).toEqual([]);
    expect(await mapConcurrent([1], 8, async (x) => x + 1)).toEqual([2]);
  });
});
