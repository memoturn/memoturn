import { describe, expect, it } from "vitest";
import { anomalyBreach, isAnomalyComparator } from "./alerts.js";

describe("isAnomalyComparator", () => {
  it("recognizes anomaly comparators only", () => {
    expect(isAnomalyComparator("anomaly_high")).toBe(true);
    expect(isAnomalyComparator("anomaly_low")).toBe(true);
    expect(isAnomalyComparator("gt")).toBe(false);
    expect(isAnomalyComparator("lte")).toBe(false);
  });
});

describe("anomalyBreach", () => {
  // A steady baseline of 10 (mean 10, small noise) then a spike/normal current.
  const steady = [10, 10, 11, 9, 10, 10, 10]; // 6 baseline + current

  it("fires anomaly_high on a spike beyond the sensitivity", () => {
    const res = anomalyBreach([...steady.slice(0, -1), 50], "high", 3);
    expect(res).not.toBeNull();
    expect(res!.breached).toBe(true);
    expect(res!.z).toBeGreaterThan(3);
  });

  it("does not fire when the current value is within normal range", () => {
    const res = anomalyBreach(steady, "high", 3);
    expect(res!.breached).toBe(false);
  });

  it("fires anomaly_low on a drop", () => {
    const res = anomalyBreach([100, 98, 102, 99, 101, 100, 0], "low", 3);
    expect(res!.breached).toBe(true);
    expect(res!.z).toBeLessThan(-3);
  });

  it("returns null (no fire) with too little history", () => {
    expect(anomalyBreach([10, 50], "high", 3)).toBeNull();
  });

  it("returns null on a perfectly flat baseline (stddev 0) — avoids div-by-zero false positives", () => {
    expect(anomalyBreach([5, 5, 5, 5, 5, 5, 9], "high", 3)).toBeNull();
  });
});
