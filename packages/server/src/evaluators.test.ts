import { beforeEach, describe, expect, it, vi } from "vitest";

const findUnique = vi.fn();
vi.mock("@memoturn/db", () => ({ prisma: { evaluator: { findUnique } } }));

const generate = vi.fn();
vi.mock("@memoturn/llm", () => ({ generate }));

const submitBatch = vi.fn().mockResolvedValue(undefined);
vi.mock("./ingest.js", () => ({ submitBatch }));

const resolveProviderConfig = vi.fn().mockResolvedValue({});
vi.mock("./providers.js", () => ({ resolveProviderConfig }));

const { judgeWithEvaluator, runEvaluator, testExpression } = await import("./evaluators.js");

const evaluatorRow = (over: Record<string, unknown> = {}) => ({
  id: "ev1",
  projectId: "p1",
  name: "quality",
  kind: "LLM",
  prompt: "Rate the response.",
  expression: "",
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
    expect(result).toEqual({
      evaluator: "quality",
      scoreName: "quality",
      dataType: "NUMERIC",
      score: 1,
      label: "",
      reasoning: "synthesized",
    });
    expect(submitBatch).not.toHaveBeenCalled();
  });

  it("parses a real (non-mock) provider's judge response", async () => {
    findUnique.mockResolvedValue(evaluatorRow({ provider: "openai" }));
    generate.mockResolvedValue({ content: '{"score": 0.75, "reasoning": "solid answer"}' });
    const result = await judgeWithEvaluator("p1", "quality", { input: "in", output: "out" });
    expect(result).toEqual({
      evaluator: "quality",
      scoreName: "quality",
      dataType: "NUMERIC",
      score: 0.75,
      label: "",
      reasoning: "solid answer",
    });
    expect(submitBatch).not.toHaveBeenCalled();
  });

  it("aggregates an LLM jury as the mean of its members' votes", async () => {
    findUnique.mockResolvedValue(
      evaluatorRow({
        provider: "openai",
        jurors: [
          { provider: "openai", model: "gpt-a" },
          { provider: "anthropic", model: "claude-b" },
        ],
      }),
    );
    generate
      .mockResolvedValueOnce({ content: '{"score": 0.6, "reasoning": "ok"}' })
      .mockResolvedValueOnce({ content: '{"score": 1.0, "reasoning": "great"}' });
    const result = await judgeWithEvaluator("p1", "quality", { input: "in", output: "out" });
    expect(generate).toHaveBeenCalledTimes(2);
    expect(result?.score).toBeCloseTo(0.8, 5);
    expect(result?.votes).toHaveLength(2);
    expect(result?.votes?.map((v) => v.model)).toEqual(["gpt-a", "claude-b"]);
  });

  it("drops a juror that errors but still scores from the survivors", async () => {
    findUnique.mockResolvedValue(
      evaluatorRow({
        provider: "openai",
        jurors: [
          { provider: "openai", model: "gpt-a" },
          { provider: "openai", model: "gpt-b" },
        ],
      }),
    );
    generate
      .mockResolvedValueOnce({ content: '{"score": 0.4, "reasoning": "meh"}' })
      .mockRejectedValueOnce(new Error("provider 500"));
    const result = await judgeWithEvaluator("p1", "quality", { input: "in", output: "out" });
    expect(result?.score).toBeCloseTo(0.4, 5);
    expect(result?.votes).toHaveLength(1);
  });

  it("throws when every juror fails (so best-effort/retry handling engages)", async () => {
    findUnique.mockResolvedValue(
      evaluatorRow({ provider: "openai", jurors: [{ provider: "openai", model: "gpt-a" }] }),
    );
    generate.mockRejectedValue(new Error("provider down"));
    await expect(judgeWithEvaluator("p1", "quality", { input: "in", output: "out" })).rejects.toThrow("provider down");
  });
});

describe("judge variable mapping", () => {
  beforeEach(() => {
    findUnique.mockReset();
    generate.mockReset();
    resolveProviderConfig.mockClear();
  });

  it("sends only the mapped variables and renders them into the prompt", async () => {
    findUnique.mockResolvedValue(
      evaluatorRow({
        provider: "openai",
        model: "gpt-x",
        prompt: "Is {{answer}} supported by {{context}}?",
        variableMapping: [
          { variable: "answer", source: "trace.output" },
          { variable: "context", source: "observation.output", observationName: "retriever" },
        ],
      }),
    );
    generate.mockResolvedValue({ content: '{"score":0.5,"reasoning":"partly"}' });

    const result = await judgeWithEvaluator("p1", "quality", {
      input: "the question",
      output: "the answer",
      observations: [{ name: "retriever", output: "the context" }],
    });

    expect(result).toMatchObject({ score: 0.5, reasoning: "partly" });
    const call = generate.mock.calls[0]![0] as { messages: { role: string; content: string }[] };
    expect(call.messages[0]!.content).toContain("Is the answer supported by the context?");
    // The judged payload is the mapping, not the built-in input/output/expectedOutput triple.
    expect(JSON.parse(call.messages[1]!.content)).toEqual({ answer: "the answer", context: "the context" });
  });

  it("keeps the built-in payload when no mapping is declared", async () => {
    findUnique.mockResolvedValue(evaluatorRow({ provider: "openai", model: "gpt-x" }));
    generate.mockResolvedValue({ content: '{"score":1,"reasoning":"good"}' });
    await judgeWithEvaluator("p1", "quality", { input: "in", output: "out", expectedOutput: "exp" });
    const call = generate.mock.calls[0]![0] as { messages: { content: string }[] };
    expect(JSON.parse(call.messages[1]!.content)).toEqual({ input: "in", output: "out", expectedOutput: "exp" });
  });
});

describe("structured evaluator output", () => {
  beforeEach(() => {
    findUnique.mockReset();
    generate.mockReset();
    submitBatch.mockClear().mockResolvedValue(undefined);
    resolveProviderConfig.mockClear();
  });

  const judgeBody = () => (generate.mock.calls[0]![0] as { messages: { content: string }[] }).messages[0]!.content;
  const written = () =>
    (submitBatch.mock.calls[0]![1] as { batch: { body: Record<string, unknown> }[] }).batch[0]!.body;

  it("asks a numeric judge for a score, and writes a NUMERIC score (unchanged default)", async () => {
    findUnique.mockResolvedValue(evaluatorRow({ provider: "openai", model: "gpt-x" }));
    generate.mockResolvedValue({ content: '{"score":0.25,"reasoning":"meh"}' });
    await runEvaluator("p1", "quality", { traceId: "t1", input: "in", output: "out" });
    expect(judgeBody()).toContain('{"score": <number between 0 and 1>');
    expect(written()).toMatchObject({ name: "quality", dataType: "NUMERIC", value: 0.25 });
    expect(written().stringValue).toBeUndefined();
  });

  it("asks a categorical judge for a label and writes it as stringValue with no numeric value", async () => {
    findUnique.mockResolvedValue(
      evaluatorRow({
        provider: "openai",
        model: "gpt-x",
        scoreDataType: "CATEGORICAL",
        scoreCategories: ["hallucination", "refusal", "ok"],
      }),
    );
    generate.mockResolvedValue({ content: '{"label":"refusal","reasoning":"declined"}' });
    const result = await runEvaluator("p1", "quality", { traceId: "t1", input: "in", output: "out" });
    expect(judgeBody()).toContain("The label MUST be one of: hallucination, refusal, ok.");
    expect(written()).toMatchObject({ dataType: "CATEGORICAL", stringValue: "refusal" });
    // No stand-in zero: a label must not read as a failing number in averages and gates.
    expect(written().value).toBeUndefined();
    expect(result?.score).toBeNull();
  });

  it("rejects an off-list label rather than inventing a category", async () => {
    findUnique.mockResolvedValue(
      evaluatorRow({ provider: "openai", model: "gpt-x", scoreDataType: "CATEGORICAL", scoreCategories: ["a", "b"] }),
    );
    generate.mockResolvedValue({ content: '{"label":"something else","reasoning":"why"}' });
    const result = await judgeWithEvaluator("p1", "quality", { input: "in", output: "out" });
    expect(result?.label).toBe("");
    expect(result?.reasoning).toContain("off-list label");
  });

  it("accepts any label when no categories are declared", async () => {
    findUnique.mockResolvedValue(evaluatorRow({ provider: "openai", model: "gpt-x", scoreDataType: "CATEGORICAL" }));
    generate.mockResolvedValue({ content: '{"label":"whatever","reasoning":"r"}' });
    expect((await judgeWithEvaluator("p1", "quality", { input: "i", output: "o" }))?.label).toBe("whatever");
  });

  it("maps a boolean judge to 1/0 and writes a BOOLEAN score", async () => {
    findUnique.mockResolvedValue(evaluatorRow({ provider: "openai", model: "gpt-x", scoreDataType: "BOOLEAN" }));
    generate.mockResolvedValue({ content: '{"pass":false,"reasoning":"no citation"}' });
    await runEvaluator("p1", "quality", { traceId: "t1", input: "in", output: "out" });
    expect(judgeBody()).toContain('{"pass": <true or false>');
    expect(written()).toMatchObject({ dataType: "BOOLEAN", value: 0 });
  });

  it("writes under a declared score name instead of the evaluator name", async () => {
    findUnique.mockResolvedValue(evaluatorRow({ provider: "openai", model: "gpt-x", scoreName: "answer-quality" }));
    generate.mockResolvedValue({ content: '{"score":1,"reasoning":"good"}' });
    await runEvaluator("p1", "quality", { traceId: "t1", input: "in", output: "out" });
    expect(written().name).toBe("answer-quality");
  });

  it("aggregates a categorical jury by majority, not by mean", async () => {
    findUnique.mockResolvedValue(
      evaluatorRow({
        provider: "openai",
        model: "gpt-x",
        scoreDataType: "CATEGORICAL",
        scoreCategories: ["yes", "no"],
        jurors: [
          { provider: "openai", model: "j1" },
          { provider: "openai", model: "j2" },
          { provider: "openai", model: "j3" },
        ],
      }),
    );
    generate
      .mockResolvedValueOnce({ content: '{"label":"yes","reasoning":"a"}' })
      .mockResolvedValueOnce({ content: '{"label":"no","reasoning":"b"}' })
      .mockResolvedValueOnce({ content: '{"label":"yes","reasoning":"c"}' });
    const result = await judgeWithEvaluator("p1", "quality", { input: "i", output: "o" });
    expect(result?.label).toBe("yes");
    expect(result?.score).toBeNull();
    expect(result?.reasoning).toContain("majority 2/3");
  });

  it("keeps an unparseable judge response inspectable instead of silently scoring zero", async () => {
    findUnique.mockResolvedValue(evaluatorRow({ provider: "openai", model: "gpt-x" }));
    generate.mockResolvedValue({ content: "I cannot comply with that." });
    const result = await judgeWithEvaluator("p1", "quality", { input: "i", output: "o" });
    expect(result?.score).toBe(0);
    expect(result?.reasoning).toContain("I cannot comply");
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

  it("scopes the score to a span when observationId is given, with a per-span deterministic id", async () => {
    findUnique.mockResolvedValue(evaluatorRow({ scope: "observation" }));
    generate.mockResolvedValue({ content: "synthesized" });
    await runEvaluator("p1", "quality", { traceId: "t1", observationId: "o1", input: "in", output: "out" });
    await runEvaluator("p1", "quality", { traceId: "t1", observationId: "o2", input: "in", output: "out" });
    const bodies = submitBatch.mock.calls.map(
      (call) => (call[1] as { batch: { body: Record<string, unknown> }[] }).batch[0]!.body,
    );
    expect(bodies[0]).toMatchObject({ traceId: "t1", observationId: "o1" });
    expect(bodies[1]).toMatchObject({ traceId: "t1", observationId: "o2" });
    // Two spans of one trace must not collide on the same score id (which would overwrite).
    expect(bodies[0]!.id).not.toBe(bodies[1]!.id);
  });

  it("still writes a score back through the ingest pipeline (unchanged public behavior)", async () => {
    findUnique.mockResolvedValue(evaluatorRow());
    generate.mockResolvedValue({ content: "synthesized" });
    const result = await runEvaluator("p1", "quality", { traceId: "t1", input: "in", output: "out" });
    expect(result).toEqual({
      evaluator: "quality",
      traceId: "t1",
      observationId: "",
      scoreName: "quality",
      dataType: "NUMERIC",
      score: 1,
      label: "",
      reasoning: "synthesized",
    });
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

describe("CODE evaluators", () => {
  beforeEach(() => {
    findUnique.mockReset();
    generate.mockReset();
    submitBatch.mockClear();
    // Must be cleared too — the LLM-path tests above call it, and this suite asserts it is NOT
    // called, so a leaked count would make the assertion meaningless.
    resolveProviderConfig.mockClear();
  });

  it("scores from the expression without calling a provider", async () => {
    findUnique.mockResolvedValue(evaluatorRow({ kind: "CODE", expression: 'contains(lower(output), "refund")' }));

    const hit = await judgeWithEvaluator("p1", "quality", { input: "help", output: "Your REFUND is processed." });
    expect(hit?.score).toBe(1);
    // The whole point of a CODE evaluator: deterministic, free, and no provider key needed.
    expect(generate).not.toHaveBeenCalled();
    expect(resolveProviderConfig).not.toHaveBeenCalled();

    const miss = await judgeWithEvaluator("p1", "quality", { input: "help", output: "No such thing." });
    expect(miss?.score).toBe(0);
  });

  it("binds input, output, expected, and metadata", async () => {
    findUnique.mockResolvedValue(
      evaluatorRow({
        kind: "CODE",
        expression: 'exactMatch(output, expected) and has(metadata, "ok") and len(input) > 0',
      }),
    );
    const res = await judgeWithEvaluator("p1", "quality", {
      input: "q",
      output: "a",
      expectedOutput: "a",
      metadata: { ok: true },
    });
    expect(res?.score).toBe(1);
  });

  it("explains the result in `reasoning` — the expression and what it produced", async () => {
    findUnique.mockResolvedValue(evaluatorRow({ kind: "CODE", expression: "len(output) < 5" }));
    const res = await judgeWithEvaluator("p1", "quality", { input: "", output: "hello world" });
    expect(res?.reasoning).toBe("len(output) < 5 → false");
  });

  it("supports graded (non-binary) scores", async () => {
    findUnique.mockResolvedValue(evaluatorRow({ kind: "CODE", expression: "min(1, len(words(output)) / 4)" }));
    const res = await judgeWithEvaluator("p1", "quality", { input: "", output: "one two" });
    expect(res?.score).toBe(0.5);
  });

  it("throws on a runtime failure so the caller's best-effort handling applies", async () => {
    // Ingest must never fail because of an evaluator — the worker catches this per-evaluator,
    // exactly as it does for a failed LLM judge.
    findUnique.mockResolvedValue(evaluatorRow({ kind: "CODE", expression: '"not a score"' }));
    await expect(judgeWithEvaluator("p1", "quality", { input: "", output: "x" })).rejects.toThrow(
      /score must be a number/,
    );
  });

  it("still writes the score through the ingest pipeline like an LLM evaluator", async () => {
    findUnique.mockResolvedValue(evaluatorRow({ kind: "CODE", expression: "true" }));
    await runEvaluator("p1", "quality", { traceId: "t1", input: "q", output: "a" });
    expect(submitBatch).toHaveBeenCalled();
  });
});

describe("testExpression", () => {
  it("returns the score and value for a valid expression", () => {
    expect(testExpression({ expression: "len(output) < 5", output: "hi" })).toEqual({
      ok: true,
      score: 1,
      value: "true",
      error: null,
    });
  });

  it("returns a compile error instead of throwing — the editor needs to show it", () => {
    const res = testExpression({ expression: "len(", output: "hi" });
    expect(res.ok).toBe(false);
    expect(res.score).toBeNull();
    expect(res.error).toMatch(/unexpected/);
  });

  it("reports the raw value even when it isn't score-shaped", () => {
    // This is the case where seeing the value matters most.
    const res = testExpression({ expression: "output", output: "hello" });
    expect(res.ok).toBe(false);
    expect(res.value).toBe('"hello"');
    expect(res.error).toMatch(/score must be a number/);
  });

  it("rejects an unknown name with a helpful message", () => {
    expect(testExpression({ expression: "process", output: "" }).error).toMatch(/unknown name/);
  });
});
