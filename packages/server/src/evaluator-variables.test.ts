import type { EvaluatorVariableBinding } from "@memoturn/contracts";
import { describe, expect, it } from "vitest";
import { parseVariableMapping, renderPrompt, resolveVariables } from "./evaluator-variables.js";

const bind = (over: Partial<EvaluatorVariableBinding>): EvaluatorVariableBinding => ({
  variable: "v",
  source: "trace.output",
  observationName: "",
  jsonPath: "",
  ...over,
});

const ctx = {
  trace: { input: '{"question":"why?"}', output: "the answer", metadata: '{"tenant":"acme"}' },
  observations: [
    { name: "retriever", output: '{"docs":[{"text":"doc A"},{"text":"doc B"}]}' },
    { name: "generate", output: "final" },
  ],
  dataset: { input: "item in", expectedOutput: "item expected" },
};

describe("parseVariableMapping", () => {
  it("keeps well-formed bindings and drops junk without throwing", () => {
    const parsed = parseVariableMapping([
      { variable: "answer", source: "trace.output" },
      { variable: "", source: "trace.output" }, // no name
      { variable: "x", source: "nonsense.field" }, // unknown source
      "not an object",
      null,
    ]);
    expect(parsed).toEqual([{ variable: "answer", source: "trace.output", observationName: "", jsonPath: "" }]);
  });

  it("treats a non-array column value as no mapping", () => {
    expect(parseVariableMapping(null)).toEqual([]);
    expect(parseVariableMapping({ variable: "a" })).toEqual([]);
  });
});

describe("resolveVariables", () => {
  it("reads trace, dataset, and named-observation sources", () => {
    const vars = resolveVariables(
      [
        bind({ variable: "answer", source: "trace.output" }),
        bind({ variable: "expected", source: "dataset.expectedOutput" }),
        bind({ variable: "context", source: "observation.output", observationName: "retriever" }),
      ],
      ctx,
    );
    expect(vars.answer).toBe("the answer");
    expect(vars.expected).toBe("item expected");
    // JSON-encoded payloads are parsed, so the judge sees structure rather than a quoted blob.
    expect(vars.context).toEqual({ docs: [{ text: "doc A" }, { text: "doc B" }] });
  });

  it("walks a dotted json path, including array indices", () => {
    const vars = resolveVariables(
      [
        bind({ variable: "q", source: "trace.input", jsonPath: "question" }),
        bind({
          variable: "first",
          source: "observation.output",
          observationName: "retriever",
          jsonPath: "docs.0.text",
        }),
      ],
      ctx,
    );
    expect(vars).toEqual({ q: "why?", first: "doc A" });
  });

  it("binds null instead of failing when a source is missing", () => {
    const vars = resolveVariables(
      [
        bind({ variable: "nope", source: "observation.output", observationName: "reranker" }),
        bind({ variable: "gone", source: "trace.output", jsonPath: "a.b.c" }),
        bind({ variable: "noData", source: "dataset.input" }),
      ],
      { trace: ctx.trace },
    );
    expect(vars).toEqual({ nope: null, gone: null, noData: null });
  });

  it("falls back to the first span when no observation name is given", () => {
    const vars = resolveVariables([bind({ variable: "c", source: "observation.output" })], ctx);
    expect(vars.c).toEqual({ docs: [{ text: "doc A" }, { text: "doc B" }] });
  });
});

describe("renderPrompt", () => {
  it("substitutes bound variables and JSON-encodes non-strings", () => {
    const out = renderPrompt("Q: {{q}}\nDocs: {{docs}}\nMissing: {{nope}}", {
      q: "why?",
      docs: [{ text: "a" }],
      empty: null,
    });
    expect(out).toBe('Q: why?\nDocs: [{"text":"a"}]\nMissing: {{nope}}');
  });

  it("renders a null-bound variable as empty, and tolerates spacing", () => {
    expect(renderPrompt("[{{ empty }}]", { empty: null })).toBe("[]");
  });
});
