import type { AnalyticsQuery, SingleFilter } from "@memoturn/contracts";
import { arrayPredicate, scalarPredicate } from "./filters.js";

/**
 * The dashboard/widget analytics engine. A `view-declaration registry` maps each view
 * (traces / observations / scores) to its base table, time column, and the SQL fragments for
 * its dimensions + measures. `compileQuery` assembles a parameterized Doris query from a
 * validated AnalyticsQuery: dimensions → SELECT/GROUP BY, metrics → agg(measureSql), the shared
 * filter model → WHERE (reusing the trace filter predicate helpers), plus time bucketing and a
 * bounded top-N. `validateQuery` blocks unbounded/high-cardinality shapes before we ever hit SQL.
 *
 * All identifiers (view/dimension/measure/aggregation/granularity) are resolved against the
 * registry or fixed enums — never interpolated from raw input; every value is a `?` parameter.
 */

interface Measure {
  sql: string; // column/expression the aggregation wraps ("*" ⇒ COUNT(*) only)
  numeric: boolean; // non-numeric measures allow only count/uniq
}

interface ViewDecl {
  from: string; // e.g. "observations o"
  timeColumn: string; // e.g. "o.start_time"
  projectCol: string;
  dimensions: Record<string, string>; // field → SQL expression
  measures: Record<string, Measure>;
  highCardinality: Set<string>; // dimension fields that must be bounded (top-N, never a time series)
}

const VIEWS: Record<string, ViewDecl> = {
  observations: {
    from: "observations o",
    timeColumn: "o.start_time",
    projectCol: "o.project_id",
    dimensions: {
      model: "o.model",
      type: "o.type",
      level: "o.level",
      environment: "o.environment",
      name: "o.name",
      provider: "o.provider",
    },
    measures: {
      count: { sql: "*", numeric: false },
      cost: { sql: "o.total_cost", numeric: true },
      tokens: { sql: "o.total_tokens", numeric: true },
      latency: { sql: "o.latency_ms", numeric: true },
    },
    highCardinality: new Set(["name"]),
  },
  traces: {
    from: "traces t",
    timeColumn: "t.`timestamp`",
    projectCol: "t.project_id",
    dimensions: {
      environment: "t.environment",
      name: "t.name",
      userId: "t.user_id",
      sessionId: "t.session_id",
    },
    measures: { count: { sql: "*", numeric: false } },
    highCardinality: new Set(["name", "userId", "sessionId"]),
  },
  scores: {
    from: "scores s",
    timeColumn: "s.`timestamp`",
    projectCol: "s.project_id",
    dimensions: { name: "s.name", source: "s.source", environment: "s.environment", dataType: "s.data_type" },
    measures: { count: { sql: "*", numeric: false }, value: { sql: "s.`value`", numeric: true } },
    highCardinality: new Set(),
  },
};

const PCT: Record<string, string> = { p50: "0.5", p75: "0.75", p90: "0.9", p95: "0.95", p99: "0.99" };

/** SQL for an aggregation over a measure. COUNT is always COUNT(*); percentiles use approx. */
function aggSql(agg: string, measure: Measure): string {
  if (agg === "count") return "COUNT(*)";
  const col = measure.sql;
  if (agg === "uniq") return `COUNT(DISTINCT ${col})`;
  if (agg in PCT) return `PERCENTILE_APPROX(${col}, ${PCT[agg]})`;
  return `${agg.toUpperCase()}(${col})`; // SUM/AVG/MIN/MAX
}

export interface QueryValidation {
  ok: boolean;
  error?: string;
}

/** Reject unknown fields and unbounded/high-cardinality shapes before compiling to SQL. */
export function validateQuery(query: AnalyticsQuery): QueryValidation {
  const view = VIEWS[query.view];
  if (!view) return { ok: false, error: `unknown view: ${query.view}` };

  for (const m of query.metrics) {
    const measure = view.measures[m.measure];
    if (!measure) return { ok: false, error: `unknown measure '${m.measure}' for view '${query.view}'` };
    if (!measure.numeric && m.aggregation !== "count" && m.aggregation !== "uniq") {
      return { ok: false, error: `measure '${m.measure}' supports only count/uniq` };
    }
  }
  for (const d of query.dimensions) {
    if (!view.dimensions[d.field])
      return { ok: false, error: `unknown dimension '${d.field}' for view '${query.view}'` };
  }

  const highCard = query.dimensions.filter((d) => view.highCardinality.has(d.field));
  if (highCard.length > 0 && query.timeDimension) {
    return { ok: false, error: `high-cardinality dimension '${highCard[0]?.field}' cannot be used in a time series` };
  }
  if (highCard.length > 0 && query.orderBy.length === 0) {
    return {
      ok: false,
      error: `high-cardinality dimension '${highCard[0]?.field}' requires an orderBy (bounded top-N)`,
    };
  }
  return { ok: true };
}

/** Compile filters that target this view's dimension columns (others are skipped). */
function compileFilters(view: ViewDecl, filters: SingleFilter[]): { conds: string[]; params: unknown[] } {
  const conds: string[] = [];
  const params: unknown[] = [];
  for (const f of filters) {
    const expr = view.dimensions[f.column];
    if (!expr) continue;
    const frag = f.type === "arrayOptions" ? arrayPredicate(expr, f) : scalarPredicate(expr, f);
    conds.push(frag.frag);
    params.push(...frag.params);
  }
  return { conds, params };
}

/** Compile a validated AnalyticsQuery into parameterized Doris SQL. */
export function compileQuery(projectId: string, query: AnalyticsQuery): { sql: string; params: unknown[] } {
  const view = VIEWS[query.view];
  if (!view) throw new Error(`unknown view: ${query.view}`);

  const selects: string[] = [];
  const groupBy: string[] = [];
  const params: unknown[] = [];

  if (query.timeDimension) {
    const gran = query.timeDimension.granularity; // fixed enum → safe to inline
    const bucket = `DATE_FORMAT(DATE_TRUNC(${view.timeColumn}, '${gran}'), '%Y-%m-%dT%H:%i:%s')`;
    selects.push(`${bucket} AS \`time\``);
    groupBy.push(bucket);
  }
  for (const d of query.dimensions) {
    const expr = view.dimensions[d.field]!;
    selects.push(`${expr} AS \`${d.field}\``);
    groupBy.push(expr);
  }
  for (const m of query.metrics) {
    selects.push(`${aggSql(m.aggregation, view.measures[m.measure]!)} AS \`${m.aggregation}_${m.measure}\``);
  }

  const where: string[] = [`${view.projectCol} = ?`, `${view.timeColumn} >= ?`, `${view.timeColumn} < ?`];
  params.push(projectId, query.fromTimestamp, query.toTimestamp);
  const filtered = compileFilters(view, query.filters);
  where.push(...filtered.conds);
  params.push(...filtered.params);

  // ORDER BY: only known aliases (metric `${agg}_${measure}`, a dimension field, or `time`).
  const aliases = new Set<string>([
    ...query.metrics.map((m) => `${m.aggregation}_${m.measure}`),
    ...query.dimensions.map((d) => d.field),
    ...(query.timeDimension ? ["time"] : []),
  ]);
  const order: string[] = [];
  for (const o of query.orderBy)
    if (aliases.has(o.field)) order.push(`\`${o.field}\` ${o.direction === "asc" ? "ASC" : "DESC"}`);
  if (order.length === 0 && query.timeDimension) order.push("`time` ASC");

  const sql = [
    `SELECT ${selects.join(", ")}`,
    `FROM ${view.from}`,
    `WHERE ${where.join(" AND ")}`,
    groupBy.length ? `GROUP BY ${groupBy.join(", ")}` : "",
    order.length ? `ORDER BY ${order.join(", ")}` : "",
    `LIMIT ${Math.floor(query.rowLimit)}`,
  ]
    .filter(Boolean)
    .join("\n");

  return { sql, params };
}
