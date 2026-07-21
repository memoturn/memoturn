# ADR 0001 — Storage roles: Doris as analytical mirror, Postgres authoritative for mutable state

- **Status:** Accepted — direction agreed; implementation **trigger-gated** (see [Trigger](#trigger)).
- **Date:** 2026-07-21
- **Context tags:** ingest pipeline, telemetry store, merge-on-write, data model

## Context

memoturn splits storage by access pattern (see `docs/architecture.md`): relational metadata in
**Postgres**, high-volume telemetry in **Apache Doris**, the raw replayable event log in **blob**.
Doris holds `traces`, `observations`, `scores`, `retrieval_documents`, `embeddings` as `UNIQUE KEY`
**merge-on-write** tables keyed on `(project_id, id)`, with `event_ts` (the client event timestamp)
as the **sequence column** for last-writer-wins (LWW).

That model serves the **analytical read path** superbly — filtered scans, facet counts, latency
percentiles, cost/token rollups, dashboard aggregations, and vector k-NN over millions of rows —
which is Doris's core strength and the reason it is in the stack.

The same model is also pressed into a **mutable-entity** role: a trace or observation is *created*
and then *updated* (output/tokens/timing arrive later). To make updates merge and stay idempotent
under retries, the worker does a **read-merge** (fetch the stored row, merge the patch, write a full
row) and — since ADR-adjacent PR #140 — holds a **per-entity lock** to serialize concurrent patches.

### The limitation we hit

Doris merge-on-write has exactly **one row-level sequence column**. This makes correct *field-level*
merge impossible at the margins. Empirically validated against a live Doris **4.1.2** cluster
(scratch table with the same `UNIQUE KEY` + `function_column.sequence_col=event_ts` pattern):

| Write | `event_ts` vs stored | Result |
|-------|----------------------|--------|
| full insert `a=A2,b=B2,c=C2` | — | row = `A2,B2,C2` |
| **partial** update `a=A1` | **lower** | **rejected** — `a` stayed `A2` |
| partial update `b=B3` | higher | applied — `b→B3`, `a`/`c` retained |
| **partial** update `c=C_late` (non-conflicting) | **lower** | **rejected** — `c` stayed `C2` |

**A partial-column update at a lower sequence is rejected wholesale, even for a non-conflicting
field.** So Doris partial-column update does **not** fix the late-arriving-update case, and the
row-level sequence gate means an out-of-order patch to a *different* field is still dropped. The
`event_ts` LWW model is fundamentally in tension with field-level merge:

- sequence = **client timestamp** → retry-safe, but a late-arriving update (older timestamp) is dropped (**today**);
- sequence = **processing/arrival order** → late arrivals apply, but a retry/replay clobbers a newer correction;
- **partial-column update** → does not help; the row-level gate still rejects any lower-sequence write.

You cannot get "field-level merge + newest-wins-per-field + retry-safe" from a single row-level
sequence column. This is an engine property, not a back-compat artifact — having no users lets us
reshape schema freely but cannot give Doris per-field LWW.

## Decision

**Adopt a clear division of storage roles:**

- **Doris = the analytical mirror.** It is where reads happen (metrics, dashboards, facets,
  percentiles, rollups, vector search) and the long-term system of record for *settled* rows. It is
  **not** the authoritative store for state that mutates.
- **Postgres = authoritative for mutable entity state** (`traces`, `observations`, `scores`) during
  their mutation window. Field-level merges happen there transactionally — trivially correct,
  retry-safe, no read-merge race, no LWW late-arrival edge.
- **Blob** remains the raw replay source of truth (unchanged).

Doris is mirrored from the authoritative Postgres state, keyed and versioned by a **monotonic
`state_version`** (replacing `event_ts` as the sequence column) so mirror writes are order-independent
and idempotent. This removes the read-merge, the per-entity lock (#140), and the late-arrival edge.

**Implementation is trigger-gated.** At zero users the edge this fixes is near-zero in practice
(distinct observations have distinct ids; trace/observation updates almost always carry
equal-or-later timestamps), and the change adds a real cost (a Postgres write per ingest event in the
working window). The current design (#140) is correct for the concurrency that actually occurs. We
record the decision and the plan now, and execute when the [trigger](#trigger) fires.

## Consequences

**Positive**
- Correct field-level merge for mutable entities, any processing order; retry/replay safe by construction.
- Deletes the read-merge base-fetch, the entity lock (#140), and `event_ts`-gating complexity.
- Each engine does what it is best at; the `TelemetryStore` seam and blob replay keep it reversible.

**Negative / cost**
- A **Postgres upsert per ingest event** for the working window — Postgres must sustain ingest-rate
  writes on the hot set (bounded by the prune window). This is the main cost and the reason to gate.
- The Doris sequence column changes (`event_ts` → `state_version`); `conformance.test.ts` and the
  store change accordingly (a clean cut, no data migration since there are no users).
- A new prune + rehydrate edge (late update to an already-pruned entity — rare).

## Implementation plan

Target architecture: **"Postgres merge-buffer, Doris analytical mirror."** Each ingest event
transactionally field-merges into Postgres (authoritative), and the resulting full row is mirrored to
Doris (analytical, versioned). A rolling prune evicts settled Postgres rows; Doris retains history.

All phases sit behind a `MUTABLE_STATE_STORE=pg` flag and the `TelemetryStore` seam so the old path
stays runnable until cutover.

### Phase 1 — Postgres authoritative merge (additive, flagged off)
- Prisma models `TraceState`, `ObservationState`, `ScoreState`, keyed `(projectId, id)`, one column
  per mutable field, plus `stateVersion BIGINT` and `updatedAt`. Add the `Project` reverse relations
  (per `CLAUDE.md`).
- In `apps/worker/src/processors/ingest.ts`, add a merge step: `INSERT … ON CONFLICT (project_id,id)
  DO UPDATE SET <field> = COALESCE(EXCLUDED.<field>, base.<field>)` for each mutable field, so only
  fields the event actually carries overwrite. `stateVersion` = a monotonic value (epoch-millis of the
  merge, or a Postgres sequence). Field-level merge is correct under Postgres row locks; retries are
  idempotent (same values).
  - *Optional strict newest-wins:* add per-field `*_asof` columns and gate each `SET` with
    `CASE WHEN EXCLUDED.x_asof >= base.x_asof …`. Defer unless strict per-field ordering is required —
    last-processed-wins-per-field is already a large improvement over today's wholesale drop.
- Keep writing to Doris exactly as today (dual-run) to validate the merge in isolation. Add a
  `state_merge_conflicts_total` / shadow-compare counter.

### Phase 2 — Doris becomes a pure mirror
- New Doris DDL: `traces/observations/scores` keyed `(project_id, id)`, merge-on-write with
  `function_column.sequence_col = state_version` (drop `event_ts` gating). Immutable per write.
- Worker mirror step writes the **full current row from Postgres state** to Doris after the merge,
  carrying `state_version` as the sequence — so out-of-order mirror writes never regress and are
  idempotent.
- Remove the read-merge base-fetch (`getTraceRowsByIds`/`getObservationRowsByIds` in the ingest path)
  and the entity lock (`withEntityLocks` / `apps/worker/src/entitylock.ts`) — no longer needed.
- Update `TelemetryStore` + `packages/telemetry/src/doris/*` for the new sequence column; extend
  `conformance.test.ts` with field-level-merge and out-of-order cases (run against live Doris).

### Phase 3 — Prune + rehydrate
- Worker cron (guard with `withLock`, per ADR-adjacent #138 fixes): delete `*_state` rows whose
  `updatedAt < now − STATE_RETENTION_WINDOW` (e.g. 48h). Doris keeps full history.
- Rehydrate path: an ingest event for an entity **not** in `*_state` (pruned or genuinely new) — if it
  is an update to a known Doris row, hydrate the Postgres row from Doris first, then merge. Rare;
  bounded by the window.

### Phase 4 — Cutover & cleanup
- Flip `MUTABLE_STATE_STORE=pg` by default; drop the dual-run and the shadow counters.
- Remove `event_ts`-based merge code, the read-merge helpers, and `entitylock.ts`.
- Update `docs/architecture.md` (storage-roles table + sequence), `CLAUDE.md` (merge semantics,
  worker crons), and run `bun run docs:check`.

**Rollback:** the flag reverts to the Doris-authoritative path; blob remains the replay source, so
Doris can be rebuilt from scratch at any phase.

## Alternatives considered

- **Doris partial-column update.** Empirically rejected above — the row-level sequence gate drops any
  lower-sequence write, so it fixes neither late-arrival nor out-of-order field merge, and is *worse*
  than #140 for concurrency (loses the out-of-order field where the lock preserves it).
- **Processing-order sequence + event-id dedup.** Would fix late-arrival and keep retries safe, but
  needs an applied-event-id dedup store (bounded vs DLQ-replay window) and still can't do field-level
  merge on a single row-level sequence. More machinery, less complete than the Postgres merge.
- **Per-field version columns in Doris.** True field-level LWW, but heavy schema/merge complexity and
  still not transactional; strictly worse than merging in Postgres, which is built for it.
- **Assemble-then-write (defer the Doris write until the entity settles).** Removes in-place updates
  entirely, but adds a freshness lag (data not queryable until settled), which hurts the core
  observability UX. Mirror-on-write keeps analytics fresh.
- **Keep #140, accept the edge (do nothing).** The recommended state *until the trigger* — the edge is
  near-zero for real SDK traffic and #140 fixes the concurrency that occurs.

## Trigger

Execute the plan when any of these is true:

1. Mutable-entity correctness becomes load-bearing — real out-of-order or concurrent updates to the
   same entity observed in production (watch `ingest_merge_unlocked_total` from #140 and any field-loss
   reports), **or**
2. Ingest throughput makes the read-merge base-fetch + entity lock a measured hot-path bottleneck, **or**
3. A customer/compliance requirement demands provably-correct mutable state.

Until then: keep #140, and keep this ADR current.
