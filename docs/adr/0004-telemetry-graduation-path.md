# ADR 0004 — Telemetry graduation path: migrating an install from Postgres to Doris

- **Status:** Proposed (executes as part of ADR-0002's implementation — the graduation runbook
  ships with the Postgres tier, not after it).
- **Date:** 2026-07-22
- **Context tags:** telemetry store, migration, deployment profiles, TelemetryStore seam

## Context

ADR-0002 introduces the Postgres telemetry tier and names its exit: "flip
`TELEMETRY_ENGINE=doris` and replay the raw event log from blob." That one-liner is directionally
right but under-specified in three ways that matter to an operator actually doing it:

1. **Blob replay only covers what blob retention has kept.** The retention sweep prunes old
   telemetry per project policy; an install running a bounded retention window cannot rebuild
   *full* history from blob — but its Postgres telemetry store still holds every settled row
   within retention. The authoritative source for a migration is therefore the **source store
   itself**, not the raw event log.
2. **The seam has no bulk-read surface.** `insertRows` accepts raw `TelemetryRowMap` rows, but
   nothing enumerates them back out — `exportTraces` is user-export shaped (filtered, projected),
   not full-fidelity. Engine-to-engine copy needs a scan method.
3. **Cutover choreography is undefined** — what happens to in-flight ingest during the copy, how
   the result is verified, and what rollback looks like.

A useful property of the existing architecture does most of the heavy lifting: because the
pipeline is async (API acks after blob + enqueue; the worker does all telemetry writes), pausing
the **worker** pauses telemetry writes without any API downtime — the queue and blob buffer
everything. "Downtime" during a migration is processing lag, not data loss or read outage.

## Decision

**Primary mechanism: seam-to-seam copy.** Both engines implement `TelemetryStore`; migration
reads raw rows from the source store and writes them to the target through the same interface the
worker uses:

- Add to the seam: `scanRows<T extends TelemetryTable>(table: T, cursor?: ScanCursor, limit?:
  number): Promise<{ rows: TelemetryRowMap[T][]; next: ScanCursor | null }>` — keyset-paginated
  over the table's unique key `(project_id, id)`, full row fidelity, **sequence column included**.
  Both implementations provide it; `conformance.test.ts` pins round-trip fidelity
  (`scanRows` → `insertRows` into a fresh store → identical reads).
- A `telemetry:migrate` CLI (a sibling of `dlq`/`seed`) drives the copy: for each telemetry table,
  page `scanRows` from the source engine, `insertRows` into the target (the Doris side rides the
  existing multi-row INSERT / Stream Load paths). Because rows carry their sequence values and the
  target is merge-on-write LWW, the copy is **idempotent and resumable** — re-running converges,
  and overlap with catch-up ingest cannot regress a row.

**Blob replay remains the fallback and the audit path** — for disaster recovery (source store
lost), for rebuilding history that predates a store (where blob retention allows), and as an
independent cross-check of the copy. It is not the primary migration mechanism.

### Cutover choreography (the runbook, shipped with ADR-0002 Phase 4)

1. **Provision** Doris and apply `db:telemetry` migrations. Both engines are now reachable.
2. **Bulk copy, system live.** Run `telemetry:migrate` source→target while everything keeps
   running against Postgres. Reads don't block; the copy is a snapshot-ish pass that will be
   topped up in step 4.
3. **Pause the worker** (stop consumers; the API keeps acking — blob + queue buffer all ingest).
4. **Top-up copy**: re-run `telemetry:migrate` — LWW idempotency means only rows changed since
   step 2 have any effect. This pass is small and fast.
5. **Verify**: `countProjectRows` per project on both engines must match; spot-check N random
   trace ids via `getTraceRowsByIds`/`getObservationRowsByIds` for row-level equality (the CLI
   automates both and refuses to proceed on mismatch).
6. **Flip** `TELEMETRY_ENGINE=doris` on API + worker; **resume the worker** — buffered jobs drain
   into Doris. Total write-path pause: minutes; API availability: unaffected.
7. **Rollback window**: keep the Postgres telemetry tables untouched for an operator-chosen
   window. Rollback = flip the env back and replay the since-cutover delta from blob into
   Postgres (blob has everything ingested during the trial by construction). Only after the
   window: drop the PG telemetry schema.

### Interactions worth pinning

- **ADR-0001 mutable state is engine-agnostic** and unaffected: the `*State` tables are the merge
  authority regardless of telemetry engine; the mirror step writes through `insertRows` either
  way. The rehydrate path reads from whichever engine is active — correct in both directions
  because the copy preserved settled rows and sequence values.
- **Reverse direction (Doris → Postgres) works identically** through the same seam and CLI — 
  useful for downsizing or for seeding a staging copy — but is *unsupported past the PG tier's
  sizing envelope* (the CLI warns on source row counts above it).
- **Edge profile (ADR-0003)**: graduation from the edge profile is the same data migration plus a
  *compute* move to the container-scale profile (Doris is not reachable from the edge runtime).
  The runbook is shared; only the "flip" step differs (redeploy container profile rather than
  set an env var).
- **Embeddings/vector data** copy as ordinary rows (`embeddings`, `retrieval_documents` are
  telemetry tables); similarity behavior differences (pgvector HNSW vs Doris exact scan) are
  read-path characteristics, not data-migration concerns.

## Consequences

**Positive**

- Graduation is a **rehearsable, resumable, verifiable runbook** with zero ingest loss and no API
  downtime — the async pipeline's buffering does the hard part.
- `scanRows` is small, generic, and independently useful (staging seeds, downsizing, future
  engine contingencies) — and it hardens the conformance suite with a round-trip fidelity check.
- Blob replay stays what it should be: disaster recovery and audit, not a load-bearing migration
  dependency with a hidden retention coupling.

**Negative / cost**

- One more seam method both engines must implement (the ADR-0002 dual-implementation tax grows by
  one — but this is the method that makes every *future* engine move cheap).
- The migration CLI is new surface to test; mitigated by driving it entirely through seam methods
  already covered by conformance.
- Very large Doris→X copies are impractical through row-paged scans; out of scope (the supported
  direction at scale is PG→Doris, within the PG tier's envelope by definition).

## Alternatives considered

- **Blob replay as the primary path** (ADR-0002's original sketch). Couples migration
  completeness to blob retention policy; re-processes every event through the worker (slower than
  row copy); and re-runs online evaluators unless suppressed. Retained as fallback/audit only.
- **Engine-native ETL** (Doris MySQL external catalog / `INSERT INTO SELECT` from Postgres,
  or dump-and-Stream-Load files). Fastest at bulk, but lives outside the seam — engine-pair-
  specific, unavailable to future engines, and bypasses the row types that guarantee fidelity.
  Rejected for the supported path; nothing prevents an operator using it ad hoc.
- **Dual-write cutover** (write both engines during a window, then flip reads). Avoids even the
  brief worker pause, but adds a dual-write mode to the worker that exists only for migrations —
  more permanent machinery for marginal benefit at the PG tier's scale. The queue-buffer pause is
  simpler and loses nothing.
- **No defined path ("it's just replay").** The status quo this ADR replaces — under-specified in
  the three ways listed in Context.

## Trigger

None of its own — this ADR **rides ADR-0002's trigger**: `scanRows` + conformance round-trip land
with the Postgres implementation (Phase 1–2), the `telemetry:migrate` CLI and runbook with
profile packaging (Phase 4). The graduation path must exist *before* the first Postgres-tier
install exists, because "you can leave whenever you want" is the tier's core promise.
