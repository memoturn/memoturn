import { beforeEach, describe, expect, it, vi } from "vitest";

const findManyPolicies = vi.fn();
const findManyProjects = vi.fn();
const deleteOlderThan = vi.fn().mockResolvedValue(undefined);
const countTracesOlderThan = vi.fn().mockResolvedValue(3);
const deleteBlobPrefixOlderThan = vi.fn().mockResolvedValue(2);
const pruneProjectState = vi.fn().mockResolvedValue({ traces: 1, observations: 1, scores: 0 });

vi.mock("@memoturn/db", () => ({
  prisma: {
    retentionPolicy: { findMany: findManyPolicies, findUnique: vi.fn(), upsert: vi.fn() },
    project: { findMany: findManyProjects },
  },
}));
vi.mock("@memoturn/db/blob", () => ({ deleteBlobPrefixOlderThan }));
vi.mock("@memoturn/telemetry", () => ({ telemetry: () => ({ deleteOlderThan, countTracesOlderThan }) }));
vi.mock("./mutablestate.js", () => ({ pruneProjectState }));

const { applyAllRetention, applyRetention, effectiveRetentionDays } = await import("./retention.js");

describe("retention", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.TELEMETRY_MAX_RETENTION_DAYS;
  });

  it("sweeps the store, all three blob prefixes, and the state mirror at the SAME cutoff", async () => {
    const before = Date.now();
    const r = await applyRetention("p1", 30);
    expect(deleteOlderThan).toHaveBeenCalledWith("p1", 30);
    expect(deleteBlobPrefixOlderThan.mock.calls.map((c) => c[0])).toEqual(["events/p1/", "payloads/p1/", "media/p1/"]);
    for (const call of deleteBlobPrefixOlderThan.mock.calls) {
      const cutoff = call[1] as Date;
      expect(Math.abs(cutoff.getTime() - (before - 30 * 86_400_000))).toBeLessThan(5_000);
    }
    expect(pruneProjectState).toHaveBeenCalledWith("p1", expect.any(Date));
    expect(r).toMatchObject({ deletedTraces: 3, deletedBlobObjects: 6, deletedStateRows: 2 });
  });

  it("days <= 0 means keep forever — nothing is touched", async () => {
    const r = await applyRetention("p1", 0);
    expect(deleteOlderThan).not.toHaveBeenCalled();
    expect(deleteBlobPrefixOlderThan).not.toHaveBeenCalled();
    expect(r.deletedTraces).toBe(0);
  });

  it("the instance ceiling caps every policy and reaches projects without one", async () => {
    expect(effectiveRetentionDays(90)).toBe(90);
    process.env.TELEMETRY_MAX_RETENTION_DAYS = "30";
    expect(effectiveRetentionDays(90)).toBe(30);
    expect(effectiveRetentionDays(7)).toBe(7);
    expect(effectiveRetentionDays(0)).toBe(30);

    findManyPolicies.mockResolvedValue([{ projectId: "with-policy", days: 90 }]);
    findManyProjects.mockResolvedValue([{ id: "with-policy" }, { id: "no-policy" }]);
    const results = await applyAllRetention();
    expect(results.map((r) => [r.projectId, r.days])).toEqual([
      ["with-policy", 30],
      ["no-policy", 30],
    ]);
  });

  it("one failing project does not stop the sweep", async () => {
    findManyPolicies.mockResolvedValue([
      { projectId: "bad", days: 10 },
      { projectId: "good", days: 10 },
    ]);
    deleteOlderThan.mockRejectedValueOnce(new Error("store down"));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const results = await applyAllRetention();
    expect(results.map((r) => r.projectId)).toEqual(["good"]);
    expect(err).toHaveBeenCalledWith(expect.stringContaining("bad"), "store down");
    err.mockRestore();
  });
});
