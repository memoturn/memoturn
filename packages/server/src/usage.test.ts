import { beforeEach, describe, expect, it, vi } from "vitest";

const upsert = vi.fn().mockResolvedValue(undefined);
const findMany = vi.fn();
const sdkUpsert = vi.fn().mockResolvedValue(undefined);
const sdkFindMany = vi.fn().mockResolvedValue([]);
vi.mock("@memoturn/db", () => ({
  prisma: {
    usageDaily: { upsert, findMany },
    sdkUsageDaily: { upsert: sdkUpsert, findMany: sdkFindMany },
  },
}));

const { recordUsage, recordSdkUsage, getSdkVersions, getUsage, usageDay } = await import("./usage.js");

beforeEach(() => {
  upsert.mockClear();
  findMany.mockClear();
  sdkUpsert.mockClear();
  sdkFindMany.mockClear().mockResolvedValue([]);
});

describe("usageDay", () => {
  it("formats a Date as UTC YYYY-MM-DD", () => {
    expect(usageDay(new Date("2026-07-23T23:59:59.999Z"))).toBe("2026-07-23");
    expect(usageDay(new Date("2026-01-01T00:00:00.000Z"))).toBe("2026-01-01");
  });
});

describe("recordUsage", () => {
  it("upserts an increment keyed by (projectId, date) with BigInt bytes", async () => {
    await recordUsage("p1", { bytes: 2048, events: 5, traces: 2 }, new Date("2026-07-23T10:00:00Z"));
    expect(upsert).toHaveBeenCalledTimes(1);
    const arg = upsert.mock.calls[0]![0];
    expect(arg.where).toEqual({ projectId_date: { projectId: "p1", date: "2026-07-23" } });
    expect(arg.create).toEqual({ projectId: "p1", date: "2026-07-23", bytes: 2048n, events: 5, traces: 2 });
    expect(arg.update).toEqual({
      bytes: { increment: 2048n },
      events: { increment: 5 },
      traces: { increment: 2 },
    });
  });

  it("floors and clamps negatives (never a negative counter)", async () => {
    await recordUsage("p1", { bytes: -10, events: 2.9, traces: -1 }, new Date("2026-07-23T10:00:00Z"));
    const arg = upsert.mock.calls[0]![0];
    expect(arg.create).toMatchObject({ bytes: 0n, events: 2, traces: 0 });
  });
});

describe("getUsage", () => {
  it("zero-fills every day in the window and normalizes BigInt bytes to numbers", async () => {
    const today = usageDay();
    findMany.mockResolvedValue([{ date: today, bytes: 5000n, events: 12, traces: 4 }]);
    const summary = await getUsage("p1", 7);
    expect(summary.byDay).toHaveLength(7);
    const todayRow = summary.byDay.at(-1)!;
    expect(todayRow).toEqual({ date: today, bytes: 5000, events: 12, traces: 4 });
    expect(typeof todayRow.bytes).toBe("number");
    // Days with no row are zero-filled.
    expect(summary.byDay[0]).toMatchObject({ bytes: 0, events: 0, traces: 0 });
    expect(summary.total_bytes).toBe(5000);
    expect(summary.total_events).toBe(12);
    expect(summary.total_traces).toBe(4);
  });

  it("clamps days to [1, 365]", async () => {
    findMany.mockResolvedValue([]);
    expect((await getUsage("p1", 0)).byDay).toHaveLength(1);
    expect((await getUsage("p1", 9999)).byDay).toHaveLength(365);
  });
});

describe("recordSdkUsage", () => {
  it("upserts per (project, day, name, version) and increments both counters", async () => {
    await recordSdkUsage("p1", { name: "memoturn-js", version: "0.5.0" }, 12, new Date("2026-08-12T10:00:00Z"));
    const arg = sdkUpsert.mock.calls[0]![0] as {
      where: { projectId_date_sdkName_sdkVersion: Record<string, string> };
      create: Record<string, unknown>;
      update: Record<string, unknown>;
    };
    expect(arg.where.projectId_date_sdkName_sdkVersion).toEqual({
      projectId: "p1",
      date: "2026-08-12",
      sdkName: "memoturn-js",
      sdkVersion: "0.5.0",
    });
    expect(arg.create).toMatchObject({ events: 12, batches: 1 });
    expect(arg.update).toEqual({
      events: { increment: 12 },
      batches: { increment: 1 },
      lastSeen: new Date("2026-08-12T10:00:00Z"),
    });
  });

  it("clamps a negative event count and truncates over-long identifiers", async () => {
    await recordSdkUsage("p1", { name: "x".repeat(200), version: "y".repeat(200) }, -5);
    const arg = sdkUpsert.mock.calls[0]![0] as { where: { projectId_date_sdkName_sdkVersion: Record<string, string> } };
    expect(arg.where.projectId_date_sdkName_sdkVersion.sdkName).toHaveLength(64);
    expect(arg.where.projectId_date_sdkName_sdkVersion.sdkVersion).toHaveLength(32);
    const create = (sdkUpsert.mock.calls[0]![0] as { create: { events: number } }).create;
    expect(create.events).toBe(0);
  });
});

describe("getSdkVersions", () => {
  it("collapses per-day rows into one entry per build, busiest first", async () => {
    sdkFindMany.mockResolvedValue([
      {
        sdkName: "memoturn-js",
        sdkVersion: "0.4.0",
        date: "2026-08-10",
        events: 5,
        batches: 1,
        lastSeen: new Date("2026-08-10T09:00:00Z"),
      },
      {
        sdkName: "memoturn-js",
        sdkVersion: "0.5.0",
        date: "2026-08-11",
        events: 30,
        batches: 3,
        lastSeen: new Date("2026-08-11T09:00:00Z"),
      },
      {
        sdkName: "memoturn-js",
        sdkVersion: "0.5.0",
        date: "2026-08-12",
        events: 70,
        batches: 7,
        lastSeen: new Date("2026-08-12T09:00:00Z"),
      },
    ]);
    const rows = await getSdkVersions("p1", 30);
    expect(rows).toEqual([
      {
        name: "memoturn-js",
        version: "0.5.0",
        events: 100,
        batches: 10,
        firstSeen: "2026-08-11",
        lastSeen: "2026-08-12T09:00:00.000Z", // the newest of the two days, not the last row seen
      },
      {
        name: "memoturn-js",
        version: "0.4.0",
        events: 5,
        batches: 1,
        firstSeen: "2026-08-10",
        lastSeen: "2026-08-10T09:00:00.000Z",
      },
    ]);
  });

  it("returns nothing when no batch has identified itself", async () => {
    expect(await getSdkVersions("p1", 30)).toEqual([]);
  });
});
