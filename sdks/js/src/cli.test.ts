import { describe, expect, it } from "vitest";
import { formatReport, parseEvalArgs, resolveEvalPlan } from "./cli.js";
import type { GateResult } from "./dataset.js";

describe("parseEvalArgs", () => {
  it("parses dataset/run/baseline and repeated threshold flags", () => {
    const args = parseEvalArgs([
      "--dataset",
      "qa",
      "--run",
      "pr-1",
      "--baseline",
      "main",
      "--min",
      "faithfulness=0.8",
      "--max",
      "toxicity=0.1",
      "--max-regression",
      "faithfulness=0.05",
      "--json",
    ]);
    expect(args.dataset).toBe("qa");
    expect(args.run).toBe("pr-1");
    expect(args.baseline).toBe("main");
    expect(args.json).toBe(true);
    expect(args.thresholds).toEqual({
      faithfulness: { min: 0.8, maxRegression: 0.05 },
      toxicity: { max: 0.1 },
    });
  });

  it("rejects unknown options and malformed thresholds", () => {
    expect(() => parseEvalArgs(["--nope"])).toThrow(/unknown option/);
    expect(() => parseEvalArgs(["--min", "faithfulness"])).toThrow(/expected <name>=<number>/);
    expect(() => parseEvalArgs(["--min", "faithfulness=abc"])).toThrow(/invalid threshold/);
    expect(() => parseEvalArgs(["--dataset"])).toThrow(/missing value/);
  });
});

describe("resolveEvalPlan", () => {
  it("requires a dataset, run, and at least one threshold", () => {
    expect(() => resolveEvalPlan({ json: false, thresholds: {}, run: "r" })).toThrow(/no dataset/);
    expect(() => resolveEvalPlan({ json: false, thresholds: {}, dataset: "d" })).toThrow(/no run/);
    expect(() => resolveEvalPlan({ json: false, thresholds: {}, dataset: "d", run: "r" })).toThrow(/no thresholds/);
  });

  it("lets CLI flags override config values", () => {
    const plan = resolveEvalPlan({
      json: false,
      dataset: "cli-ds",
      thresholds: { faithfulness: { min: 0.9 } },
      // no config file → cfg is {}; still valid because flags supply everything
      run: "pr-2",
    });
    expect(plan).toEqual({
      dataset: "cli-ds",
      run: "pr-2",
      baseline: undefined,
      baseUrl: undefined,
      thresholds: { faithfulness: { min: 0.9 } },
    });
  });
});

describe("formatReport", () => {
  const base: GateResult = {
    dataset: "qa",
    run: "pr-1",
    baselineRun: "main",
    passed: false,
    scores: [
      { name: "faithfulness", mean: 0.72, count: 20 },
      { name: "toxicity", mean: 0.02, count: 20 },
    ],
    failures: [{ scoreName: "faithfulness", reason: "below_min", value: 0.72, bound: 0.8 }],
  };

  it("marks failing scores and renders the failure reason", () => {
    const report = formatReport(base);
    expect(report).toContain("gate FAIL");
    expect(report).toContain('baseline: "main"');
    expect(report).toContain("✗ faithfulness: mean 0.720 (n=20)");
    expect(report).toContain("✓ toxicity: mean 0.020 (n=20)");
    expect(report).toContain("! faithfulness: below min (value 0.720, bound 0.8)");
  });

  it("renders a passing gate", () => {
    const report = formatReport({ ...base, passed: true, failures: [] });
    expect(report).toContain("gate PASS");
    expect(report).not.toContain("✗");
  });
});
