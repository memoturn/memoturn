---
name: doris-query
description: Conventions and gotchas for the Apache Doris telemetry store in memoturn — adding TelemetryStore methods, `?` parameterization, merge-on-write (no FINAL needed), Number() normalization at the store boundary, project_id-leading keys, and the ARRAY insert pitfall. Use when writing or reviewing telemetry queries or extending packages/telemetry.
---

# Doris telemetry queries in memoturn

Telemetry lives in Apache Doris (`traces`, `observations`, `scores`), written async by the worker. **All engine SQL lives in `packages/telemetry`** behind the `TelemetryStore` interface (`src/store.ts`, Doris impl in `src/doris/store.ts`). packages/server and the worker call store methods — never hand-write Doris SQL outside the package.

## Add a store method (the recipe)

1. Add the method to the `TelemetryStore` interface in `packages/telemetry/src/store.ts`, typed against `@memoturn/contracts` where a contract shape exists (internal shapes go in `src/types.ts`).
2. Implement it in `src/doris/store.ts` following the conventions below.
3. Add a behavioral case to `src/conformance.test.ts` (runs against live Doris when reachable; any future engine must pass it).
4. Call it from `packages/server/src/<domain>.ts`; the API route's `app.openapi` type-check against the contract is the drift guard (see the `add-endpoint` skill).

## Conventions

- **Parameterize with `?`** — mysql2 client-side escaping via `pool.query(sql, params)`; never string-concat values. Build the conditions array + params array together (see `listTraces`). Identifier/aggregate choices come from fixed allowlist maps, never user input.
- **No FINAL / de-dup modifier** — tables are UNIQUE KEY **merge-on-write** with sequence column `event_ts`: reads always see the merged row, and re-inserting an id with a newer `event_ts` overwrites it (that's how ingest retries and score corrections stay idempotent). A stale `event_ts` loses — never "update" by re-inserting with an old timestamp.
- **`project_id` first** — every query filters by `project_id` (multi-tenant isolation); the UNIQUE KEYs lead with it.
- **Normalize numerics at the store boundary** — `COUNT`/`SUM`/BIGINT can surface as strings from mysql2; wrap in `Number(...)` inside the store method so it returns contract-shaped values. Consumers must never see raw engine rows.
- **Timestamps are UTC end-to-end** — sessions are pinned to `+00:00`; write with `toDorisDateTime(iso)` and read back via `DATE_FORMAT(col, '%Y-%m-%dT%H:%i:%sZ')`.
- **DELETE predicates stay `column op literal`** — compute cutoffs in JS (`cutoffDaysAgo`), don't use SQL functions in DELETE WHERE clauses.
- **Backquote reserved-ish identifiers** — `` `timestamp` ``, `` `value` ``, `` `comment` ``, `` `release` ``, `` `public` ``.

## Gotchas

- **ARRAY inserts**: never `CAST('["…"]' AS ARRAY<STRING>)` — Doris's string→array parser silently corrupts values containing quotes/commas. Use an array constructor with one placeholder per element (`[?, ?]`, `[]` when empty) — `doris/serialize.ts` does this for `tags`.
- **ARRAY reads**: select `CAST(tags AS JSON) AS tags` (raw ARRAY over the MySQL wire is not JSON-escaped) and parse with `parseTags`.
- **Join fan-out**: pre-aggregate observations per trace in a subquery instead of `LEFT JOIN + GROUP BY` over the trace columns (also avoids grouping by the ARRAY column).
- **Metrics are on-the-fly** — no rollup table/MV; percentiles via `PERCENTILE_APPROX(latency_ms, p)` over `type = 'GENERATION'` rows.

## Schema changes

New/changed columns go through a numbered migration in `infra/doris/*.sql`, applied with `bun run db:telemetry`. The runner records each file in the `schema_migrations` ledger, so **a shipped migration file is immutable** — additive changes get a new file. Table names can't start with `_`. See the `ingest-event-change` skill.
