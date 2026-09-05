import { beforeEach, describe, expect, it, vi } from "vitest";

const deleteProjectData = vi.fn().mockResolvedValue(undefined);
const deleteTraces = vi.fn().mockResolvedValue(undefined);
const deleteByUserId = vi.fn().mockResolvedValue(0);
const getTraceIO = vi.fn().mockResolvedValue([]);
const listObservationsByTrace = vi.fn().mockResolvedValue([]);
const listTraces = vi.fn().mockResolvedValue([]);
const deleteBlobPrefixOlderThan = vi.fn().mockResolvedValue(4);
const deleteBlobObject = vi.fn().mockResolvedValue(undefined);
const deleteStatesForTraces = vi.fn().mockResolvedValue({ traces: 1, observations: 2, scores: 0 });
const traceStateDeleteMany = vi.fn().mockResolvedValue({ count: 0 });

vi.mock("@memoturn/db", () => ({ prisma: { traceState: { deleteMany: traceStateDeleteMany } } }));
vi.mock("@memoturn/db/blob", () => ({ deleteBlobPrefixOlderThan, deleteBlobObject }));
vi.mock("@memoturn/telemetry", () => ({
  telemetry: () => ({
    deleteProjectData,
    deleteTraces,
    deleteByUserId,
    getTraceIO,
    listObservationsByTrace,
    listTraces,
  }),
}));
vi.mock("./mutablestate.js", () => ({ deleteStatesForTraces }));

const { deleteTraceData, deleteUserData, offloadedPayloadKeys, purgeProjectData } = await import("./lifecycle.js");

describe("lifecycle", () => {
  beforeEach(() => vi.clearAllMocks());

  it("purgeProjectData removes telemetry rows AND every blob prefix, and reports (not throws) failures", async () => {
    const r = await purgeProjectData("p1");
    expect(deleteProjectData).toHaveBeenCalledWith("p1");
    expect(deleteBlobPrefixOlderThan.mock.calls.map((c) => c[0])).toEqual(["events/p1/", "payloads/p1/", "media/p1/"]);
    // "everything under the prefix" = a cutoff in the future
    expect((deleteBlobPrefixOlderThan.mock.calls[0]?.[1] as Date).getTime()).toBeGreaterThan(Date.now());
    expect(r).toEqual({ telemetry: true, blobObjects: 12, blobErrors: [] });

    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    deleteBlobPrefixOlderThan.mockRejectedValueOnce(new Error("s3 down"));
    const r2 = await purgeProjectData("p1");
    expect(r2.blobErrors).toEqual(["events: s3 down"]);
    expect(r2.blobObjects).toBe(8); // the other two prefixes still ran
    err.mockRestore();
  });

  it("offloadedPayloadKeys finds only this project's payload refs inside a serialized field", () => {
    const field = JSON.stringify({
      _truncated: true,
      ref: "memoturn-blob://payloads/p1/2026-09-05/abc123.json",
      other: "memoturn-blob://payloads/p2/2026-09-05/other.json",
    });
    expect(offloadedPayloadKeys("p1", field)).toEqual(["payloads/p1/2026-09-05/abc123.json"]);
    expect(offloadedPayloadKeys("p1", "plain text")).toEqual([]);
    expect(offloadedPayloadKeys("p1", null)).toEqual([]);
  });

  it("deleteTraceData deletes rows, state, and the offloaded payload objects the rows referenced", async () => {
    getTraceIO.mockResolvedValue([
      { id: "t1", name: "x", input: '{"_truncated":true,"ref":"memoturn-blob://payloads/p1/d/in.json"}', output: "" },
    ]);
    listObservationsByTrace.mockResolvedValue([
      { id: "o1", input: "", output: '{"ref":"memoturn-blob://payloads/p1/d/out.json"}' },
    ]);
    const r = await deleteTraceData("p1", ["t1", "t1", ""]);
    expect(deleteTraces).toHaveBeenCalledWith("p1", ["t1"]);
    expect(deleteStatesForTraces).toHaveBeenCalledWith("p1", ["t1"]);
    expect(deleteBlobObject.mock.calls.map((c) => c[0]).sort()).toEqual([
      "payloads/p1/d/in.json",
      "payloads/p1/d/out.json",
    ]);
    expect(r).toEqual({ traces: 1, payloadObjects: 2 });
  });

  it("deleteUserData pages through the user's traces, then sweeps the store and state by user id", async () => {
    listTraces.mockResolvedValueOnce([{ id: "a" }, { id: "b" }]).mockResolvedValueOnce([]);
    deleteByUserId.mockResolvedValue(1);
    const r = await deleteUserData("p1", "end-user-7");
    expect(listTraces).toHaveBeenCalledWith("p1", { userId: "end-user-7", limit: 200 });
    expect(deleteTraces).toHaveBeenCalledWith("p1", ["a", "b"]);
    expect(deleteByUserId).toHaveBeenCalledWith("p1", "end-user-7");
    expect(traceStateDeleteMany).toHaveBeenCalledWith({ where: { projectId: "p1", userId: "end-user-7" } });
    expect(r).toEqual({ traces: 3 });
    expect(await deleteUserData("p1", "")).toEqual({ traces: 0 }); // never a wildcard
  });
});
