import { beforeEach, describe, expect, it, vi } from "vitest";

const deleteTraceData = vi.fn().mockResolvedValue({ traces: 2, payloadObjects: 1 });
const addReviewItems = vi.fn().mockResolvedValue({ added: 2 });
vi.mock("./lifecycle.js", () => ({ deleteTraceData }));
vi.mock("./review.js", () => ({ addReviewItems }));
vi.mock("./datasets.js", () => ({ addDatasetItems: vi.fn(), createDataset: vi.fn() }));
vi.mock("./payloads.js", () => ({ rehydratePayload: vi.fn() }));
vi.mock("./traces.js", () => ({ getTraceIO: vi.fn() }));

const { runBatchAction } = await import("./batch.js");

describe("runBatchAction", () => {
  beforeEach(() => vi.clearAllMocks());

  it("delete goes through the complete deletion path (rows + state + payloads)", async () => {
    const r = await runBatchAction("p1", { action: "delete", traceIds: ["a", "", "b"] });
    expect(deleteTraceData).toHaveBeenCalledWith("p1", ["a", "b"]);
    expect(r).toEqual({ action: "delete", affected: 2 });
  });

  it("an empty selection is a no-op, and review requires a queue name", async () => {
    expect(await runBatchAction("p1", { action: "delete", traceIds: [] })).toEqual({ action: "delete", affected: 0 });
    expect(await runBatchAction("p1", { action: "review", traceIds: ["a"] })).toBeNull();
    expect(await runBatchAction("p1", { action: "review", traceIds: ["a"], queueName: "q" })).toEqual({
      action: "review",
      affected: 2,
    });
  });
});
