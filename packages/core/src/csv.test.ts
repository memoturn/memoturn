import { describe, expect, it } from "vitest";
import { cellValue, parseCsv } from "./csv.js";

describe("parseCsv", () => {
  it("parses a plain file into header-keyed records", () => {
    const { headers, rows } = parseCsv("question,answer\nwhy?,because\nhow?,like this\n");
    expect(headers).toEqual(["question", "answer"]);
    expect(rows).toEqual([
      { question: "why?", answer: "because" },
      { question: "how?", answer: "like this" },
    ]);
  });

  it("keeps a comma inside a quoted field", () => {
    const { rows } = parseCsv('a,b\n"one, two",three\n');
    expect(rows[0]).toEqual({ a: "one, two", b: "three" });
  });

  it("keeps a newline inside a quoted field", () => {
    const { rows } = parseCsv('a,b\n"line one\nline two",x\n');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.a).toBe("line one\nline two");
  });

  it("unescapes a doubled quote", () => {
    const { rows } = parseCsv('a\n"she said ""hi"""\n');
    expect(rows[0]!.a).toBe('she said "hi"');
  });

  it("handles CRLF and a missing trailing newline", () => {
    const { rows } = parseCsv("a,b\r\n1,2\r\n3,4");
    expect(rows).toEqual([
      { a: "1", b: "2" },
      { a: "3", b: "4" },
    ]);
  });

  it("pads a short row rather than shifting columns", () => {
    const { rows } = parseCsv("a,b,c\n1,2\n");
    expect(rows[0]).toEqual({ a: "1", b: "2", c: "" });
  });

  it("strips a UTF-8 BOM so the first header isn't corrupted", () => {
    const { headers } = parseCsv("﻿question,answer\nq,a\n");
    expect(headers[0]).toBe("question");
  });

  it("ignores blank lines between records", () => {
    const { rows } = parseCsv("a\n1\n\n2\n");
    expect(rows).toEqual([{ a: "1" }, { a: "2" }]);
  });

  it("rejects a file with no header row or a duplicate column", () => {
    expect(() => parseCsv("")).toThrow(/no header row/);
    expect(() => parseCsv("a,b,a\n1,2,3\n")).toThrow(/duplicate CSV column: a/);
  });
});

describe("cellValue", () => {
  it("parses object and array cells as JSON", () => {
    expect(cellValue('{"a":1}')).toEqual({ a: 1 });
    expect(cellValue("[1,2]")).toEqual([1, 2]);
  });

  it("leaves scalars as strings so ids and order numbers keep their form", () => {
    expect(cellValue("123")).toBe("123");
    expect(cellValue("true")).toBe("true");
    expect(cellValue("plain text")).toBe("plain text");
  });

  it("falls back to the raw string when JSON-looking content doesn't parse", () => {
    expect(cellValue("{not json")).toBe("{not json");
  });
});
