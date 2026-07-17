import type { SingleFilter } from "@memoturn/contracts";
import { describe, expect, it } from "vitest";
import { buildTraceFilterSql } from "./filters.js";

const PID = "proj_1";
const one = (f: SingleFilter) => buildTraceFilterSql(PID, [f]);

describe("buildTraceFilterSql", () => {
  it("direct trace column — string contains", () => {
    const { conds, params } = one({ type: "string", column: "userId", operator: "contains", value: "ana" });
    expect(conds).toEqual(["t.user_id LIKE CONCAT('%', ?, '%')"]);
    expect(params).toEqual(["ana"]);
  });

  it("string operators map to the right SQL", () => {
    expect(one({ type: "string", column: "version", operator: "eq", value: "1" }).conds[0]).toBe("t.version = ?");
    expect(one({ type: "string", column: "version", operator: "starts_with", value: "v" }).conds[0]).toBe(
      "t.version LIKE CONCAT(?, '%')",
    );
    expect(one({ type: "string", column: "version", operator: "ends_with", value: "x" }).conds[0]).toBe(
      "t.version LIKE CONCAT('%', ?)",
    );
    expect(one({ type: "string", column: "version", operator: "not_contains", value: "x" }).conds[0]).toBe(
      "t.version NOT LIKE CONCAT('%', ?, '%')",
    );
  });

  it("stringOptions — any_of / none_of expand to IN / NOT IN with per-element placeholders", () => {
    const anyOf = one({ type: "stringOptions", column: "environment", operator: "any_of", value: ["prod", "dev"] });
    expect(anyOf.conds).toEqual(["t.environment IN (?, ?)"]);
    expect(anyOf.params).toEqual(["prod", "dev"]);
    const noneOf = one({ type: "stringOptions", column: "environment", operator: "none_of", value: ["prod"] });
    expect(noneOf.conds).toEqual(["t.environment NOT IN (?)"]);
  });

  it("arrayOptions (tags) — per-element array_contains, no ARRAY-literal binding", () => {
    const anyOf = one({ type: "arrayOptions", column: "tags", operator: "any_of", value: ["a", "b"] });
    expect(anyOf.conds).toEqual(["(array_contains(t.tags, ?) OR array_contains(t.tags, ?))"]);
    expect(anyOf.params).toEqual(["a", "b"]);
    expect(one({ type: "arrayOptions", column: "tags", operator: "all_of", value: ["a", "b"] }).conds[0]).toBe(
      "(array_contains(t.tags, ?) AND array_contains(t.tags, ?))",
    );
    expect(one({ type: "arrayOptions", column: "tags", operator: "none_of", value: ["a"] }).conds[0]).toBe(
      "NOT (array_contains(t.tags, ?))",
    );
  });

  it("metadata stringObject — JSON key access with sanitized path + bound value", () => {
    const { conds, params } = one({
      type: "stringObject",
      column: "metadata",
      key: "user_intent",
      operator: "eq",
      value: "question",
    });
    expect(conds).toEqual(["get_json_string(t.metadata, '$.user_intent') = ?"]);
    expect(params).toEqual(["question"]);
  });

  it("metadata numberObject — casts to DOUBLE", () => {
    const { conds, params } = one({
      type: "numberObject",
      column: "metadata",
      key: "retries",
      operator: "gt",
      value: 2,
    });
    expect(conds).toEqual(["CAST(get_json_string(t.metadata, '$.retries') AS DOUBLE) > ?"]);
    expect(params).toEqual([2]);
  });

  it("metadata key is sanitized to a JSON-path-safe segment (no injection)", () => {
    const { conds } = one({
      type: "stringObject",
      column: "metadata",
      key: "a'; DROP--",
      operator: "eq",
      value: "x",
    });
    expect(conds[0]).toBe("get_json_string(t.metadata, '$.aDROP--') = ?");
  });

  it("observation column (type) — EXISTS-style subquery with project scoping", () => {
    const { conds, params } = one({
      type: "stringOptions",
      column: "type",
      operator: "any_of",
      value: ["TOOL", "AGENT"],
    });
    expect(conds).toEqual(["t.id IN (SELECT trace_id FROM observations WHERE project_id = ? AND type IN (?, ?))"]);
    expect(params).toEqual([PID, "TOOL", "AGENT"]);
  });

  it("per-trace aggregate metric — HAVING subquery (cost SUM, latency MAX)", () => {
    const cost = one({ type: "number", column: "cost", operator: "gt", value: 0.5 });
    expect(cost.conds).toEqual([
      "t.id IN (SELECT trace_id FROM observations WHERE project_id = ? GROUP BY trace_id HAVING SUM(total_cost) > ?)",
    ]);
    expect(cost.params).toEqual([PID, 0.5]);
    const lat = one({ type: "number", column: "latencyMs", operator: "gte", value: 1000 });
    expect(lat.conds[0]).toContain("HAVING MAX(latency_ms) >= ?");
  });

  it("null operator — empty-equals-null nicety", () => {
    expect(one({ type: "null", column: "userId", operator: "is_null" }).conds[0]).toBe(
      "(t.user_id IS NULL OR t.user_id = '')",
    );
    expect(one({ type: "null", column: "userId", operator: "is_not_null" }).conds[0]).toBe(
      "(t.user_id IS NOT NULL AND t.user_id != '')",
    );
  });

  it("datetime — comparison operator over the timestamp column", () => {
    const { conds } = one({ type: "datetime", column: "timestamp", operator: "gte", value: "2026-07-01T00:00:00Z" });
    expect(conds[0]).toBe("t.`timestamp` >= ?");
  });

  it("unknown column is skipped, not thrown", () => {
    expect(one({ type: "string", column: "nope", operator: "eq", value: "x" }).conds).toEqual([]);
  });

  it("combines multiple filters, concatenating params in order", () => {
    const { conds, params } = buildTraceFilterSql(PID, [
      { type: "string", column: "userId", operator: "eq", value: "u1" },
      { type: "number", column: "tokens", operator: "lt", value: 100 },
    ]);
    expect(conds).toHaveLength(2);
    expect(params).toEqual(["u1", PID, 100]);
  });

  it("empty options value is a no-op (matches everything)", () => {
    expect(one({ type: "stringOptions", column: "environment", operator: "any_of", value: [] }).conds).toEqual(["1=1"]);
  });
});
