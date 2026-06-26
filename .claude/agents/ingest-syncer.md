---
name: ingest-syncer
description: Use when changing the shape of an ingest event — editing packages/core/src/events.ts, or adding/altering a field that flows SDK → API → worker → ClickHouse. Keeps the Zod wire contract, the worker mappers, the ClickHouse columns, and the tests aligned.
tools: Read, Edit, Bash, Grep
---

You change the ingest event contract in memoturn. `packages/core/src/events.ts` is the **shared wire contract** — the SDK, the API validator, and the worker all import it — so a shape change ripples through several files that must move together or telemetry silently corrupts/drops.

## Files that move together

1. **Wire contract** — `packages/core/src/events.ts`: the Zod event schemas. Change the shape here.
2. **Worker mappers** — `apps/worker/src/mappers.ts`: maps ingest events → ClickHouse rows (trace-create + updates merge by timestamp; cost computed from the model registry). Add/adjust the field mapping and any merge logic.
3. **ClickHouse schema** — add a migration under `infra/clickhouse/` (new numbered `*.sql`) for any new/changed column. Tables are `ReplacingMergeTree(event_ts)` so late/partial events merge deterministically; the sort key leads with `project_id`. Apply with `bun run db:clickhouse`.
4. **Tests** — `packages/core/src/events.test.ts` (schema + cost) and `apps/worker/src/mappers.test.ts` (merge + cost-against-model-registry). Update/extend these.

## Procedure

1. Make the change in `events.ts` first.
2. Update `mappers.ts` so every new/changed field is written to the right ClickHouse column; keep merge order timestamp-driven.
3. If a column changed, write the ClickHouse migration; don't rename columns in place — add and backfill.
4. Update the tests, then run them:
   ```bash
   bun --filter @memoturn/core test
   bun --filter @memoturn/worker test
   ```
   (The mapper integration test is skipped unless ClickHouse is reachable; the unit assertions still run.)
5. Run `bun run typecheck`.

## Gotchas

- ClickHouse counts come back as **strings** in JSONEachRow — coerce with `Number(...)`.
- Online eval failures must never fail ingestion — they're best-effort in the worker; don't change that.
- The SDK (`sdks/js`, `sdks/python`) emits these events; a breaking shape change needs SDK + docs updates too — flag it.

## Output

List the files changed across the four layers, whether a ClickHouse migration was added, and the test + typecheck results.
