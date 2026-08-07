import { describe, expect, it } from "vitest";
import {
  compileExpression,
  type ExprContext,
  ExprError,
  evaluateExpression,
  MAX_EXPRESSION_LENGTH,
  runExpression,
} from "./expr.js";

const ctx = (over: Partial<ExprContext> = {}): ExprContext => ({
  input: "what is 2+2?",
  output: "The answer is 4.",
  expected: "4",
  metadata: {},
  ...over,
});

const run = (src: string, c: ExprContext = ctx()) => runExpression(src, c).score;
/** Raw value, no score coercion — for asserting on intermediate results. */
const val = (src: string, c: ExprContext = ctx()) => evaluateExpression(src, c);

describe("literals and operators", () => {
  it("evaluates booleans, numbers, and comparisons", () => {
    expect(run("true")).toBe(1);
    expect(run("false")).toBe(0);
    expect(run("1")).toBe(1);
    expect(run("0.25")).toBe(0.25);
    expect(run("2 > 1")).toBe(1);
    expect(run("2 <= 1")).toBe(0);
  });

  it("short-circuits and/or at runtime", () => {
    // The right side throws if evaluated (invalid regex is a RUNTIME error), so reaching
    // these results at all proves it was skipped. Note unknown *names* are rejected at parse
    // time instead — short-circuiting can't rescue those, by design.
    expect(run('false and matches(output, "(unclosed")')).toBe(0);
    expect(run('true or matches(output, "(unclosed")')).toBe(1);
    expect(() => run('true and matches(output, "(unclosed")')).toThrow(/invalid regex/);
  });

  it("supports both word and symbol boolean operators", () => {
    expect(run("true and false")).toBe(0);
    expect(run("true && false")).toBe(0);
    expect(run("true or false")).toBe(1);
    expect(run("true || false")).toBe(1);
    expect(run("not false")).toBe(1);
    expect(run("!false")).toBe(1);
  });

  it("honors precedence and parentheses", () => {
    expect(val("1 + 2 * 3", ctx())).toBe(7);
    expect(val("(1 + 2) * 3", ctx())).toBe(9);
    expect(run("true or false and false")).toBe(1); // and binds tighter than or
  });

  it("evaluates a ternary", () => {
    expect(run('output == "The answer is 4." ? 1 : 0')).toBe(1);
    expect(run('output == "nope" ? 1 : 0')).toBe(0);
  });

  it("concatenates with + when either side is a string, and divides by zero to 0", () => {
    expect(val('"a" + 1', ctx())).toBe("a1");
    expect(val("1 / 0", ctx())).toBe(0);
  });
});

describe("variables and member access", () => {
  it("reads the four bound variables", () => {
    expect(run('input == "what is 2+2?"')).toBe(1);
    expect(run('expected == "4"')).toBe(1);
    expect(run("isEmpty(metadata)")).toBe(1);
  });

  it("reads nested object and array members, by dot and by index", () => {
    const c = ctx({ output: { items: [{ score: 0.9 }, { score: 0.2 }], ok: true } });
    expect(run("output.ok", c)).toBe(1);
    expect(val("output.items[0].score", c)).toBe(0.9);
    expect(val("output.items.length", c)).toBe(2);
    expect(val('output["items"][1]["score"]', c)).toBe(0.2);
  });

  it("returns null for a missing property rather than throwing", () => {
    expect(val("metadata.nothing", ctx())).toBeNull();
    expect(val("metadata.a.b.c", ctx())).toBeNull();
  });

  it("exposes string length", () => {
    expect(val('"hello".length', ctx())).toBe(5);
  });
});

describe("builtins", () => {
  it("does string checks", () => {
    expect(run('contains(output, "answer")')).toBe(1);
    expect(run('contains(lower(output), "ANSWER")')).toBe(0);
    expect(run('contains(lower(output), "answer")')).toBe(1);
    expect(run('startsWith(output, "The")')).toBe(1);
    expect(run('endsWith(output, "4.")')).toBe(1);
    expect(val('len(words("a b  c"))', ctx())).toBe(3);
  });

  it("does regex matching", () => {
    expect(run('matches(output, "answer is [0-9]+")')).toBe(1);
    expect(run('matches(output, "^[A-Z]{3}-[0-9]{4}$")')).toBe(0);
  });

  it("does structural equality, not reference equality", () => {
    const c = ctx({ output: { a: 1, b: [2, 3] }, expected: { b: [2, 3], a: 1 } });
    expect(run("exactMatch(output, expected)", c)).toBe(1);
  });

  it("parses and paths into JSON", () => {
    const c = ctx({ output: '{"status":"ok","items":[{"id":"x"}]}' });
    expect(run("jsonValid(output)", c)).toBe(1);
    expect(run('jsonPath(jsonParse(output), "$.status") == "ok"', c)).toBe(1);
    expect(val('jsonPath(jsonParse(output), "$.items[0].id")', c)).toBe("x");
    expect(val('jsonPath(jsonParse(output), "$.missing")', c)).toBeNull();
  });

  it("reports invalid JSON without throwing", () => {
    const c = ctx({ output: "{not json" });
    expect(run("jsonValid(output)", c)).toBe(0);
    expect(val("jsonParse(output)", c)).toBeNull();
  });

  it("does numeric helpers and has()", () => {
    expect(val('num("3.5")', ctx())).toBe(3.5);
    expect(val('num("abc")', ctx())).toBeNull();
    expect(val("min(2, 5) + max(2, 5)", ctx())).toBe(7);
    expect(run('has(metadata, "k")', ctx({ metadata: { k: 1 } }))).toBe(1);
    expect(run('has(metadata, "k")')).toBe(0);
  });

  it("guards has() before member access without evaluating the right side", () => {
    expect(run('has(metadata, "score") and metadata.score > 0.5')).toBe(0);
    expect(run('has(metadata, "score") and metadata.score > 0.5', ctx({ metadata: { score: 0.9 } }))).toBe(1);
  });
});

describe("score coercion", () => {
  it("maps booleans to 1 and 0", () => {
    expect(runExpression("true", ctx())).toEqual({ score: 1, value: true });
    expect(runExpression("false", ctx())).toEqual({ score: 0, value: false });
  });

  it("passes through an in-range number", () => {
    expect(run("0.75")).toBe(0.75);
  });

  it("rejects an out-of-range number instead of clamping it", () => {
    // Clamping would turn an authoring mistake into a plausible-looking score.
    expect(() => run("42")).toThrow(/score must be a number in \[0, 1\]/);
    expect(() => run("0 - 1")).toThrow(/score must be a number in \[0, 1\]/);
  });

  it("rejects a non-numeric, non-boolean result", () => {
    expect(() => run('"hello"')).toThrow(/score must be a number/);
    expect(() => run("metadata")).toThrow(/score must be a number/);
    expect(() => run("metadata.nope")).toThrow(/null/);
  });
});

describe("safety", () => {
  it("refuses names that are not bound variables", () => {
    expect(() => compileExpression("globalThis")).toThrow(/unknown name/);
    expect(() => compileExpression("process.env")).toThrow(/unknown name/);
    expect(() => compileExpression("require")).toThrow(/unknown name/);
    expect(() => compileExpression("fetch")).toThrow(/unknown name/);
  });

  it("refuses unknown function calls", () => {
    expect(() => compileExpression("eval('1')")).toThrow(/unknown function/);
    expect(() => compileExpression("Function('return 1')")).toThrow(/unknown function/);
  });

  it("has no callable values, so method calls are unparseable", () => {
    // There is no way to reach a host function through a value.
    expect(() => compileExpression("output.constructor()")).toThrow();
    expect(() => compileExpression("output.toString()")).toThrow();
  });

  it("blocks prototype-chain property names", () => {
    expect(() => run("output.__proto__")).toThrow(/not allowed/);
    expect(() => run("output.constructor")).toThrow(/not allowed/);
    expect(() => run("output.prototype")).toThrow(/not allowed/);
    expect(() => run('output["constructor"]')).toThrow(/not allowed/);
  });

  it("does not expose inherited properties", () => {
    // hasOwn-gated: only data actually present in the JSON is readable.
    expect(val("metadata.toString", ctx())).toBeNull();
    expect(val("metadata.hasOwnProperty", ctx())).toBeNull();
  });

  it("rejects a regex with nested repetition (ReDoS)", () => {
    // A user-authored evaluator runs in the shared ingest worker; a backtracking pattern
    // there would be a cross-tenant hazard.
    expect(() => run('matches(output, "(a+)+$")')).toThrow(/catastrophic backtracking/);
    expect(() => run('matches(output, "([a-z]*)*!")')).toThrow(/catastrophic backtracking/);
  });

  it("rejects an invalid regex", () => {
    expect(() => run('matches(output, "(unclosed")')).toThrow(/invalid regex/);
  });

  it("caps expression length and nesting depth", () => {
    expect(() => compileExpression("1".repeat(MAX_EXPRESSION_LENGTH + 1))).toThrow(/longer than/);
    expect(() => compileExpression(`${"(".repeat(200)}1${")".repeat(200)}`)).toThrow(/nested too deeply/);
  });

  it("rejects an empty expression", () => {
    expect(() => compileExpression("   ")).toThrow(/empty/);
  });

  it("reports syntax errors with a position", () => {
    expect(() => compileExpression("1 +")).toThrow(ExprError);
    expect(() => compileExpression('output == "unterminated')).toThrow(/unterminated string/);
    expect(() => compileExpression("1 1")).toThrow(/unexpected/);
    expect(() => compileExpression("output @ 1")).toThrow(/unexpected character/);
  });

  it("terminates: the language has no loops or recursion to run away with", () => {
    // The only unbounded cost is nesting, which the depth and step budgets bound.
    const deep = Array.from({ length: 60 }, (_, i) => `${i} < 100`).join(" and ");
    expect(run(deep)).toBe(1);
  });
});

describe("realistic checks", () => {
  it("length ceiling", () => {
    expect(run("len(output) < 500")).toBe(1);
    expect(run("len(output) < 5")).toBe(0);
  });

  it("refusal detector", () => {
    expect(run('contains(lower(output), "i cannot") ? 0 : 1')).toBe(1);
    expect(run('contains(lower(output), "i cannot") ? 0 : 1', ctx({ output: "I cannot help with that." }))).toBe(0);
  });

  it("structured-output contract", () => {
    const good = ctx({ output: '{"status":"ok","id":"ABC-1234"}' });
    const bad = ctx({ output: '{"status":"error"}' });
    const check =
      'jsonValid(output) and jsonPath(jsonParse(output), "$.status") == "ok" ' +
      'and matches(jsonPath(jsonParse(output), "$.id"), "^[A-Z]{3}-[0-9]{4}$")';
    expect(run(check, good)).toBe(1);
    expect(run(check, bad)).toBe(0);
  });

  it("graded score rather than pass/fail", () => {
    const c = ctx({ output: "one two three four", expected: "one two" });
    expect(val("min(1, len(words(output)) / 8)", c)).toBe(0.5);
  });
});
