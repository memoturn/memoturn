import type { SingleFilter } from "@memoturn/contracts";

/**
 * Compiles the shared structured filter model (`SingleFilter` from @memoturn/contracts) into
 * parameterized Doris SQL predicates over the traces list (alias `t`). Each filter becomes a
 * `(fragment, params)` pair; callers AND them into the trace WHERE clause.
 *
 * Design mirrors the contract's value-type model: one predicate builder per type, every value
 * bound as a `?` parameter (never interpolated — the injection boundary). The physical column
 * mapping (UI column id → Doris column / observation subquery / per-trace aggregate) lives here,
 * decoupled from the UI which only knows `{id, label, type}`.
 */

type ColSpec =
  // A direct column on the traces row.
  | { kind: "trace"; expr: string }
  // The `t.metadata` JSON string, accessed by an arbitrary key.
  | { kind: "traceJson" }
  // An observation attribute — trace matches if ANY observation satisfies the predicate.
  | { kind: "obs"; col: string }
  // A per-trace aggregate over observations (matches how listTraces rolls these up).
  | { kind: "metric"; agg: "SUM" | "MAX"; col: string }
  // A named score — the filter's `key` is the score name, the value compared against `col`.
  | { kind: "score"; col: string };

/** UI column id → physical Doris mapping. Ids match `TRACE_FILTER_COLUMNS` in @memoturn/contracts. */
const TRACE_COLUMNS: Record<string, ColSpec> = {
  name: { kind: "trace", expr: "t.name" },
  environment: { kind: "trace", expr: "t.environment" },
  userId: { kind: "trace", expr: "t.user_id" },
  sessionId: { kind: "trace", expr: "t.session_id" },
  version: { kind: "trace", expr: "t.version" },
  release: { kind: "trace", expr: "t.`release`" },
  timestamp: { kind: "trace", expr: "t.`timestamp`" },
  tags: { kind: "trace", expr: "t.tags" },
  metadata: { kind: "traceJson" },
  type: { kind: "obs", col: "type" },
  level: { kind: "obs", col: "level" },
  tokens: { kind: "metric", agg: "SUM", col: "total_tokens" },
  cost: { kind: "metric", agg: "SUM", col: "total_cost" },
  latencyMs: { kind: "metric", agg: "MAX", col: "latency_ms" },
  scores: { kind: "score", col: "`value`" },
  scoreCategories: { kind: "score", col: "string_value" },
};

const NUMERIC_OP: Record<string, string> = { eq: "=", neq: "!=", gt: ">", lt: "<", gte: ">=", lte: "<=" };

export type Frag = { frag: string; params: unknown[] };
const TRUE: Frag = { frag: "1=1", params: [] };

/** Scalar predicate for string/number/datetime/boolean/stringOptions/null over a SQL expression. */
export function scalarPredicate(expr: string, f: SingleFilter): Frag {
  switch (f.type) {
    case "string":
    case "stringObject":
      switch (f.operator) {
        case "eq":
          return { frag: `${expr} = ?`, params: [f.value] };
        case "neq":
          return { frag: `${expr} != ?`, params: [f.value] };
        case "contains":
          return { frag: `${expr} LIKE CONCAT('%', ?, '%')`, params: [f.value] };
        case "not_contains":
          return { frag: `${expr} NOT LIKE CONCAT('%', ?, '%')`, params: [f.value] };
        case "starts_with":
          return { frag: `${expr} LIKE CONCAT(?, '%')`, params: [f.value] };
        case "ends_with":
          return { frag: `${expr} LIKE CONCAT('%', ?)`, params: [f.value] };
      }
      return TRUE;
    case "number":
    case "numberObject":
    case "datetime":
      return { frag: `${expr} ${NUMERIC_OP[f.operator]} ?`, params: [f.value] };
    case "boolean":
      return { frag: `${expr} ${f.operator === "eq" ? "=" : "!="} ?`, params: [f.value ? 1 : 0] };
    case "stringOptions": {
      if (f.value.length === 0) return TRUE;
      const ph = f.value.map(() => "?").join(", ");
      return { frag: `${expr} ${f.operator === "any_of" ? "IN" : "NOT IN"} (${ph})`, params: [...f.value] };
    }
    case "null":
      return f.operator === "is_null"
        ? { frag: `(${expr} IS NULL OR ${expr} = '')`, params: [] }
        : { frag: `(${expr} IS NOT NULL AND ${expr} != '')`, params: [] };
    default:
      return TRUE;
  }
}

/** Array-column predicate (e.g. tags) via per-element array_contains — avoids ARRAY-literal binding. */
export function arrayPredicate(expr: string, f: Extract<SingleFilter, { type: "arrayOptions" }>): Frag {
  if (f.value.length === 0) return TRUE;
  const contains = f.value.map(() => `array_contains(${expr}, ?)`);
  if (f.operator === "all_of") return { frag: `(${contains.join(" AND ")})`, params: [...f.value] };
  const anyOf = `(${contains.join(" OR ")})`;
  return f.operator === "any_of"
    ? { frag: anyOf, params: [...f.value] }
    : { frag: `NOT ${anyOf}`, params: [...f.value] };
}

/** Sanitize an arbitrary metadata key into a JSON path segment (structural, not a value — so it
 * can't be a bound param on Doris; unmatched chars are dropped, which simply won't match). */
function jsonPath(key: string): string {
  return `'$.${key.replace(/[^A-Za-z0-9_.-]/g, "")}'`;
}

/** Compile one filter into a trace-WHERE fragment, or `null` if its column is unknown. */
function compileOne(projectId: string, f: SingleFilter): Frag | null {
  const spec = TRACE_COLUMNS[f.column];
  if (!spec) return null;

  if (spec.kind === "trace") {
    return f.type === "arrayOptions" ? arrayPredicate(spec.expr, f) : scalarPredicate(spec.expr, f);
  }

  if (spec.kind === "traceJson") {
    if (f.type !== "stringObject" && f.type !== "numberObject") return null;
    const path = jsonPath(f.key);
    const expr =
      f.type === "numberObject"
        ? `CAST(get_json_string(t.metadata, ${path}) AS DOUBLE)`
        : `get_json_string(t.metadata, ${path})`;
    return scalarPredicate(expr, f);
  }

  if (spec.kind === "obs") {
    // Trace matches if ANY of its observations satisfies the predicate (column is bare inside the subquery).
    const inner = f.type === "arrayOptions" ? arrayPredicate(spec.col, f) : scalarPredicate(spec.col, f);
    return {
      frag: `t.id IN (SELECT trace_id FROM observations WHERE project_id = ? AND ${inner.frag})`,
      params: [projectId, ...inner.params],
    };
  }

  if (spec.kind === "score") {
    // `key` is the score name. Scores always carry trace_id (even observation-scoped ones), so
    // matching on trace_id is level-agnostic: a score on the trace OR on any of its observations
    // qualifies. Existential, like the observation predicates above — "has a score named N that …".
    if (f.type !== "numberObject" && f.type !== "stringObject") return null;
    const name = f.key.trim();
    if (!name) return null;
    const inner = scalarPredicate(spec.col, f);
    return {
      frag: `t.id IN (SELECT trace_id FROM scores WHERE project_id = ? AND name = ? AND ${inner.frag})`,
      params: [projectId, name, ...inner.params],
    };
  }

  // metric: per-trace aggregate over observations, filtered with HAVING.
  if (f.type !== "number") return null;
  return {
    frag: `t.id IN (SELECT trace_id FROM observations WHERE project_id = ? GROUP BY trace_id HAVING ${spec.agg}(${spec.col}) ${NUMERIC_OP[f.operator]} ?)`,
    params: [projectId, f.value],
  };
}

/**
 * UI column id → physical mapping for the span-level explorer (alias `o`). Ids match
 * `OBSERVATION_FILTER_COLUMNS`. Unlike the trace registry, every column is a direct column on
 * the observation row — the predicate is about the span itself, not about its trace.
 */
const OBSERVATION_COLUMNS: Record<string, string> = {
  name: "o.name",
  type: "o.type",
  level: "o.level",
  model: "o.model",
  provider: "o.provider",
  environment: "o.environment",
  traceId: "o.trace_id",
  parentId: "o.parent_observation_id",
  promptName: "o.prompt_id",
  promptVersion: "o.prompt_version",
  statusMessage: "o.status_message",
  startTime: "o.start_time",
  latencyMs: "o.latency_ms",
  tokens: "o.total_tokens",
  cost: "o.total_cost",
  input: "o.input",
  output: "o.output",
};

/** Compile a structured filter set over observations into AND-able WHERE fragments + params. */
export function buildObservationFilterSql(
  projectId: string,
  filters: SingleFilter[],
): { conds: string[]; params: unknown[] } {
  const conds: string[] = [];
  const params: unknown[] = [];
  for (const f of filters) {
    if (f.column === "scores" || f.column === "scoreCategories") {
      // Scored at THIS span: unlike the trace registry (which resolves level-agnostically), the
      // span explorer matches scores attached to the observation itself.
      if (f.type !== "numberObject" && f.type !== "stringObject") continue;
      const name = f.key.trim();
      if (!name) continue;
      const inner = scalarPredicate(f.column === "scores" ? "`value`" : "string_value", f);
      conds.push(`o.id IN (SELECT observation_id FROM scores WHERE project_id = ? AND name = ? AND ${inner.frag})`);
      params.push(projectId, name, ...inner.params);
      continue;
    }
    if (f.column === "metadata") {
      if (f.type !== "stringObject" && f.type !== "numberObject") continue;
      const path = jsonPath(f.key);
      const expr =
        f.type === "numberObject"
          ? `CAST(get_json_string(o.metadata, ${path}) AS DOUBLE)`
          : `get_json_string(o.metadata, ${path})`;
      const frag = scalarPredicate(expr, f);
      conds.push(frag.frag);
      params.push(...frag.params);
      continue;
    }
    const expr = OBSERVATION_COLUMNS[f.column];
    if (!expr || f.type === "arrayOptions") continue;
    const frag = scalarPredicate(expr, f);
    conds.push(frag.frag);
    params.push(...frag.params);
  }
  return { conds, params };
}

/** Compile a structured filter set into AND-able WHERE fragments + params (unknown columns skipped). */
export function buildTraceFilterSql(
  projectId: string,
  filters: SingleFilter[],
): { conds: string[]; params: unknown[] } {
  const conds: string[] = [];
  const params: unknown[] = [];
  for (const f of filters) {
    const c = compileOne(projectId, f);
    if (!c) continue;
    conds.push(c.frag);
    params.push(...c.params);
  }
  return { conds, params };
}
