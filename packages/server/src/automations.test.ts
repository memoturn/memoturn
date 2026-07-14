import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const findMany = vi.fn();
vi.mock("@memoturn/db", () => ({ prisma: { automation: { findMany } } }));

const redis = { get: vi.fn(), set: vi.fn(), del: vi.fn() };
vi.mock("@memoturn/db/queue", () => ({ redisConnection: () => redis }));

const { automationMatches, dispatchAutomationsBatch } = await import("./automations.js");

describe("automationMatches", () => {
  it("with no threshold or filter, always matches", () => {
    expect(automationMatches({}, { name: "x", value: 5 })).toBe(true);
  });
  it("threshold fires only when the value is below it", () => {
    expect(automationMatches({ threshold: 0.5 }, { value: 0.2 })).toBe(true);
    expect(automationMatches({ threshold: 0.5 }, { value: 0.9 })).toBe(false);
    expect(automationMatches({ threshold: 0.5 }, { value: null })).toBe(false); // no value → not below
  });
  it("filter is a substring match on the name", () => {
    expect(automationMatches({ filter: "rag" }, { name: "rag-pipeline" })).toBe(true);
    expect(automationMatches({ filter: "rag" }, { name: "chat" })).toBe(false);
    expect(automationMatches({ filter: "rag" }, {})).toBe(false);
  });
  it("threshold and filter must both pass", () => {
    expect(automationMatches({ threshold: 0.5, filter: "q" }, { value: 0.2, name: "quality" })).toBe(true);
    expect(automationMatches({ threshold: 0.5, filter: "q" }, { value: 0.2, name: "latency" })).toBe(false);
    expect(automationMatches({ threshold: 0.5, filter: "q" }, { value: 0.9, name: "quality" })).toBe(false);
  });
});

describe("dispatchAutomationsBatch", () => {
  const origEnv = process.env.ALLOW_PRIVATE_WEBHOOK_TARGETS;
  const fetchMock = vi.fn();

  const rule = (over: Record<string, unknown> = {}) => ({
    id: "a1",
    action: "webhook",
    target: "http://localhost:9/auto",
    threshold: null,
    filter: "",
    ...over,
  });

  beforeEach(() => {
    process.env.ALLOW_PRIVATE_WEBHOOK_TARGETS = "1"; // permit the fake localhost targets
    findMany.mockReset();
    redis.get.mockReset().mockResolvedValue(null);
    redis.set.mockReset().mockResolvedValue("OK");
    redis.del.mockReset().mockResolvedValue(1);
    fetchMock.mockReset().mockResolvedValue(new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (origEnv === undefined) delete process.env.ALLOW_PRIVATE_WEBHOOK_TARGETS;
    else process.env.ALLOW_PRIVATE_WEBHOOK_TARGETS = origEnv;
  });

  it("does ONE config lookup for the whole batch and caches it", async () => {
    findMany.mockResolvedValue([rule()]);
    const fired = await dispatchAutomationsBatch("p1", "score.created", [
      { traceId: "t1", name: "a", value: 0.1 },
      { traceId: "t2", name: "b", value: 0.2 },
    ]);
    expect(fired).toBe(2);
    expect(findMany).toHaveBeenCalledTimes(1); // the old per-payload path called this 2×
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(redis.set).toHaveBeenCalledTimes(1); // list cached for the next batch
  });

  it("serves the config from Redis without touching Postgres on a cache hit", async () => {
    redis.get.mockResolvedValue(JSON.stringify([rule()]));
    const fired = await dispatchAutomationsBatch("p1", "score.created", [{ traceId: "t1", name: "a", value: 0.1 }]);
    expect(fired).toBe(1);
    expect(findMany).not.toHaveBeenCalled();
  });

  it("applies threshold/filter matching per payload", async () => {
    findMany.mockResolvedValue([rule({ threshold: 0.5, filter: "qual" })]);
    const fired = await dispatchAutomationsBatch("p1", "score.created", [
      { name: "quality", value: 0.1 }, // matches
      { name: "quality", value: 0.9 }, // above threshold
      { name: "latency", value: 0.1 }, // filter miss
    ]);
    expect(fired).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns 0 without fetching for empty payloads or no rules", async () => {
    findMany.mockResolvedValue([]);
    expect(await dispatchAutomationsBatch("p1", "score.created", [{ name: "x" }])).toBe(0);
    expect(await dispatchAutomationsBatch("p1", "score.created", [])).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never throws when a target fails (best-effort)", async () => {
    findMany.mockResolvedValue([rule()]);
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));
    await expect(dispatchAutomationsBatch("p1", "score.created", [{ name: "x", value: 0 }])).resolves.toBe(0);
  });
});
