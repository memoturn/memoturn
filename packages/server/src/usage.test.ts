import { beforeEach, describe, expect, it, vi } from "vitest";

const upsert = vi.fn().mockResolvedValue(undefined);
const findMany = vi.fn();
vi.mock("@memoturn/db", () => ({ prisma: { usageDaily: { upsert, findMany } } }));

const { recordUsage, getUsage, usageDay } = await import("./usage.js");

beforeEach(() => {
  upsert.mockClear();
  findMany.mockClear();
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
