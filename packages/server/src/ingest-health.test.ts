import { beforeEach, describe, expect, it, vi } from "vitest";

type FakeJob = { data: Record<string, unknown>; remove: () => Promise<void> };
let jobs: FakeJob[] = [];
const ingestAdd = vi.fn().mockResolvedValue({});
const getJobs = vi.fn(async (_states: string[], start = 0, end = Number.MAX_SAFE_INTEGER) =>
  jobs.slice(start, end + 1),
);
const getJobCounts = vi.fn(async () => ({ waiting: jobs.length }));

vi.mock("@memoturn/db/queue", () => ({
  getDlqQueue: () => ({ getJobs, getJobCounts, count: async () => jobs.length }),
  getIngestQueue: () => ({ add: ingestAdd }),
}));
// The replay lock: run the job inline (a real Redis is not needed for these semantics).
vi.mock("./lock.js", () => ({ withLock: async (_n: string, _t: number, fn: () => Promise<unknown>) => fn() }));

const { inspectDlq, replayDlq } = await import("./ingest-health.js");

function seed(entries: { projectId: string; batchId: string }[]) {
  jobs = entries.map((e) => {
    const job: FakeJob = {
      data: { ...e, blobKey: `events/${e.projectId}/d/${e.batchId}.json`, error: `boom ${e.batchId}`, failedAt: "t" },
      remove: async () => {
        jobs = jobs.filter((j) => j !== job);
      },
    };
    return job;
  });
}

describe("DLQ tenant scoping", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    seed([
      { projectId: "A", batchId: "a1" },
      { projectId: "B", batchId: "b1" },
      { projectId: "A", batchId: "a2" },
      { projectId: "B", batchId: "b2" },
    ]);
  });

  it("inspectDlq scoped to a project never surfaces another tenant's batch ids or errors", async () => {
    const a = await inspectDlq(50, "A");
    expect(a.depth).toBe(2);
    expect(a.batches.map((b) => b.batchId)).toEqual(["a1", "a2"]);
    expect(a.batches.every((b) => b.projectId === "A")).toBe(true);
    // Unscoped (operator CLI) sees everything.
    const all = await inspectDlq(50);
    expect(all.depth).toBe(4);
  });

  it("replayDlq scoped to a project re-enqueues only that project's batches and leaves the rest", async () => {
    const r = await replayDlq(Number.POSITIVE_INFINITY, "B");
    expect(r).toEqual({ replayed: 2, failed: 0 });
    expect(ingestAdd.mock.calls.map((c) => (c[1] as { batchId: string }).batchId)).toEqual(["b1", "b2"]);
    expect(jobs.map((j) => j.data.batchId)).toEqual(["a1", "a2"]); // A's jobs untouched
  });

  it("replayDlq honours the limit and counts (but keeps) jobs that fail to re-enqueue", async () => {
    ingestAdd.mockRejectedValueOnce(new Error("redis hiccup"));
    const r = await replayDlq(2);
    expect(r).toEqual({ replayed: 2, failed: 1 });
    expect(jobs).toHaveLength(2); // one kept (failed) + one never reached
  });
});
