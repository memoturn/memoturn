import { beforeEach, describe, expect, it, vi } from "vitest";

const findMany = vi.fn();
const findUnique = vi.fn();
vi.mock("@memoturn/db", () => ({ prisma: { evaluator: { findMany, findUnique } } }));

const generate = vi.fn();
vi.mock("@memoturn/llm", () => ({ generate }));

const submitBatch = vi.fn().mockResolvedValue(undefined);
vi.mock("./ingest.js", () => ({ submitBatch }));

const resolveProviderConfig = vi.fn().mockResolvedValue({});
vi.mock("./providers.js", () => ({ resolveProviderConfig }));

const listSessions = vi.fn();
const listTraces = vi.fn();
const getTraceIO = vi.fn();
vi.mock("@memoturn/telemetry", () => ({ telemetry: () => ({ listSessions, listTraces, getTraceIO }) }));

const { runAllThreadEvaluations } = await import("./evaluators.js");

// A thread-scope evaluator using the mock provider (judge synthesizes score 1).
const threadEvaluator = (over: Record<string, unknown> = {}) => ({
  id: "ev-thread",
  projectId: "p1",
  name: "user-frustration",
  prompt: "Judge frustration.",
  provider: "mock",
  model: "mock-gpt-4o",
  jurors: [],
  online: true,
  scope: "thread",
  cooldownSeconds: 900, // 15 min
  samplingRate: 1,
  filterName: "",
  version: 1,
  ...over,
});

const NOW = new Date("2026-07-24T12:00:00.000Z");

describe("runAllThreadEvaluations", () => {
  beforeEach(() => {
    for (const m of [findMany, findUnique, generate, submitBatch, listSessions, listTraces, getTraceIO]) m.mockReset();
    submitBatch.mockResolvedValue(undefined);
    resolveProviderConfig.mockResolvedValue({});
    generate.mockResolvedValue({ content: "judged" });
    findUnique.mockResolvedValue(threadEvaluator()); // scoreThread → judgeWithEvaluator looks this up
  });

  it("does nothing when there are no thread evaluators", async () => {
    findMany.mockResolvedValue([]);
    const res = await runAllThreadEvaluations(NOW);
    expect(res).toEqual({ evaluated: 0, scored: 0 });
    expect(listSessions).not.toHaveBeenCalled();
  });

  it("scores a session that just crossed the cooldown and attaches the score to the latest trace", async () => {
    findMany.mockResolvedValue([threadEvaluator()]);
    // upper = NOW-900s = 11:45:00, window 120s → settle band [11:43:00, 11:45:00).
    listSessions.mockResolvedValue([
      { session_id: "s-settled", last_seen: "2026-07-24T11:44:00Z", trace_count: 2, first_seen: "", total_cost: 0 },
      { session_id: "s-active", last_seen: "2026-07-24T11:59:30Z", trace_count: 1, first_seen: "", total_cost: 0 }, // too recent
      { session_id: "s-old", last_seen: "2026-07-24T10:00:00Z", trace_count: 5, first_seen: "", total_cost: 0 }, // long past band
    ]);
    listTraces.mockResolvedValue([
      { id: "t1", name: "turn-1", timestamp: "2026-07-24T11:40:00Z" },
      { id: "t2", name: "turn-2", timestamp: "2026-07-24T11:44:00Z" },
    ]);
    getTraceIO.mockResolvedValue([
      { id: "t1", name: "turn-1", input: "hi", output: "hello" },
      { id: "t2", name: "turn-2", input: "again?", output: "yes" },
    ]);

    const res = await runAllThreadEvaluations(NOW);

    expect(res).toEqual({ evaluated: 1, scored: 1 }); // only s-settled is in the band
    expect(listTraces).toHaveBeenCalledWith("p1", { sessionId: "s-settled", limit: 50 });
    expect(submitBatch).toHaveBeenCalledTimes(1);
    const [projectId, req] = submitBatch.mock.calls[0] as [string, { batch: { body: Record<string, unknown> }[] }];
    expect(projectId).toBe("p1");
    expect(req.batch[0]!.body).toMatchObject({
      traceId: "t2", // latest trace in the session
      name: "user-frustration",
      source: "EVAL",
      value: 1,
    });
    // The whole transcript (oldest-first) is handed to the judge as the input.
    const judgeUserMsg = generate.mock.calls[0]![0].messages[1].content as string;
    expect(judgeUserMsg).toContain("Turn 1");
    expect(judgeUserMsg).toContain("Turn 2");
  });

  it("skips a session with no traces without scoring", async () => {
    findMany.mockResolvedValue([threadEvaluator()]);
    listSessions.mockResolvedValue([
      { session_id: "s-empty", last_seen: "2026-07-24T11:44:00Z", trace_count: 0, first_seen: "", total_cost: 0 },
    ]);
    listTraces.mockResolvedValue([]);
    const res = await runAllThreadEvaluations(NOW);
    expect(res).toEqual({ evaluated: 1, scored: 0 });
    expect(submitBatch).not.toHaveBeenCalled();
  });
});
