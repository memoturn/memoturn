import { describe, expect, it } from "vitest";
import { isFatalConnectionError, rewritePlaceholders, SqlArray } from "./client.js";

describe("rewritePlaceholders", () => {
  it("rewrites ? to $n in order", () => {
    const { text, values } = rewritePlaceholders("SELECT * FROM t WHERE a = ? AND b = ?", ["x", 2]);
    expect(text).toBe("SELECT * FROM t WHERE a = $1 AND b = $2");
    expect(values).toEqual(["x", 2]);
  });

  it("expands plain-array params like mysql2 IN (?)", () => {
    const { text, values } = rewritePlaceholders("WHERE project_id = ? AND id IN (?)", ["p", ["a", "b", "c"]]);
    expect(text).toBe("WHERE project_id = $1 AND id IN (($2, $3, $4))");
    expect(values).toEqual(["p", "a", "b", "c"]);
  });

  it("passes SqlArray through as a single array param (column value, not IN-list)", () => {
    const { text, values } = rewritePlaceholders("INSERT INTO t (tags) VALUES (?)", [new SqlArray(["a", "b"])]);
    expect(text).toBe("INSERT INTO t (tags) VALUES ($1)");
    expect(values).toEqual([["a", "b"]]);
  });

  it("ignores ? inside string literals (including '' escapes)", () => {
    const { text, values } = rewritePlaceholders("SELECT 'lit?eral', 'a''b?c', col FROM t WHERE x = ?", [1]);
    expect(text).toBe("SELECT 'lit?eral', 'a''b?c', col FROM t WHERE x = $1");
    expect(values).toEqual([1]);
  });

  it("ignores ? inside -- line comments", () => {
    const { text } = rewritePlaceholders("SELECT col -- what?\nFROM t WHERE x = ?", [1]);
    expect(text).toBe("SELECT col -- what?\nFROM t WHERE x = $1");
  });

  it("throws on empty array bound to IN (?)", () => {
    expect(() => rewritePlaceholders("WHERE id IN (?)", [[]])).toThrow(/empty array/);
  });

  it("throws on placeholder/param count mismatch in both directions", () => {
    expect(() => rewritePlaceholders("WHERE a = ? AND b = ?", [1])).toThrow(/exceeds params/);
    expect(() => rewritePlaceholders("WHERE a = ?", [1, 2])).toThrow(/exceed placeholders/);
  });
});

describe("isFatalConnectionError", () => {
  it("matches socket-level and PG shutdown errors", () => {
    expect(isFatalConnectionError({ code: "ECONNRESET" })).toBe(true);
    expect(isFatalConnectionError({ code: "57P01" })).toBe(true);
    expect(isFatalConnectionError({ code: "08006" })).toBe(true);
    expect(isFatalConnectionError({ message: "Connection terminated unexpectedly" })).toBe(true);
  });

  it("does not match query errors", () => {
    expect(isFatalConnectionError({ code: "23505", message: "duplicate key value" })).toBe(false);
    expect(isFatalConnectionError(null)).toBe(false);
  });
});
