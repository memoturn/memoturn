import { describe, expect, it } from "vitest";
import { EVALUATOR_TEMPLATES, getEvaluatorTemplate } from "./evaluator-templates.js";

describe("evaluator templates", () => {
  it("ships a non-empty library", () => {
    expect(EVALUATOR_TEMPLATES.length).toBeGreaterThanOrEqual(8);
  });

  it("has unique keys and non-empty prompts + valid requirements", () => {
    const keys = new Set<string>();
    const allowed = new Set(["input", "output", "expectedOutput", "context"]);
    for (const t of EVALUATOR_TEMPLATES) {
      expect(keys.has(t.key), `duplicate key ${t.key}`).toBe(false);
      keys.add(t.key);
      expect(t.name.length).toBeGreaterThan(0);
      expect(t.prompt.length).toBeGreaterThan(20);
      expect(t.requires.length).toBeGreaterThan(0);
      for (const r of t.requires) expect(allowed.has(r), `bad requirement ${r} on ${t.key}`).toBe(true);
      expect(t.defaultModel).toBeTruthy();
    }
  });

  it("resolves a template by key and returns undefined for unknown", () => {
    expect(getEvaluatorTemplate("faithfulness")?.name).toBe("faithfulness");
    expect(getEvaluatorTemplate("nope")).toBeUndefined();
  });
});
