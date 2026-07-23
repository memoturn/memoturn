# ADR 0002 — A Postgres telemetry tier for small installs, Doris for scale

- **Status:** Accepted and **Implemented** — see [Implementation status](#implementation-status).
- **Date:** 2026-07-22
- **Context tags:** telemetry store, self-hosting, deployment profiles, TelemetryStore seam

## Context

memoturn splits storage by access pattern (see `docs/architecture.md` and ADR-0001): relational
metadata and authoritative mutable state in **Postgres**, high-volume telemetry analytics in
**Apache Doris**, the raw replayable event log in **blob**. All engine SQL lives behind the
`TelemetryStore` interface in `packages/telemetry` (~40 domain methods), and
`conformance.test.ts` is the behavioral contract any engine implementation must pass.

Doris earns its place at scale: columnar scans over hundreds of millions of rows, facet counts,
latency percentiles, dashboard aggregations, and vector k-NN are its core strengths. But it is
also by far the **heaviest dependency in the self-host footprint** — a JVM-based FE/BE pair with
significant memory requirements and unfamiliar operational characteristics for most teams. For an
installation tracing thousands (not millions) of LLM calls per day, Doris is massively
overprovisioned, and "you must run Doris" is the largest single cost of adopting self-hosted
memoturn.

Meanwhile, every memoturn install **already requires Postgres**. At small-install row counts
(tens of millions of telemetry rows and below), Postgres with partitioned tables handles the
entire `TelemetryStore` read surface comfortably — and with `pgvector`, the vector-similarity
surface too.

## Decision

**Ship a second `TelemetryStore` implementation backed by Postgres, selected by
`TELEMETRY_ENGINE` (`postgres` | `doris`), as a deployment profile — not a product tier.**

- **`TELEMETRY_ENGINE=postgres`** (small installs): telemetry tables live in the same Postgres
  instance the platform already requires (separate schema, migrations owned by
  `packages/telemetry` — *not* Prisma). The self-host footprint drops to Postgres + Redis + blob.
- **`TELEMETRY_ENGINE=doris`** (scale): today's path, unchanged. Remains the default for
  production-scale guidance and the hosted service.
- **Graduation is a defined, verifiable runbook** (mechanics in ADR-0004): the primary path is a
  seam-to-seam row copy with blob replay as fallback/audit, cut over with no API downtime. An
  install that outgrows the Postgres tier moves to Doris without an ad-hoc migration project.

Both implementations pass the same `conformance.test.ts`; the API, worker, and console are
unaware of the engine. This is a *profile* choice in config/compose, fully available in OSS —
not a paywall boundary.

The engine policy from `CLAUDE.md` is unchanged in spirit: all engine SQL stays inside
`packages/telemetry`; nothing above the seam may know which engine is running.

## Consequences

**Positive**

- Self-host footprint for small teams shrinks to infrastructure they already run and understand.
  Setup time, memory requirements, and operational surface all drop substantially.
- Zero lock-in at the low end: graduation to Doris is a defined runbook (ADR-0004), not an
  ad-hoc migration project.
- The conformance suite gains a second consumer, which hardens it as the real engine contract
  (per the stated engine policy) and de-risks any *future* engine work.
- CI can run the conformance suite against a Postgres service container cheaply — behavioral
  coverage that the Doris path (needing a live cluster) can't get in CI today.
- The Postgres tier gets exact **and optionally indexed** vector search via `pgvector` (HNSW),
  something the Doris unique-key tables cannot offer (ANN there is duplicate-key-only).

**Negative / cost**

- **Every new `TelemetryStore` method is now written twice.** TypeScript enforces interface
  completeness and conformance enforces correctness, but parity discipline is a permanent tax on
  telemetry-surface work.
- **Performance divergence at the margins.** A Postgres-tier install pushed past its envelope
  will be visibly slower on facet scans and dashboard queries. Requires honest sizing docs and a
  clear "when to graduate" signal (see below).
- The `postgres` profile needs `pgvector` available (extension check at migrate time; the docs'
  reference compose uses a pgvector-enabled image).
- A second dialect of the analytics query/filter builders (`filters.ts` / `query.ts`) must be
  maintained.

### Sizing guidance (to be documented alongside the Doris sizing doc)

- **Postgres tier comfortable:** up to roughly 10–50 M observation rows / low hundreds of GB,
  with time-based partitioning and BRIN indexes on timestamps. This covers the large majority of
  self-hosted installs.
- **Graduate to Doris when:** trace-list facets and dashboard-builder queries get slow, sustained
  ingest reaches thousands of rows/sec, retention needs run long at high volume, or embedding
  spaces grow past ~100 k vectors. The move is the ADR-0004 graduation runbook.

## Implementation plan

All work sits behind the existing seam; the Doris path is untouched throughout.

### Phase 1 — Postgres implementation of the seam
- `packages/telemetry/src/postgres/`: schema DDL + a `schema_migrations`-style ledger (mirroring
  `src/migrate.ts`), time-partitioned `traces` / `observations` / `scores` /
  `retrieval_documents` / `embeddings` tables in a dedicated schema.
- Write path: `insertRows` as batched multi-row `INSERT … ON CONFLICT (project_id, id) DO UPDATE
  … WHERE excluded.<seq> >= t.<seq>` — the same LWW semantics the Doris sequence column provides
  (sequence per ADR-0001's mirror versioning), idempotent under retries by construction.
- Read path: port the ~40 store methods. Straightforward mappings: `percentile()` →
  `percentile_cont() WITHIN GROUP`; Doris arrays → native PG arrays (the CAST-to-ARRAY gotcha
  does not exist here); `cosine_distance` k-NN → `pgvector` `<=>`. The one substantial piece is a
  PG dialect of the analytics query/filter builders.
- `Number(...)`-normalization at the store boundary applies identically (PG also returns bigints/
  numerics as strings through drivers).

### Phase 2 — Conformance parity
- Run `conformance.test.ts` against both engines; extend it wherever the two implementations
  could legally diverge (LWW edges, empty-facet behavior, percentile interpolation, similarity
  ordering). The suite — not either implementation — is the contract.
- Wire the Postgres conformance run into CI via a pgvector-enabled service container.

### Phase 3 — Profile plumbing
- `TELEMETRY_ENGINE` selection at the store construction site (worker + API/server); default
  remains `doris` until docs and sizing guidance land.
- A compose profile without Doris (and a matching `infra:*` variant); `setup` detects the profile
  and skips `db:telemetry`'s Doris migrations in favor of the Postgres ledger.
- Worker: the ADR-0001 mirror step writes through the same `insertRows` seam, so it works
  unchanged; verify the rehydrate path (which reads the settled row from the telemetry store)
  against the PG implementation.

### Phase 4 — Docs & guardrails
- Self-host docs: profile choice, sizing table, the graduation runbook (ADR-0004: seam-to-seam
  copy + verification, with blob replay as fallback), `pgvector` requirement.
- A CI/hook check that both engine directories are exercised by conformance (absence-of-parity
  guard), in the spirit of `rbac:check` / `docs:check`.
- Update `docs/architecture.md`, `CLAUDE.md` (engine policy section), and run
  `bun run docs:check`.

**Rollback:** the profile defaults to Doris; the Postgres implementation is additive and
removable. Blob remains the replay source of truth in both directions.

## Alternatives considered

- **Keep Doris-only (do nothing).** The status quo, and correct until the trigger fires. Costs
  nothing but leaves the self-host footprint objection unanswered.
- **A different second engine (StarRocks, ClickHouse, Pinot, Druid).** All answer "what if we
  must leave Doris," not "how do small installs avoid running a big analytical engine at all" —
  each is a comparable or heavier operational dependency, so none reduces footprint. (For the
  contingency question: StarRocks is the closest technical substitute — MySQL protocol, primary-
  key LWW tables, near-identical Stream Load — but is not ASF-governed; ClickHouse's
  `ReplacingMergeTree(ver)` maps well but is single-vendor; Pinot has real upserts but no MySQL
  protocol and heavier ops; Druid lacks a workable upsert model for the LWW semantics. Recording
  here so the ranking survives; no action implied.)
- **Embedded engines (DuckDB / chDB) for the small tier.** Genuinely tiny footprint, but weak
  concurrent-writer and upsert-at-scale stories, and they add a *new* dependency rather than
  reusing one — Postgres is already in every install and is boring in the best way.
- **Doris "lite" (single combined FE/BE container, tighter memory caps).** Already done for dev
  (single-home compose + memory caps); it reduces but does not remove the fundamental footprint
  and operational unfamiliarity. Complementary, not sufficient.
- **Gate the Postgres tier as a paid/enterprise boundary.** Rejected on policy: deployment
  profiles are OSS; the project does not build pricing infrastructure ahead of need.

## Trigger

Execute the plan when any of these is true:

1. Self-host adoption friction is observed and attributable to the Doris requirement (issues,
   discussions, or install-drop-off naming it), **or**
2. A deliberate self-host adoption push is planned and wants the lighter footprint as part of the
   story, **or**
3. The conformance suite needs a second implementation anyway (e.g., an engine contingency from
   the alternatives above becomes live).

The plan was executed on trigger 2 (a deliberate self-host push) — see below.

## Implementation status

Fully implemented and merged (2026-07-23):

- **Phase 1 — Postgres implementation** (#178, #179): DDL in `infra/postgres-telemetry/`
  (`telemetry` schema, PKs = the Doris UNIQUE KEYs, `timestamp(3)` UTC-naive columns,
  dimensionless pgvector `vector`, safe-JSON accessors via `pg_input_is_valid`); chunked
  LWW upserts (`ON CONFLICT … WHERE excluded.event_ts >= t.event_ts`, with mandatory
  in-batch PK dedup — PG rejects duplicate keys per statement where Doris merges); a
  mysql2-style `?` placeholder shim; the full ~35-method read port including the
  filter/analytics compiler dialects.
- **Phase 2 — conformance parity** (#179): suite green on **both** engines and extended
  with the cross-engine edges (equal-`event_ts` tie → later write wins, in-batch duplicate
  keys, nonzero `error_rate` guarding integer division, malformed-metadata JSON filters);
  percentile assertions pinned to inequalities. The suite caught one real bug during the
  port (`IN (?)` expansion parenthesization → record comparison).
- **Phase 3 — profile plumbing** (#181): `doris` compose profile + `scripts/infra.ts`
  (dev), `infra/docker-compose.prod.postgres.yml` overlay (prod, `!override` deps),
  pgvector images everywhere, `wait-for-infra` engine awareness, and CI running the
  conformance suite against **both** engines on every PR. End-to-end verified: the full
  product (ingest → worker merge/mirror → API reads) ran against a Doris-free stack.
- **Phase 4 — docs**: this PR (deployment/configuration/architecture + CLAUDE.md engine
  policy + docs-site mirror).
- **ADR-0004 groundwork** (#180): `scanRows` on both engines with a round-trip
  conformance case; the `telemetry:migrate` CLI remains open (tracked for when the first
  real graduation approaches).
