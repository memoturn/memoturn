import { beforeEach, describe, expect, it, vi } from "vitest";

const findUnique = vi.fn();
vi.mock("@memoturn/db", () => ({ prisma: { evaluator: { findUnique } } }));

const generate = vi.fn();
vi.mock("@memoturn/llm", () => ({ generate }));

const submitBatch = vi.fn().mockResolvedValue(undefined);
vi.mock("./ingest.js", () => ({ submitBatch }));

const resolveProviderConfig = vi.fn().mockResolvedValue({});
vi.mock("./providers.js", () => ({ resolveProviderConfig }));

const { judgeWithEvaluator, runEvaluator } = await import("./evaluators.js");

const evaluatorRow = (over: Record<string, unknown> = {}) => ({
  id: "ev1",
  projectId: "p1",
  name: "quality",
  prompt: "Rate the response.",
  provider: "mock",
  model: "mock-gpt-4o",
  online: false,
  samplingRate: 1,
  filterName: "",
  version: 1,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...over,
});

describe("judgeWithEvaluator", () => {
  beforeEach(() => {
    findUnique.mockReset();
    generate.mockReset();
    submitBatch.mockClear();
    resolveProviderConfig.mockClear();
  });

  it("returns null and calls nothing else when the evaluator doesn't exist", async () => {
    findUnique.mockResolvedValue(null);
    const result = await judgeWithEvaluator("p1", "missing", { input: "in", output: "out" });
    expect(result).toBeNull();
    expect(generate).not.toHaveBeenCalled();
    expect(submitBatch).not.toHaveBeenCalled();
  });

  it("does NOT write a score through the ingest pipeline", async () => {
    findUnique.mockResolvedValue(evaluatorRow());
    generate.mockResolvedValue({ content: "synthesized" });
    const result = await judgeWithEvaluator("p1", "quality", { input: "in", output: "out" });
    expect(result).toEqual({ evaluator: "quality", score: 1, reasoning: "synthesized" });
    expect(submitBatch).not.toHaveBeenCalled();
  });

  it("parses a real (non-mock) provider's judge response", async () => {
    findUnique.mockResolvedValue(evaluatorRow({ provider: "openai" }));
    generate.mockResolvedValue({ content: '{"score": 0.75, "reasoning": "solid answer"}' });
    const result = await judgeWithEvaluator("p1", "quality", { input: "in", output: "out" });
    expect(result).toEqual({ evaluator: "quality", score: 0.75, reasoning: "solid answer" });
    expect(submitBatch).not.toHaveBeenCalled();
  });
});

describe("runEvaluator", () => {
  beforeEach(() => {
    findUnique.mockReset();
    generate.mockReset();
    submitBatch.mockClear().mockResolvedValue(undefined);
    resolveProviderConfig.mockClear();
  });

  it("returns null when the evaluator doesn't exist", async () => {
    findUnique.mockResolvedValue(null);
    const result = await runEvaluator("p1", "missing", { traceId: "t1", input: "in", output: "out" });
    expect(result).toBeNull();
    expect(submitBatch).not.toHaveBeenCalled();
  });

  it("still writes a score back through the ingest pipeline (unchanged public behavior)", async () => {
    findUnique.mockResolvedValue(evaluatorRow());
    generate.mockResolvedValue({ content: "synthesized" });
    const result = await runEvaluator("p1", "quality", { traceId: "t1", input: "in", output: "out" });
    expect(result).toEqual({ evaluator: "quality", traceId: "t1", score: 1, reasoning: "synthesized" });
    expect(submitBatch).toHaveBeenCalledTimes(1);
    const [projectId, req] = submitBatch.mock.calls[0] as [
      string,
      { batch: { type: string; body: Record<string, unknown> }[] },
    ];
    expect(projectId).toBe("p1");
    expect(req.batch).toHaveLength(1);
    expect(req.batch[0]).toMatchObject({
      type: "score-create",
      body: expect.objectContaining({
        traceId: "t1",
        name: "quality",
        value: 1,
        source: "EVAL",
        dataType: "NUMERIC",
      }),
    });
  });
});
