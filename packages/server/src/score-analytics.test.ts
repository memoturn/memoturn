import { beforeEach, describe, expect, it, vi } from "vitest";

const store = {
  listScoreNames: vi.fn(),
  scoreStats: vi.fn(),
  scoreHistogram: vi.fn(),
  scoreCategoryCounts: vi.fn(),
  scoreTimeline: vi.fn(),
  scorePairs: vi.fn(),
};
vi.mock("@memoturn/telemetry", () => ({ telemetry: () => store }));

const { AGREEMENT_PAIR_CAP, getScoreAgreement, getScoreDistribution, listScoreNames } = await import(
  "./score-analytics.js"
);

const pair = (a: number | null, b: number | null, as = "", bs = "", trace = "t") => ({
  trace_id: trace,
  a_value: a,
  a_string: as,
  b_value: b,
  b_string: bs,
});

beforeEach(() => {
  for (const fn of Object.values(store)) fn.mockReset();
  store.listScoreNames.mockResolvedValue([]);
  store.scoreStats.mockResolvedValue({ count: 0, min: 0, max: 0, mean: 0, stddev: 0, p50: 0, p95: 0 });
  store.scoreHistogram.mockResolvedValue([]);
  store.scoreCategoryCounts.mockResolvedValue([]);
  store.scoreTimeline.mockResolvedValue([]);
  store.scorePairs.mockResolvedValue([]);
});

describe("listScoreNames", () => {
  it("collapses a name written by several sources, keeping the most common data type", async () => {
    store.listScoreNames.mockResolvedValue([
      { name: "quality", data_type: "NUMERIC", source: "EVAL", count: 90 },
      { name: "quality", data_type: "CATEGORICAL", source: "ANNOTATION", count: 10 },
      { name: "verdict", data_type: "CATEGORICAL", source: "EVAL", count: 500 },
    ]);
    const names = await listScoreNames("p1", 30);
    expect(names).toEqual([
      { name: "verdict", dataType: "CATEGORICAL", source: "EVAL", count: 500 },
      { name: "quality", dataType: "NUMERIC", source: "EVAL", count: 100 },
    ]);
  });
});

describe("getScoreDistribution", () => {
  it("builds equal-width buckets across the observed range, keeping empty ones", async () => {
    store.listScoreNames.mockResolvedValue([{ name: "quality", data_type: "NUMERIC", source: "EVAL", count: 3 }]);
    store.scoreStats.mockResolvedValue({ count: 3, min: 0, max: 1, mean: 0.5, stddev: 0.4, p50: 0.5, p95: 0.9 });
    // Bucket 10 is the maximum value — it belongs in the last bucket, not a phantom eleventh.
    store.scoreHistogram.mockResolvedValue([
      { bucket: 0, count: 1 },
      { bucket: 5, count: 1 },
      { bucket: 10, count: 1 },
    ]);

    const dist = await getScoreDistribution("p1", "quality", 30);
    expect(dist.dataType).toBe("NUMERIC");
    expect(dist.histogram).toHaveLength(10);
    expect(dist.histogram[0]).toEqual({ from: 0, to: 0.1, count: 1 });
    expect(dist.histogram[5]).toEqual({ from: 0.5, to: 0.6, count: 1 });
    expect(dist.histogram[9]).toEqual({ from: 0.9, to: 1, count: 1 });
    expect(dist.histogram[1]!.count).toBe(0);
    // The store is asked for buckets sized from the observed range.
    expect(store.scoreHistogram).toHaveBeenCalledWith("p1", "quality", 30, { min: 0, width: 0.1, buckets: 10 });
  });

  it("emits no histogram for a constant score (no range to bucket)", async () => {
    store.scoreStats.mockResolvedValue({ count: 8, min: 1, max: 1, mean: 1, stddev: 0, p50: 1, p95: 1 });
    const dist = await getScoreDistribution("p1", "pass", 30);
    expect(dist.histogram).toEqual([]);
    expect(store.scoreHistogram).not.toHaveBeenCalled();
  });

  it("passes categorical counts and the timeline through", async () => {
    store.scoreCategoryCounts.mockResolvedValue([{ value: "pass", count: 7 }]);
    store.scoreTimeline.mockResolvedValue([{ date: "2026-08-01", count: 7, mean: 0.123456 }]);
    const dist = await getScoreDistribution("p1", "verdict", 7);
    expect(dist.categories).toEqual([{ value: "pass", count: 7 }]);
    expect(dist.timeline).toEqual([{ date: "2026-08-01", count: 7, mean: 0.1235 }]);
  });
});

describe("getScoreAgreement", () => {
  it("returns an empty result (not an error) when no trace carries both scores", async () => {
    const res = await getScoreAgreement("p1", "human", "judge", 30);
    expect(res).toMatchObject({ pairs: 0, sampled: false, numeric: null, categorical: null, matrix: [] });
  });

  it("computes correlation, MAE and RMSE for numeric pairs", async () => {
    store.scorePairs.mockResolvedValue([pair(1, 1), pair(0, 0), pair(0.5, 0.5), pair(0.2, 0.4)]);
    const res = await getScoreAgreement("p1", "human", "judge", 30);
    expect(res.categorical).toBeNull();
    expect(res.numeric!.correlation).toBeGreaterThan(0.9); // near-identical raters
    expect(res.numeric!.mae).toBeCloseTo(0.05, 4); // one disagreement of 0.2 over four pairs
    expect(res.numeric!.rmse).toBeCloseTo(0.1, 4);
    // Numeric axes are ascending buckets, not lexicographic labels.
    expect(res.aLabels).toHaveLength(5);
    expect(res.matrix.reduce((s, c) => s + c.count, 0)).toBe(4);
  });

  it("reports zero correlation when one side is constant (undefined, not perfect)", async () => {
    store.scorePairs.mockResolvedValue([pair(1, 0.2), pair(1, 0.9), pair(1, 0.5)]);
    const res = await getScoreAgreement("p1", "human", "judge", 30);
    expect(res.numeric!.correlation).toBe(0);
  });

  it("computes agreement rate, Kappa and per-label F1 for categorical pairs", async () => {
    // 8 of 10 agree; the two disagreements cross labels, so Kappa lands below the raw rate.
    store.scorePairs.mockResolvedValue([
      ...Array.from({ length: 4 }, () => pair(null, null, "pass", "pass")),
      ...Array.from({ length: 4 }, () => pair(null, null, "fail", "fail")),
      pair(null, null, "pass", "fail"),
      pair(null, null, "fail", "pass"),
    ]);
    const res = await getScoreAgreement("p1", "human", "judge", 30);
    expect(res.numeric).toBeNull();
    expect(res.categorical!.agreementRate).toBe(0.8);
    expect(res.categorical!.cohensKappa).toBeCloseTo(0.6, 4);
    expect(res.categorical!.f1.map((f) => f.label)).toEqual(["fail", "pass"]);
    expect(res.categorical!.f1[0]!.support).toBe(5);
    // 2×2 confusion matrix with every pair accounted for.
    expect(res.matrix.reduce((s, c) => s + c.count, 0)).toBe(10);
    expect(res.matrix.find((c) => c.a === "pass" && c.b === "fail")?.count).toBe(1);
  });

  it("gives Kappa 0 when both raters always say the same single label (chance explains it)", async () => {
    store.scorePairs.mockResolvedValue(Array.from({ length: 5 }, () => pair(null, null, "pass", "pass")));
    const res = await getScoreAgreement("p1", "human", "judge", 30);
    expect(res.categorical!.agreementRate).toBe(1);
    expect(res.categorical!.cohensKappa).toBe(0);
  });

  it("flags a result as sampled when the pair scan hits the cap", async () => {
    store.scorePairs.mockResolvedValue(Array.from({ length: AGREEMENT_PAIR_CAP }, () => pair(1, 1)));
    const res = await getScoreAgreement("p1", "human", "judge", 30);
    expect(res.sampled).toBe(true);
    expect(res.pairs).toBe(AGREEMENT_PAIR_CAP);
  });

  it("returns only the pair count for a mixed numeric/categorical comparison", async () => {
    store.scorePairs.mockResolvedValue([pair(null, null, "pass", ""), pair(null, null, "fail", "")]);
    const res = await getScoreAgreement("p1", "human", "judge", 30);
    expect(res.pairs).toBe(2);
    expect(res.numeric).toBeNull();
    expect(res.categorical).toBeNull();
  });
});
