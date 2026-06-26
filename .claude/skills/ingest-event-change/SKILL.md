---
name: ingest-event-change
description: How to change the shape of an ingest event in memoturn — the files that must move together (events.ts wire contract, worker mappers, ClickHouse columns, tests) and the ReplacingMergeTree semantics. Use when editing packages/core/src/events.ts or any field flowing SDK → API → worker → ClickHouse.
---

# Change an ingest event shape

`packages/core/src/events.ts` is the **shared wire contract** — the SDK, the API validator, and the worker all import it. A shape change ripples through several files that must move together or telemetry silently corrupts/drops.

## Files that move together

1. **Wire contract** — `packages/core/src/events.ts` (Zod schemas). Change the shape here first.
2. **Worker mappers** — `apps/worker/src/mappers.ts` (events → ClickHouse rows; trace-create + updates merge by timestamp; cost from the model registry). Map every new/changed field.
3. **ClickHouse schema** — new numbered migration under `infra/clickhouse/*.sql` for any column change; apply with `bun run db:clickhouse`. Tables are `ReplacingMergeTree(event_ts)` (late/partial events merge deterministically; sort key leads with `project_id`). Add columns — don't rename in place.
4. **Tests** — `packages/core/src/events.test.ts` (schema + cost) and `apps/worker/src/mappers.test.ts` (merge + cost vs model registry).

## Verify

```bash
bun --filter @memoturn/core test
bun --filter @memoturn/worker test
bun run typecheck
```

## Gotchas

- ClickHouse counts come back as **strings** in JSONEachRow — coerce with `Number(...)`.
- Online eval failures must **never** fail ingestion (best-effort in the worker) — don't change that.
- The SDKs (`sdks/js`, `sdks/python`) emit these events; a breaking change needs SDK + docs updates too.

For the cross-file change with tests, delegate to the **ingest-syncer** agent.
