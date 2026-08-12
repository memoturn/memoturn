import { beforeEach, describe, expect, it, vi } from "vitest";

const datasetFindUnique = vi.fn();
const runnerFindUnique = vi.fn();
const runnerUpsert = vi.fn();
const runnerUpdate = vi.fn().mockResolvedValue({});
const runnerDeleteMany = vi.fn();
const runUpsert = vi.fn();
const runItemUpsert = vi.fn().mockResolvedValue({});
const itemFindFirst = vi.fn();
const versionFindUnique = vi.fn();

vi.mock("@memoturn/db", () => ({
  prisma: {
    dataset: { findUnique: datasetFindUnique },
    datasetRunner: {
      findUnique: runnerFindUnique,
      upsert: runnerUpsert,
      update: runnerUpdate,
      deleteMany: runnerDeleteMany,
    },
    datasetRun: { upsert: runUpsert },
    datasetRunItem: { upsert: runItemUpsert },
    datasetItem: { findFirst: itemFindFirst },
    datasetVersion: { findUnique: versionFindUnique },
  },
}));

const isPublicUrl = vi.fn().mockResolvedValue(true);
vi.mock("./net.js", () => ({ isPublicUrl }));

const { DatasetRunnerError, recordRunItem, setDatasetRunner, triggerRemoteRun } = await import("./dataset-runner.js");

const dataset = (over: Record<string, unknown> = {}) => ({
  id: "ds1",
  name: "regression",
  runner: { url: "https://runner.example/run", secret: "s3cret", enabled: true },
  _count: { items: 42 },
  ...over,
});

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  for (const fn of [
    datasetFindUnique,
    runnerFindUnique,
    runnerUpsert,
    runnerDeleteMany,
    runUpsert,
    itemFindFirst,
    versionFindUnique,
  ]) {
    fn.mockReset();
  }
  runnerUpdate.mockClear().mockResolvedValue({});
  runItemUpsert.mockClear().mockResolvedValue({});
  isPublicUrl.mockClear().mockResolvedValue(true);
  runUpsert.mockResolvedValue({ id: "run1", name: "nightly" });
  fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 202 });
  vi.stubGlobal("fetch", fetchMock);
});

describe("setDatasetRunner", () => {
  it("refuses a url that isn't publicly resolvable (SSRF)", async () => {
    datasetFindUnique.mockResolvedValue({ id: "ds1" });
    isPublicUrl.mockResolvedValue(false);
    await expect(setDatasetRunner("p1", "regression", { url: "http://169.254.169.254/" })).rejects.toBeInstanceOf(
      DatasetRunnerError,
    );
    expect(runnerUpsert).not.toHaveBeenCalled();
  });

  it("returns a secret once and rotates it when re-registered", async () => {
    datasetFindUnique.mockResolvedValue({ id: "ds1" });
    runnerUpsert.mockImplementation(({ create }: { create: Record<string, unknown> }) =>
      Promise.resolve({
        url: create.url,
        enabled: true,
        createdAt: new Date("2026-08-12T00:00:00Z"),
        lastInvokedAt: null,
        lastStatus: null,
        lastError: "",
      }),
    );
    const first = await setDatasetRunner("p1", "regression", { url: "https://a.example/run" });
    const second = await setDatasetRunner("p1", "regression", { url: "https://a.example/run" });
    expect(first?.secret).toMatch(/^dsrun_/);
    expect(second?.secret).not.toBe(first?.secret);
    // Re-registration replaces the secret in the UPDATE branch too, not just on create.
    const update = runnerUpsert.mock.calls[1]![0].update as Record<string, unknown>;
    expect(String(update.secret)).toMatch(/^dsrun_/);
  });
});

describe("triggerRemoteRun", () => {
  it("sends a signed pointer, not the dataset contents", async () => {
    datasetFindUnique.mockResolvedValue(dataset());
    const result = await triggerRemoteRun("p1", "regression", { runName: "nightly" });

    expect(result).toMatchObject({ dataset: "regression", runName: "nightly", itemCount: 42, accepted: true });
    const [url, init] = fetchMock.mock.calls[0] as [string, { headers: Record<string, string>; body: string }];
    expect(url).toBe("https://runner.example/run");
    expect(init.headers["x-memoturn-signature"]).toMatch(/^sha256=[0-9a-f]{64}$/);
    const body = JSON.parse(init.body) as Record<string, unknown>;
    expect(body).toMatchObject({
      event: "dataset.run.requested",
      dataset: "regression",
      runName: "nightly",
      itemCount: 42,
      itemsUrl: "/v1/datasets/regression",
      resultsUrl: "/v1/dataset-run-items",
    });
    // The trigger must stay bounded regardless of dataset size.
    expect(body.items).toBeUndefined();
  });

  it("creates the run row before firing, so a run that never returns is visible", async () => {
    datasetFindUnique.mockResolvedValue(dataset());
    await triggerRemoteRun("p1", "regression", { runName: "nightly" });
    expect(runUpsert).toHaveBeenCalled();
    expect(runUpsert.mock.invocationCallOrder[0]!).toBeLessThan(fetchMock.mock.invocationCallOrder[0]!);
  });

  it("reports a rejecting runner instead of pretending the run started", async () => {
    datasetFindUnique.mockResolvedValue(dataset());
    fetchMock.mockResolvedValue({ ok: false, status: 503 });
    const result = await triggerRemoteRun("p1", "regression", { runName: "nightly" });
    expect(result).toMatchObject({ accepted: false, status: 503, error: "HTTP 503" });
    expect(runnerUpdate.mock.calls[0]![0].data).toMatchObject({ lastStatus: 503, lastError: "HTTP 503" });
  });

  it("records an unreachable runner as an error, not a crash", async () => {
    datasetFindUnique.mockResolvedValue(dataset());
    fetchMock.mockRejectedValue(new Error("connect ECONNREFUSED"));
    const result = await triggerRemoteRun("p1", "regression", { runName: "nightly" });
    expect(result.accepted).toBe(false);
    expect(result.error).toContain("ECONNREFUSED");
  });

  it("re-checks the url at dispatch, catching a rebound DNS entry", async () => {
    datasetFindUnique.mockResolvedValue(dataset());
    isPublicUrl.mockResolvedValue(false);
    const result = await triggerRemoteRun("p1", "regression", { runName: "nightly" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.error).toContain("public address");
  });

  it("rejects a dataset with no runner, a disabled runner, and an unknown version", async () => {
    datasetFindUnique.mockResolvedValue(dataset({ runner: null }));
    await expect(triggerRemoteRun("p1", "regression", { runName: "n" })).rejects.toThrow(/no runner/);

    datasetFindUnique.mockResolvedValue(dataset({ runner: { url: "https://x", secret: "s", enabled: false } }));
    await expect(triggerRemoteRun("p1", "regression", { runName: "n" })).rejects.toThrow(/disabled/);

    datasetFindUnique.mockResolvedValue(dataset());
    versionFindUnique.mockResolvedValue(null);
    await expect(triggerRemoteRun("p1", "regression", { runName: "n", version: 9 })).rejects.toThrow(/version 9/);
  });
});

describe("recordRunItem", () => {
  it("links a trace, creating the run on demand", async () => {
    datasetFindUnique.mockResolvedValue({ id: "ds1" });
    itemFindFirst.mockResolvedValue({ id: "item1" });
    const result = await recordRunItem("p1", {
      datasetName: "regression",
      runName: "nightly",
      datasetItemId: "item1",
      traceId: "t1",
    });
    expect(result).toEqual({ run: "nightly", datasetItemId: "item1", traceId: "t1" });
    // Upserted, so a retried report overwrites rather than duplicating the link.
    expect(runItemUpsert.mock.calls[0]![0].update).toEqual({ traceId: "t1" });
  });

  it("refuses an item that belongs to another dataset", async () => {
    datasetFindUnique.mockResolvedValue({ id: "ds1" });
    itemFindFirst.mockResolvedValue(null);
    await expect(
      recordRunItem("p1", { datasetName: "regression", runName: "n", datasetItemId: "other", traceId: "t1" }),
    ).rejects.toThrow(/has no item/);
    expect(runItemUpsert).not.toHaveBeenCalled();
  });
});
