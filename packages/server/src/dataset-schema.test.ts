import { describe, expect, it } from "vitest";
import {
  csvToItems,
  type DatasetItemSchema,
  isEmptySchema,
  parseItemSchema,
  validateItem,
  validateSchemaShape,
} from "./dataset-schema.js";

const schema: DatasetItemSchema = {
  input: {
    required: ["question"],
    properties: {
      question: { type: "string" },
      difficulty: { type: "string", enum: ["easy", "hard"] },
      retries: { type: "number" },
    },
  },
  expectedOutput: { type: "string" },
};

describe("parseItemSchema", () => {
  it("treats a missing or malformed column as no constraint at all", () => {
    expect(isEmptySchema(parseItemSchema(null))).toBe(true);
    expect(isEmptySchema(parseItemSchema("nonsense"))).toBe(true);
    expect(isEmptySchema(parseItemSchema([1, 2]))).toBe(true);
    expect(isEmptySchema(parseItemSchema({}))).toBe(true);
    expect(isEmptySchema(parseItemSchema({ input: { type: "object" } }))).toBe(false);
  });
});

describe("validateSchemaShape", () => {
  it("accepts a well-formed schema", () => {
    expect(validateSchemaShape(schema)).toEqual([]);
  });

  it("rejects an unknown type, an empty enum, and a required field that isn't declared", () => {
    expect(validateSchemaShape({ input: { properties: { a: { type: "date" as never } } } })).toEqual([
      'input.a.type: unknown type "date"',
    ]);
    expect(validateSchemaShape({ input: { properties: { a: { enum: [] } } } })).toEqual([
      "input.a.enum: must be a non-empty list",
    ]);
    // Catches the typo case: `required: ["quesiton"]` next to `properties: { question }`.
    expect(
      validateSchemaShape({ input: { required: ["quesiton"], properties: { question: { type: "string" } } } }),
    ).toEqual(['input.required: "quesiton" is required but not declared in properties']);
  });
});

describe("validateItem", () => {
  it("accepts a conforming item", () => {
    expect(
      validateItem(schema, { input: { question: "why?", difficulty: "easy" }, expectedOutput: "because" }, 0),
    ).toEqual([]);
  });

  it("reports the field, not just the item", () => {
    const errors = validateItem(schema, { input: { difficulty: "medium", retries: "two" } }, 3);
    expect(errors).toEqual([
      { index: 3, field: "input.question", message: "required" },
      { index: 3, field: "input.difficulty", message: "must be one of: easy, hard" },
      { index: 3, field: "input.retries", message: "expected number, got string" },
    ]);
  });

  it("treats an empty string as missing for a required field", () => {
    expect(validateItem(schema, { input: { question: "" } }, 0)).toEqual([
      { index: 0, field: "input.question", message: "required" },
    ]);
  });

  it("reports a whole part whose type is wrong, without piling on field errors", () => {
    expect(validateItem(schema, { input: "a bare string" }, 0)).toEqual([
      { index: 0, field: "input", message: "expected object, got string" },
    ]);
  });

  it("only complains about an absent part when the schema requires fields in it", () => {
    // expectedOutput is typed but not required → absence is fine.
    expect(validateItem(schema, { input: { question: "q" } }, 0)).toEqual([]);
    // input requires `question` → absence of the whole part is an error.
    expect(validateItem(schema, { input: undefined }, 0)).toEqual([
      { index: 0, field: "input", message: "input is required" },
    ]);
  });

  it("ignores undeclared fields — a schema is a floor, not a straitjacket", () => {
    expect(validateItem(schema, { input: { question: "q", extra: 42 } }, 0)).toEqual([]);
  });
});

describe("csvToItems", () => {
  const csv = "question,answer,difficulty\nwhy?,because,easy\nhow?,like this,hard\n";

  it("maps one column to a scalar input", () => {
    const { items } = csvToItems(csv, { input: "question", expectedOutput: "answer" });
    expect(items).toEqual([
      { input: "why?", expectedOutput: "because", metadata: undefined },
      { input: "how?", expectedOutput: "like this", metadata: undefined },
    ]);
  });

  it("maps several columns to an object input, with metadata alongside", () => {
    const { items } = csvToItems(csv, {
      input: ["question", "difficulty"],
      expectedOutput: "answer",
      metadata: ["difficulty"],
    });
    expect(items[0]).toEqual({
      input: { question: "why?", difficulty: "easy" },
      expectedOutput: "because",
      metadata: { difficulty: "easy" },
    });
  });

  it("parses a JSON cell but leaves scalars as text", () => {
    const { items } = csvToItems('payload,n\n"{""a"":1}",42\n', { input: "payload", metadata: ["n"] });
    expect(items[0]!.input).toEqual({ a: 1 });
    expect(items[0]!.metadata).toEqual({ n: "42" });
  });

  it("skips a blank row and says which one", () => {
    const { items, errors } = csvToItems("question,answer\n,nothing\nreal,yes\n", {
      input: "question",
      expectedOutput: "answer",
    });
    expect(items).toHaveLength(1);
    expect(errors).toEqual([{ index: 0, field: "input", message: "row has no input value" }]);
  });

  it("fails the whole import when the mapping names a column that isn't there", () => {
    // A wrong mapping is not a per-row problem — importing half a file under it is worse.
    expect(() => csvToItems(csv, { input: "prompt" })).toThrow(/no column named: prompt/);
    expect(() => csvToItems(csv, { input: "question", metadata: ["nope"] })).toThrow(/no column named: nope/);
  });

  it("ignores columns the mapping doesn't mention", () => {
    const { items } = csvToItems(csv, { input: "question" });
    expect(items[0]).toEqual({ input: "why?", expectedOutput: undefined, metadata: undefined });
  });
});
