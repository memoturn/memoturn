# Changelog

Notable changes to Memoturn. Full commit-level detail lives in the
[GitHub releases](https://github.com/memoturn/memoturn/releases) (auto-generated
notes per tag) and the git history.

Versioning covers the platform (API, worker, console, container images) and the
SDKs (`@memoturn/sdk` on npm, `memoturn` on PyPI, `sdks/go` module), which are
released together from `v*` tags.

## [Unreleased]

Production-readiness tranche, phase 0 (see the audit plan for the full picture).

- **Breaking — API keys no longer act as OWNER.** A key's role is derived from its scopes:
  the default `read`/`write`/`ingest` key acts as MEMBER; only a key minted with the new
  explicit `admin` scope acts as OWNER on admin-only routes (project delete/rename,
  membership, DLQ replay, key management). Minting, listing, and revoking keys is now
  admin-only. Automations that used a default key against those routes need an `admin`
  key (`bun run seed` gives the dev key `admin`). This closes a MEMBER→OWNER escalation.
- **Playground and assistant are write-gated.** `/v1/playground/*` and `/v1/assistant/*`
  spend the project's provider key, so VIEWERs (including public-demo sandboxes) now get
  403. Both streaming routes validate their bodies like the OpenAPI routes; `maxTokens` is
  capped by `PLAYGROUND_MAX_TOKENS` (default 32768).
- **Ingest error contract.** Every API error is JSON `{ error, requestId }`; a blob-store or
  queue outage on `/v1/ingest` returns `503` + `Retry-After` (SDKs re-send) instead of a
  plain-text 500; a blob written before a failed enqueue is removed. Every request carries
  an `x-request-id` (inbound honoured, else minted) that is echoed, logged, and stamped on
  the ingest job so API and worker log lines correlate.
- **SDKs (JS, Python, Go): request-sized flushes.** A large buffer is sent as several
  `POST /v1/ingest` calls of ≤1000 events / ~10 MB (the API's limits) — previously a buffer
  that grew past 1000 events during an outage was rejected as one over-limit request and
  dropped. Background flushes back off exponentially with jitter and honour `Retry-After`;
  the JS SDK gains opt-in `flushOnSignals`.
- **Helm chart works as shipped:** the worker binds `0.0.0.0` so probes pass (it
  CrashLooped before), a worker Service + `WORKER_METRICS_URL` wire the ingest-health
  panel, OAuth discovery paths route to the API, `terminationGracePeriodSeconds` is set,
  and `Chart.yaml` tracks the release version (enforced by `docs:check`; linted in CI).
- **Worker shutdown** closes the evaluator-backfill worker too and force-exits after
  `WORKER_SHUTDOWN_TIMEOUT_MS` instead of hanging past the orchestrator's grace period.
- **Compose hardening.** The single-VM stack pins MinIO/mc/Caddy tags, rotates json-file
  logs, sets memory limits and a worker `stop_grace_period`, and passes through
  `RATE_LIMIT_TRUSTED_PROXIES`, `API_METRICS_TOKEN`, `MCP_RATE_LIMIT_PER_MINUTE`,
  `TELEMETRY_STREAM_LOAD` (ingest-event budget defaults on). The plain
  `infra/docker-compose.yml` no longer publishes the API on every interface without TLS.
- **Startup guard** refuses to boot in production with `ALLOW_PRIVATE_WEBHOOK_TARGETS=1`
  (unless `..._ACK=1`) or `AUTH_RATE_LIMIT_DISABLED`, and announces `DEMO_MODE` loudly.
- Docs: `AUTH_BASE_URL` is the origin (no `/api`); rate-limit defaults corrected; console
  image now sets its own CSP/security headers so Kubernetes deployments keep them.

Production-readiness tranche, phase 4 (test + CI coverage).

- The authenticated API route suite now runs in CI (it gated on `DORIS_HOST`, which the
  build job deliberately unset — only the three no-infra cases had ever executed); the full
  suite also runs on the Postgres telemetry tier, and the store conformance suite fails
  rather than skips when no engine answers in CI.
- New unit tests for the Redis lock, retention, deletion lifecycle, project deletion, DLQ
  tenant scoping, and batch actions; console e2e specs for the admin-only API-keys tab,
  the hard-cap budget switch, and the ops page (`--passWithNoTests` removed).
- `scripts/load/ingest.k6.js` + a nightly ingest load workflow (non-blocking trend: p95 ack,
  req/s, queue depth, insert latency).
- `docs:check` requires a `## [version]` changelog entry for the current package version;
  the missing 0.6.0 entry is added.

Production-readiness tranche, phase 3 (tenant isolation + abuse controls).

- **DLQ views are project-scoped**: `/v1/ingest/health` and `/v1/ingest/dlq/replay` see and
  replay only the caller's project (the operator CLI stays global).
- **Hard cost caps**: a budget can refuse spend (402) once month-to-date cost reaches it —
  playground, assistant, evaluators, experiments all pass through the gate (`hardCap` on
  `PUT /v1/budgets`, checkbox in Settings → Alerts).
- **Rate limits on by default** (600 req/min, 60000 events/min per project; `0` disables) and
  now also applied to the remote MCP endpoint per project.
- **Auth defaults**: email verification required by default in production when a mailer is
  configured; password sign-in and 2FA code checks get brute-force sub-limits
  (`AUTH_SIGNIN_MAX_PER_15M`); unauthenticated OAuth client registration is throttled;
  organizations can require 2FA (`{"requireTwoFactor": true}` in org metadata → 403 until
  enrolled); unknown IdP roles resolve to VIEWER; `API_KEY_DEFAULT_EXPIRY_DAYS`.
- **Secrets at rest**: scrypt-derived keys, `v2.<keyId>.…` envelopes, an `ENCRYPTION_KEYS`
  ring with dual-read, and `bun run rotate-secrets` — rotation no longer invalidates stored
  keys. Webhook signing secrets are now encrypted (legacy plaintext rows migrate on use).
- **Error hygiene**: internal error text (drivers, hosts, paths) is no longer echoed to
  clients; `API_DOCS_PUBLIC=false` puts the OpenAPI docs behind auth; blob keys reject `..`;
  LLM-judge prompts fence the traced content as data, not instructions.

Production-readiness tranche, phase 2 (data durability + lifecycle).

- **Blob replay tool** (`bun run replay`): rebuilds or backfills the telemetry store from the
  raw event log — the disaster-recovery path the backup strategy always relied on but never
  had. Replayed batches skip usage metering and online evaluators.
- **Backups verify themselves and cover Redis**: `pg_dump -Fc` checked with `pg_restore --list`,
  an RDB snapshot (the DLQ lives there), blob mirror object counts compared; new
  `scripts/restore.sh` restores all three and runs the replay. `docs/runbooks.md` added.
- **Deletion is now complete.** Deleting a project or an organization purges its telemetry
  rows AND every blob object under its prefixes (previously the raw, unmasked event log was
  orphaned forever). Deleting traces (batch action, new `DELETE /v1/traces/{id}`) also removes
  the Postgres state mirror rows and offloaded payload objects. New admin-only
  `DELETE /v1/users/{userId}/data` implements right to erasure for an end user of the traced
  application (`TelemetryStore.deleteByUserId`, both engines, conformance-tested).
- **Retention reaches the state mirror** and honours a new instance-wide ceiling
  (`TELEMETRY_MAX_RETENTION_DAYS`); the hourly state prune is chunked so it converges on
  large tables instead of timing out every run.

- **Doris tables are partitioned.** Fresh installs create `traces`/`observations`/`scores`
  AUTO-partitioned by day (time-range queries prune; `TELEMETRY_MAX_RETENTION_DAYS` maps to
  Doris's native partition TTL). Existing installs convert with the new
  `bun run telemetry:repartition` (month-chunked copy, count verification, atomic swap,
  `--set-replication N` for multi-BE clusters, `DORIS_REPLICATION_NUM` for new DDL). The
  worker now pins a row's time column for the life of the entity and clamps far-future
  timestamps, which the partition key relies on. The migrator warns on every deploy until
  legacy tables are converted.

Production-readiness tranche, phase 1 (operability).

- **Typed environment validation.** Every knob the API/worker read is declared with its
  shape; a malformed value (`WORKER_CONCURRENCY=ten`) fails at boot instead of becoming
  `NaN`, and in production the datastore URLs/credentials are required (their code
  fallbacks are dev-only). A public https `AUTH_BASE_URL` without `NODE_ENV=production`
  refuses to start (every production protection keys on it). The Better Auth secret is
  resolved at point of use so no process can sign a session with the dev fallback.
- **Readiness probes.** `GET /ready` on the API and the worker pings Postgres, Redis, the
  telemetry store, and the blob bucket (2 s each, cached 5 s) and answers 503 when any is
  down; the Helm chart's readiness probes use it. `/health` stays pure liveness.
- **Prometheus exposition.** `/metrics` on both services renders `text/plain; version=0.0.4`
  when the scraper asks for it (`Accept: text/plain` / `?format=prometheus`) — request
  counts, status classes, per-route latency percentiles, queue depths, DLQ depth, insert
  latency, worker counters. JSON stays the default. `LOG_LEVEL` gates structured logs.
- **Worker lifecycle.** Ingest jobs get a 60 s lock (`INGEST_LOCK_DURATION_MS`) and
  experiments/backfills 10 min (`LONG_JOB_LOCK_DURATION_MS`) instead of BullMQ's 30 s; a
  missing or malformed blob dead-letters on the first attempt (`UnrecoverableError`) instead
  of burning eight retries; the DLQ logs an error past `DLQ_ALERT_DEPTH`; DLQ replay is
  serialized by a Redis lock (409 when one is running), skips active jobs, and pages instead
  of loading the whole queue.
- **Pools + timeouts.** `PRISMA_POOL_SIZE`, `DORIS_POOL_SIZE`, `TELEMETRY_PG_POOL_SIZE` and
  connect timeouts are configurable; Doris sessions get `query_timeout`
  (`DORIS_QUERY_TIMEOUT_S`, 60) and Postgres-tier sessions `statement_timeout`; non-streaming
  `/v1` requests answer 504 past `API_REQUEST_TIMEOUT_MS` (60 s); `/auth/*` bodies are
  capped at 256 KB; open SSE streams are capped per project across replicas
  (`SSE_MAX_STREAMS_PER_PROJECT`, 20 → 429).
- **Helm hardening.** Pods run as uid 1000 with all capabilities dropped and privilege
  escalation forbidden; the console's root filesystem is read-only; PodDisruptionBudgets
  for api/console; an api `preStop` sleep; the migrate Job has a deadline, TTL, and
  resources; an opt-in default-deny NetworkPolicy. The chart is published to
  `oci://ghcr.io/memoturn/charts` on every release.
- **Supply chain.** Every GitHub Action is pinned by commit SHA; images carry an SBOM and
  max-mode provenance; PR builds are Trivy-scanned (fixable OS-package findings fail; the images apply
  Debian/Alpine security updates at build time; application-library findings are reported)
  and the published `:latest` images are re-scanned weekly into the Security tab; `bun audit` runs
  in CI (advisory); the api/worker images drop devDependencies and non-runtime trees; the
  console's Caddy base is digest-pinned.

## [0.6.0] — 2026-09-04

- Release pipeline: multi-arch (amd64 + arm64) container images built on native runners and
  joined into one manifest list per service; the JS SDK is published with an explicit
  `--tag latest`.
- Tracing UI/UX tranche: sortable trace-list columns with input/output previews, trace
  explorer deep links, waterfall metrics + scores, a trace Log view with in-trace search,
  corrected-output annotations on generations, a role-aware session conversation view, and
  saved views v2 (shareable `viewId` URLs, full-state capture).
- Models + demo: current-generation model registry; richer demo telemetry (7 scenario
  archetypes with threads, guardrails, and agent trees); the trace-volume histogram spans
  the selected range and dashboard bar charts show every label.
- OTel: a trace is named from its root span, not whichever span arrived first.
- Analytics: env-gated GA4/GTM across marketing, docs, and the demo console with Consent
  Mode v2, consent banners, a privacy page, and UTM conventions.
- Fixes: the demo worker receives `AUTH_BASE_URL` so first-visit magic links no longer
  point at localhost.

## [0.5.0] — 2026-08-02

- Postgres telemetry tier (ADR-0002): `TELEMETRY_ENGINE=postgres` runs the whole
  platform Doris-free — telemetry lives in the OLTP Postgres (`telemetry` schema,
  pgvector) for small installs, with the conformance suite green on both engines
  in CI and the `scanRows` bulk-copy seam (ADR-0004) as the graduation path to
  Doris at scale.
- MCP: both servers (local stdio and the remote per-project Streamable HTTP
  endpoint) now speak the stateless `2026-07-28` protocol revision (SEP-2575 —
  no initialize handshake, `server/discover`), running on the v2 TypeScript SDK;
  clients on earlier MCP revisions connect unchanged.
- Evaluation: conversation/agent metric templates, LLM juries, thread-scope
  online evaluators with cooldown, hierarchical session paths, and the `mt eval`
  CI-gate CLI in the JS SDK.
- Guardrails: restricted-topic and toxicity model guards.
- Observability: real-time live trace tail (SSE over Redis pub/sub),
  reasoning-step span kinds with a session Memory Explorer, and Claude Code
  OTel ingestion (token/cost accounting + named tool spans).
- Ingest controls: tail-sampling keep-rules at the ingest gate and volume-based
  usage metering (bytes/events/traces per project per day).
- Datasets & metrics: fine-tuning export with a tightened trace→dataset loop;
  project-wide cost-by-prompt breakdown.
- Automations: PagerDuty and email actions.
- Public demo at demo.memoturn.com: per-visitor sandboxes with realistic seeded
  telemetry, magic-link sign-in, and a 7-day TTL.
- Console: pretty-printed JSON, human-readable timestamps, a branded error
  boundary + 404, and list-page stat/layout polish.
- Primary domain is now memoturn.com (memoturn.ai redirects); single-VM
  production compose fixes (Better Auth routing, env passthrough, worker health).

## [0.4.0] — 2026-07-22

- Auth: enterprise hardening pass and OAuth 2.1 provider migration for the remote
  MCP endpoint (mandatory PKCE, dynamic client registration, rotating refresh tokens).
- Mutable-state rework (ADR-0001): Postgres is now authoritative for mutable
  trace/observation/score state; the analytical store is a pure mirror, with
  prune + rehydrate crons replacing read-merge and the entity lock.
- SDK integrations tranche: streaming-capture fixes, sync guardrails, and
  auto-instrumentation/wrappers for Gemini, Bedrock Converse, Groq, Mistral,
  Cohere, LlamaIndex, LangGraph, CrewAI, Haystack, MCP client/server, and the
  Chroma/Weaviate/Qdrant/Pinecone vector stores (JS + Python).
- Public sites: dark-first rebrand of memoturn.ai and docs.memoturn.ai with real
  console captures; docs site brought to parity with the in-repo docs.
- Public-release hardening: security headers + enforcing CSP on the docs site,
  immutable caching for hashed assets, edge-cached marketing HTML, deploy smoke
  tests; SEO/GEO scaffolding (robots, sitemaps, `llms.txt`, JSON-LD, canonical).
- Self-hosting: the documented compose path now boots (secrets wired, one-shot
  migrate service); the console image serves the built SPA from Caddy instead of
  `vite preview` (~101 MB, non-root); all images gained `HEALTHCHECK`s.
- Docs: new security-hardening checklist, operator upgrade runbook, Doris sizing
  guidance, and a complete environment-variable reference.
- Release engineering: CHANGELOG, auto-generated GitHub release notes on tags,
  LICENSE bundled in the Python/PyPI and Go SDK artifacts.

## [0.3.0] — 2026-07-17

- Dashboards: analytics query engine, chart library, Explore builder, saved
  named dashboards with resizable grid widgets and per-widget filters.
- Monitoring: Monitors UI, stateful alert rules, metric anomaly detection
  (rolling-baseline z-score), and cost budgets.
- Tracing: agent graph view, TOOL/AGENT observation types, split-view trace
  detail, side-by-side and per-observation trace-compare diffs, semantic
  "find similar traces" (cosine search in the analytical store), and
  head-based trace sampling.
- Evaluation: complete RAG evaluator template set and OpenInference span-kind +
  retrieval-document ingestion over OTLP.
- Prompts: A/B experiments with weighted sticky splits and per-arm compare;
  cost attribution by prompt version.
- Console: in-app read-only AI assistant ("Ask AI"), 3D embeddings projection
  with cluster analysis, project lifecycle management, inline help.
- SDKs: initial Go SDK (tracing + prompts).

## [0.2.0] — 2026-07-13

- First public release: `@memoturn/sdk` on npm, `memoturn` on PyPI, and
  api/worker/console images on GHCR, published tokenless via OIDC Trusted
  Publishing on `v*` tags.
- Telemetry store cut over to Apache Doris behind the `TelemetryStore` seam,
  with a conformance suite as the engine contract and blob raw-event replay as
  the migration path.
- Self-host hardening: dead-letter queue with replay, per-table independent
  inserts, large-payload blob offload, Redis-locked maintenance crons,
  structured JSON logging, and token-gated metrics.

## [0.1.0] — 2026-06-26

- Initial release: async blob-first ingest pipeline (API → blob → worker →
  analytical store), traces/observations/scores model, evals with online
  sampling, prompt management, playground, datasets, OTel/LangChain/OpenAI
  ingestion, and the TanStack console.

[Unreleased]: https://github.com/memoturn/memoturn/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/memoturn/memoturn/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/memoturn/memoturn/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/memoturn/memoturn/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/memoturn/memoturn/releases/tag/v0.1.0
