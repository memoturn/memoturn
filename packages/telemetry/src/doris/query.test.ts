import type { AnalyticsQuery } from "@memoturn/contracts";
import { describe, expect, it } from "vitest";
import { compileQuery, validateQuery } from "./query.js";

const base = (over: Partial<AnalyticsQuery>): AnalyticsQuery => ({
  view: "observations",
  metrics: [{ measure: "count", aggregation: "count" }],
  dimensions: [],
  filters: [],
  timeDimension: null,
  fromTimestamp: "2026-07-01T00:00:00Z",
  toTimestamp: "2026-07-16T00:00:00Z",
  orderBy: [],
  rowLimit: 100,
  ...over,
});

describe("validateQuery", () => {
  it("accepts a well-formed query", () => {
    expect(validateQuery(base({})).ok).toBe(true);
  });
  it("rejects an unknown view", () => {
    expect(validateQuery(base({ view: "nope" as AnalyticsQuery["view"] })).ok).toBe(false);
  });
  it("rejects an unknown measure", () => {
    expect(validateQuery(base({ metrics: [{ measure: "nope", aggregation: "sum" }] })).ok).toBe(false);
  });
  it("rejects an unknown dimension", () => {
    expect(validateQuery(base({ dimensions: [{ field: "nope" }] })).ok).toBe(false);
  });
  it("rejects sum over a non-numeric measure (count)", () => {
    expect(validateQuery(base({ metrics: [{ measure: "count", aggregation: "sum" }] })).ok).toBe(false);
  });
  it("rejects a high-cardinality dimension in a time series", () => {
    const v = validateQuery(base({ dimensions: [{ field: "name" }], timeDimension: { granularity: "day" } }));
    expect(v.ok).toBe(false);
    expect(v.error).toContain("time series");
  });
  it("rejects a high-cardinality dimension without an orderBy (unbounded)", () => {
    expect(validateQuery(base({ dimensions: [{ field: "name" }] })).ok).toBe(false);
  });
  it("accepts a high-cardinality dimension when bounded by orderBy", () => {
    const q = base({ dimensions: [{ field: "name" }], orderBy: [{ field: "count_count", direction: "desc" }] });
    expect(validateQuery(q).ok).toBe(true);
  });
});

describe("compileQuery", () => {
  it("count by day → time bucket + group + default time order", () => {
    const { sql, params } = compileQuery("p1", base({ timeDimension: { granularity: "day" } }));
    expect(sql).toContain("DATE_TRUNC(o.start_time, 'day')");
    expect(sql).toContain("COUNT(*) AS `count_count`");
    expect(sql).toContain("GROUP BY DATE_FORMAT(DATE_TRUNC(o.start_time, 'day'), '%Y-%m-%dT%H:%i:%s')");
    expect(sql).toContain("ORDER BY `time` ASC");
    expect(params).toEqual(["p1", "2026-07-01T00:00:00Z", "2026-07-16T00:00:00Z"]);
  });

  it("sum cost by model → aggregate + dimension group", () => {
    const { sql } = compileQuery(
      "p1",
      base({ metrics: [{ measure: "cost", aggregation: "sum" }], dimensions: [{ field: "model" }] }),
    );
    expect(sql).toContain("SUM(o.total_cost) AS `sum_cost`");
    expect(sql).toContain("o.model AS `model`");
    expect(sql).toContain("GROUP BY o.model");
  });

  it("percentile aggregation uses PERCENTILE_APPROX", () => {
    const { sql } = compileQuery("p1", base({ metrics: [{ measure: "latency", aggregation: "p95" }] }));
    expect(sql).toContain("PERCENTILE_APPROX(o.latency_ms, 0.95) AS `p95_latency`");
  });

  it("scopes by project + time range and applies dimension filters", () => {
    const { sql, params } = compileQuery(
      "p1",
      base({
        dimensions: [{ field: "model" }],
        filters: [{ type: "stringOptions", column: "level", operator: "any_of", value: ["ERROR"] }],
      }),
    );
    expect(sql).toContain("o.project_id = ?");
    expect(sql).toContain("o.start_time >= ?");
    expect(sql).toContain("o.start_time < ?");
    expect(sql).toContain("o.level IN (?)");
    expect(params).toEqual(["p1", "2026-07-01T00:00:00Z", "2026-07-16T00:00:00Z", "ERROR"]);
  });

  it("orders by a metric alias and honors rowLimit", () => {
    const { sql } = compileQuery(
      "p1",
      base({
        view: "traces",
        dimensions: [{ field: "userId" }],
        metrics: [{ measure: "count", aggregation: "count" }],
        orderBy: [{ field: "count_count", direction: "desc" }],
        rowLimit: 20,
      }),
    );
    expect(sql).toContain("FROM traces t");
    expect(sql).toContain("ORDER BY `count_count` DESC");
    expect(sql).toContain("LIMIT 20");
  });

  it("scores view — avg value", () => {
    const { sql } = compileQuery(
      "p1",
      base({ view: "scores", metrics: [{ measure: "value", aggregation: "avg" }], dimensions: [{ field: "name" }] }),
    );
    expect(sql).toContain("FROM scores s");
    expect(sql).toContain("AVG(s.`value`) AS `avg_value`");
  });
});
