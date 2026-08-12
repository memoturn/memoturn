import { describe, expect, it } from "vitest";
import {
  composePrompt,
  extractPlaceholders,
  extractPromptRefs,
  fillPrompt,
  MAX_COMPOSITION_DEPTH,
  PromptCompositionError,
  type PromptRef,
  validatePromptBody,
} from "./prompt-composition.js";

const ref = (name: string, label = "production") => `@@@memoturnPrompt:name=${name}|label=${label}@@@`;

/** A registry stub: name → TEXT body (which may itself contain references). */
const registry = (bodies: Record<string, string>, types: Record<string, "TEXT" | "CHAT"> = {}) => {
  return async (r: PromptRef) => {
    const body = bodies[r.name];
    if (body === undefined) return null;
    return { type: types[r.name] ?? ("TEXT" as const), content: body };
  };
};

describe("extractPromptRefs", () => {
  it("finds label and version references in text and in chat messages", () => {
    expect(extractPromptRefs(`hello ${ref("preamble")} world`)).toEqual([{ name: "preamble", label: "production" }]);
    expect(extractPromptRefs("@@@memoturnPrompt:name=pinned|version=3@@@")).toEqual([{ name: "pinned", version: 3 }]);
    expect(
      extractPromptRefs([
        { role: "system", content: ref("a") },
        { role: "user", content: "no refs here" },
        { role: "assistant", content: ref("b", "staging") },
      ]),
    ).toEqual([
      { name: "a", label: "production" },
      { name: "b", label: "staging" },
    ]);
  });

  it("ignores a malformed reference rather than half-matching it", () => {
    expect(extractPromptRefs("@@@memoturnPrompt:name=|label=x@@@")).toEqual([]);
    expect(extractPromptRefs("@@@memoturnPrompt:name=a|version=0@@@")).toEqual([]);
  });
});

describe("validatePromptBody", () => {
  it("accepts a chat prompt with a named placeholder", () => {
    expect(() =>
      validatePromptBody(
        [
          { role: "system", content: "hi" },
          { type: "placeholder", name: "history" },
        ],
        "CHAT",
      ),
    ).not.toThrow();
  });

  it("rejects an unnamed or duplicated placeholder", () => {
    expect(() => validatePromptBody([{ type: "placeholder" }], "CHAT")).toThrow(/no name/);
    expect(() =>
      validatePromptBody(
        [
          { type: "placeholder", name: "history" },
          { type: "placeholder", name: "history" },
        ],
        "CHAT",
      ),
    ).toThrow(/duplicate placeholder/);
  });

  it("rejects a message with no role and the wrong content type per prompt kind", () => {
    expect(() => validatePromptBody([{ content: "orphan" }], "CHAT")).toThrow(/needs a role/);
    expect(() => validatePromptBody("a string", "CHAT")).toThrow(/message array/);
    expect(() => validatePromptBody([{ role: "user", content: "x" }], "TEXT")).toThrow(/must be a string/);
  });

  it("catches a near-miss reference instead of leaving it as literal text", () => {
    expect(() => validatePromptBody("@@@memoturnPrompt:name=oops@@@", "TEXT")).toThrow(/malformed prompt reference/);
  });
});

describe("composePrompt", () => {
  it("splices a referenced prompt into text", async () => {
    const out = await composePrompt(`Rules: ${ref("safety")}\nGo.`, registry({ safety: "Be careful." }));
    expect(out).toBe("Rules: Be careful.\nGo.");
  });

  it("resolves nested references depth-first", async () => {
    const out = await composePrompt(ref("outer"), registry({ outer: `A ${ref("inner")} C`, inner: "B" }));
    expect(out).toBe("A B C");
  });

  it("composes inside each chat message, leaving other fields alone", async () => {
    const out = (await composePrompt(
      [
        { role: "system", content: ref("safety") },
        { type: "placeholder", name: "history" },
        { role: "user", content: "{{question}}" },
      ],
      registry({ safety: "Be careful." }),
    )) as Record<string, unknown>[];
    expect(out[0]).toEqual({ role: "system", content: "Be careful." });
    // A placeholder passes through composition untouched — it is filled later, by the caller.
    expect(out[1]).toEqual({ type: "placeholder", name: "history" });
    expect(out[2]).toEqual({ role: "user", content: "{{question}}" });
  });

  it("refuses a direct cycle and names the path", async () => {
    await expect(composePrompt(ref("a"), registry({ a: ref("a") }))).rejects.toThrow(/circular prompt reference/);
  });

  it("refuses an indirect cycle", async () => {
    await expect(composePrompt(ref("a"), registry({ a: ref("b"), b: ref("c"), c: ref("a") }))).rejects.toThrow(
      /circular prompt reference/,
    );
  });

  it("caps runaway nesting even when nothing repeats", async () => {
    const bodies: Record<string, string> = {};
    for (let i = 0; i < MAX_COMPOSITION_DEPTH + 3; i++) bodies[`p${i}`] = ref(`p${i + 1}`);
    bodies[`p${MAX_COMPOSITION_DEPTH + 3}`] = "end";
    await expect(composePrompt(ref("p0"), registry(bodies))).rejects.toThrow(/nested deeper than/);
  });

  it("reports a missing target and a CHAT target by name", async () => {
    await expect(composePrompt(ref("ghost"), registry({}))).rejects.toThrow(/not found: ghost@production/);
    await expect(composePrompt(ref("chatty"), registry({ chatty: "[]" }, { chatty: "CHAT" }))).rejects.toThrow(
      /cannot be embedded in text/,
    );
  });

  it("leaves a body with no references untouched", async () => {
    const body = [{ role: "user", content: "plain" }];
    expect(await composePrompt(body, registry({}))).toEqual(body);
  });
});

describe("fillPrompt", () => {
  const body = [
    { role: "system", content: "You are {{persona}}." },
    { type: "placeholder", name: "history" },
    { role: "user", content: "{{question}}" },
  ];

  it("splices a message list into its slot and substitutes variables everywhere", () => {
    const out = fillPrompt(body, {
      variables: { persona: "terse", question: "why?" },
      placeholders: {
        history: [
          { role: "user", content: "earlier {{question}}" },
          { role: "assistant", content: "earlier answer" },
        ],
      },
    }) as Record<string, unknown>[];
    expect(out).toEqual([
      { role: "system", content: "You are terse." },
      { role: "user", content: "earlier why?" },
      { role: "assistant", content: "earlier answer" },
      { role: "user", content: "why?" },
    ]);
  });

  it("drops an unfilled slot instead of shipping a placeholder object to a provider", () => {
    const out = fillPrompt(body, { variables: { persona: "terse", question: "q" } }) as Record<string, unknown>[];
    expect(out).toHaveLength(2);
    expect(out.some((m) => m.type === "placeholder")).toBe(false);
  });

  it("leaves an unknown variable visible rather than blanking it", () => {
    expect(fillPrompt("Hi {{name}}, {{missing}}", { variables: { name: "Ada" } })).toBe("Hi Ada, {{missing}}");
  });

  it("renders a null variable as empty and a non-string as JSON", () => {
    expect(fillPrompt("[{{a}}][{{b}}]", { variables: { a: null, b: { x: 1 } } })).toBe('[][{"x":1}]');
  });
});

describe("extractPlaceholders", () => {
  it("lists slot names in order, ignoring ordinary messages", () => {
    expect(
      extractPlaceholders([
        { role: "system", content: "s" },
        { type: "placeholder", name: "history" },
        { type: "placeholder", name: "examples" },
      ]),
    ).toEqual(["history", "examples"]);
    expect(extractPlaceholders("a text prompt")).toEqual([]);
  });
});

describe("PromptCompositionError", () => {
  it("is distinguishable so the API can map it to a 400/422 rather than a 500", () => {
    expect(new PromptCompositionError("x")).toBeInstanceOf(Error);
    expect(new PromptCompositionError("x").name).toBe("PromptCompositionError");
  });
});
