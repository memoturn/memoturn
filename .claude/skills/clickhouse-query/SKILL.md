---
name: clickhouse-query
description: Conventions and gotchas for querying ClickHouse in memoturn — parameterized query building, FINAL on ReplacingMergeTree reads, Number() coercion of string counts, and project_id-leading sort keys. Use when writing or reviewing telemetry queries in packages/server (traces, metrics, etc.).
---

# ClickHouse queries in memoturn

Telemetry lives in ClickHouse (`traces`, `observations`, `scores`), written async by the worker. Query it from `packages/server/src/<domain>.ts` via the `query<T>(sql, params)` helper from `@memoturn/db/clickhouse`.

## Conventions

- **Parameterize** — never string-concat values. Use ClickHouse bound params `{name:Type}` and build the conditions array + params object together:
  ```ts
  const conds: string[] = ["t.project_id = {projectId:String}"];
  const params: Record<string, unknown> = { projectId };
  if (userId) {
    conds.push("t.user_id = {userId:String}");
    params.userId = userId;
  }
  const sql = `SELECT ... FROM traces t FINAL WHERE ${conds.join(" AND ")} ORDER BY ...`;
  return query<TraceSummary>(sql, params);
  ```
- **`FINAL` on reads** — the tables are `ReplacingMergeTree(event_ts)`; without `FINAL` you can read un-merged duplicate/partial rows. Use it on point/detail reads.
- **`project_id` first** — every query filters by `project_id` (multi-tenant isolation); the sort keys lead with it.
- **Counts are strings** — `count()` / `sum()` come back as **strings** in JSONEachRow. Coerce with `Number(...)`. Contract types declare them as `number`, so an un-coerced count is a type error or a silent string in the console.

## The return type is the contract

A server query's return type **is** the inferred contract type from `packages/contracts/src/index.ts`. Shape the `SELECT` to that contract; the API route's `app.openapi` type-check enforces it. See the `add-endpoint` skill.

## Schema changes

New/changed columns go through a numbered migration in `infra/clickhouse/*.sql`, applied with `bun run db:clickhouse`. See the `ingest-event-change` skill.
