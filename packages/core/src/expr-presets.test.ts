import { describe, expect, it } from "vitest";
import { compileExpression, type ExprContext, runExpression } from "./expr.js";
import { EXPR_PRESETS, fillExprPreset, getExprPreset } from "./expr-presets.js";

const ctx: ExprContext = {
  input: "where is my order?",
  output: "Your order number is ABC-1234 and it ships tomorrow.",
  expected: "ABC-1234",
  metadata: {},
};

describe("expression presets", () => {
  it("has unique keys", () => {
    const keys = EXPR_PRESETS.map((p) => p.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("every preset compiles and produces a score once its examples are filled in", () => {
    // This is the guard that matters: a preset that doesn't compile would ship a broken
    // one-click option, and the menu is the primary way people will reach this feature.
    for (const preset of EXPR_PRESETS) {
      const values = Object.fromEntries(preset.placeholders.map((p) => [p.key, p.example]));
      const expression = fillExprPreset(preset, values);
      expect(expression, `${preset.key} left a placeholder unfilled`).not.toContain("{{");
      expect(() => compileExpression(expression), `${preset.key} failed to compile`).not.toThrow();

      const { score } = runExpression(expression, ctx);
      expect(score, `${preset.key} produced an out-of-range score`).toBeGreaterThanOrEqual(0);
      expect(score, `${preset.key} produced an out-of-range score`).toBeLessThanOrEqual(1);
    }
  });

  it("declares exactly the placeholders its expression uses", () => {
    for (const preset of EXPR_PRESETS) {
      const used = [...preset.expression.matchAll(/\{\{\s*([\w.]+)\s*\}\}/g)].map((m) => m[1]);
      const declared = preset.placeholders.map((p) => p.key);
      expect(new Set(used), `${preset.key} placeholder mismatch`).toEqual(new Set(declared));
    }
  });

  it("leaves an unknown placeholder in place so it fails loudly rather than silently", () => {
    const preset = getExprPreset("max-length");
    expect(preset).toBeDefined();
    const filled = fillExprPreset(preset!, {});
    expect(filled).toContain("{{max}}");
    expect(() => compileExpression(filled)).toThrow();
  });

  it("resolves known presets and returns undefined for unknown ones", () => {
    expect(getExprPreset("valid-json")?.name).toBe("valid-json");
    expect(getExprPreset("nope")).toBeUndefined();
  });

  it("spot-checks a few presets against a realistic item", () => {
    const fill = (key: string, values: Record<string, string> = {}) =>
      runExpression(fillExprPreset(getExprPreset(key)!, values), ctx).score;

    expect(fill("regex-match", { pattern: "[A-Z]{3}-[0-9]{4}" })).toBe(1);
    expect(fill("contains-phrase", { phrase: "order number" })).toBe(1);
    expect(fill("does-not-contain", { phrase: "i cannot" })).toBe(1);
    expect(fill("expected-substring")).toBe(1);
    expect(fill("max-length", { max: "10" })).toBe(0);
    expect(fill("not-empty")).toBe(1);
    expect(fill("valid-json")).toBe(0); // the output is prose, not JSON
  });
});
