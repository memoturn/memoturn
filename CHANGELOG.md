# Changelog

Notable changes to Memoturn. Full commit-level detail lives in the
[GitHub releases](https://github.com/memoturn/memoturn/releases) (auto-generated
notes per tag) and the git history.

Versioning covers the platform (API, worker, console, container images) and the
SDKs (`@memoturn/sdk` on npm, `memoturn` on PyPI, `sdks/go` module), which are
released together from `v*` tags.

## [Unreleased]

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
