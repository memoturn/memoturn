---
name: worker-ops
description: Operating the memoturn worker — the BullMQ ingest pipeline's failure paths (dead-letter queue inspect/replay, blob replay as source of truth), the maintenance crons and their Redis locks, payload offloading, and the worker metrics endpoint. Use when debugging failed ingest jobs, replaying telemetry, changing a cron, or investigating worker health.
paths: apps/worker/**, scripts/replay-dlq.ts
---

# Worker operations

The worker (`apps/worker`) consumes BullMQ jobs: re-read the raw batch from **blob** (the replayable source of truth), map (`mappers.ts`), insert into Doris, then run sampled online evaluators best-effort. The API never writes telemetry synchronously — keep it that way.

## Failure paths

- **Retries → DLQ**: jobs that exhaust retries land in the `ingest-dlq` queue. Inspect with `bun run dlq`; **`bun run dlq --replay`** re-enqueues failed batches from blob. The DLQ cycle converges — a replayed batch that fails again just returns to the DLQ.
- **Blob replay is the recovery story**: because the raw pre-mapping batch is persisted before the 207 ack, any Doris-side loss is recoverable by re-enqueuing from blob (proven in the Jul 2026 backfill). Don't build recovery paths that bypass it.
- **Per-table independence**: `traces`, `observations`, `scores` are inserted independently — one table's failure doesn't discard the others. Preserve this when touching the insert path.
- **Online eval failures never fail ingestion** — best-effort try/catch, deterministic FNV sampling (see add-evaluator).

## Crons (all in `apps/worker/src/index.ts`; schedules are docs-coupled → CLAUDE.md, checked by `docs:check`)

| Cron | Schedule |
|---|---|
| Retention sweep | `0 3 * * *` |
| Scheduled blob exports | `0 4 * * *` |
| Embedding-projection reduction | `0 5 * * *` |
| Mutable-state prune (ADR-0001: bounds the Postgres `*State` working set) | `17 * * * *` |
| Alert evaluation (stateful rules + cost budgets) | `* * * * *` |

Retention/export crons take a **Redis lock** (`withLock`) so multiple worker replicas don't run them concurrently — any new cron with side effects needs the same guard.

## Guardrails in the pipeline

- Input/output payloads **> 256 KB are offloaded to blob** with a marker reference before insert.
- Per-event token counts clamp at `MAX_EVENT_TOKENS` (10 M, `packages/core/src/models.ts`) against runaway cost inflation.
- All log output is structured JSON (`logJson`); counters (`ingest_events_total`, `ingest_errors_total`, `ingest_rows_total`, `evaluator_runs_total`), `telemetry_insert` latency, and `dlqDepth` are exposed at the health/metrics HTTP endpoint (`WORKER_PORT`, default 3002).

## Verify

`bun --filter @memoturn/worker test`, `bun run typecheck`; for pipeline changes run the dev stack and `bun run quickstart`, then check the worker `/metrics` JSON and (if you exercised failures) `bun run dlq`.
