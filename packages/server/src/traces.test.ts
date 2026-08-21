import { beforeEach, describe, expect, it, vi } from "vitest";

const listTraces = vi.fn();
const getTraceIO = vi.fn();
vi.mock("@memoturn/telemetry", () => ({ telemetry: () => ({ listTraces, getTraceIO }) }));

const { getSessionMessages, zeroFillBuckets } = await import("./traces.js");

describe("getSessionMessages", () => {
  beforeEach(() => {
    listTraces.mockReset();
    getTraceIO.mockReset();
  });

  it("reconstructs a session's traces as oldest-first turns with their I/O", async () => {
    // Store returns newest-first; the function must order oldest-first.
    listTraces.mockResolvedValue([
      { id: "t2", name: "turn-2", timestamp: "2026-07-24T10:05:00Z", total_tokens: 20, total_cost: 0.02 },
      { id: "t1", name: "turn-1", timestamp: "2026-07-24T10:00:00Z", total_tokens: 10, total_cost: 0.01 },
    ]);
    getTraceIO.mockResolvedValue([
      { id: "t1", name: "turn-1", input: "hi", output: "hello" },
      { id: "t2", name: "turn-2", input: "again?", output: "yes" },
    ]);

    const res = await getSessionMessages("p1", "s1");

    expect(listTraces).toHaveBeenCalledWith("p1", { sessionId: "s1", limit: 500 });
    expect(res.session_id).toBe("s1");
    expect(res.messages.map((m) => m.traceId)).toEqual(["t1", "t2"]); // oldest-first
    expect(res.messages[0]).toEqual({
      traceId: "t1",
      name: "turn-1",
      timestamp: "2026-07-24T10:00:00Z",
      input: "hi",
      output: "hello",
      total_tokens: 10,
      total_cost: 0.01,
    });
  });

  it("returns empty I/O for a trace the I/O fetch didn't cover, and empty messages for an empty session", async () => {
    listTraces.mockResolvedValueOnce([
      { id: "t1", name: "t", timestamp: "2026-07-24T10:00:00Z", total_tokens: 0, total_cost: 0 },
    ]);
    getTraceIO.mockResolvedValueOnce([]); // no I/O rows returned
    const partial = await getSessionMessages("p1", "s1");
    expect(partial.messages[0]).toMatchObject({ input: "", output: "" });

    listTraces.mockResolvedValueOnce([]);
    getTraceIO.mockResolvedValueOnce([]);
    const empty = await getSessionMessages("p1", "none");
    expect(empty.messages).toEqual([]);
  });
});

describe("zeroFillBuckets", () => {
  // 2026-08-20T12:30:00Z — mid-day so partial first/last buckets are exercised.
  const now = Date.parse("2026-08-20T12:30:00Z");

  it("spans the whole day window, zero-filling days the store didn't emit", () => {
    const sparse = [
      { bucket: "2026-08-18", count: 3 },
      { bucket: "2026-08-20", count: 5 },
    ];
    const filled = zeroFillBuckets(sparse, "day", 7, now);
    // Cutoff is now − 7d = 08-13T12:30 → first bucket is the partial day 08-13, last is today.
    expect(filled.map((b) => b.bucket)).toEqual([
      "2026-08-13",
      "2026-08-14",
      "2026-08-15",
      "2026-08-16",
      "2026-08-17",
      "2026-08-18",
      "2026-08-19",
      "2026-08-20",
    ]);
    expect(filled.find((b) => b.bucket === "2026-08-18")?.count).toBe(3);
    expect(filled.find((b) => b.bucket === "2026-08-20")?.count).toBe(5);
    expect(filled.filter((b) => b.count === 0)).toHaveLength(6);
  });

  it("widening the window grows the series even when no older data exists", () => {
    const sparse = [{ bucket: "2026-08-20", count: 1 }];
    expect(zeroFillBuckets(sparse, "day", 30, now)).toHaveLength(31);
    expect(zeroFillBuckets(sparse, "day", 90, now)).toHaveLength(91);
  });

  it("fills hour buckets in the stores' key format", () => {
    const filled = zeroFillBuckets([{ bucket: "2026-08-20T09:00", count: 2 }], "hour", 1, now);
    // now − 24h = 08-19T12:30 → hours 08-19T12:00 through 08-20T12:00 inclusive.
    expect(filled).toHaveLength(25);
    expect(filled[0]?.bucket).toBe("2026-08-19T12:00");
    expect(filled.at(-1)?.bucket).toBe("2026-08-20T12:00");
    expect(filled.find((b) => b.bucket === "2026-08-20T09:00")?.count).toBe(2);
  });

  it("without a days window, fills from the oldest observed bucket to now", () => {
    const filled = zeroFillBuckets([{ bucket: "2026-08-17", count: 4 }], "day", undefined, now);
    expect(filled.map((b) => b.bucket)).toEqual(["2026-08-17", "2026-08-18", "2026-08-19", "2026-08-20"]);
    expect(filled[0]?.count).toBe(4);
  });

  it("returns an empty series when there is no window and no data", () => {
    expect(zeroFillBuckets([], "day", undefined, now)).toEqual([]);
    // With a window, an empty store result still yields the full zeroed range.
    expect(zeroFillBuckets([], "day", 3, now)).toHaveLength(4);
  });
});
