# Changelog

All notable changes to Memoturn. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versions move in lockstep across the workspace crates, both SDKs, the MCP server, and the Helm
chart (see docs/development.md).

## [Unreleased]

## [0.1.0] — 2026-06-11

Initial prototype: typed agent memory (`namespace > profile > memory`, supersession, hybrid
recall, server-side extraction/ask as node opt-ins), multi-model substrate
(docs/KV/SQL/vectors/transcript) on embedded libSQL, object storage as source of truth, O(1)
manifest branching with burner branches and PITR, etcd writer leases with epoch fencing,
fail-closed auth with per-database/namespace JWTs, data governance (policies, audit streams,
verifiable erasure), CLI, TypeScript + Python SDKs, MCP server, Helm chart, runnable examples.

### Added

- Structured error codes: every error response is `{ "error": <message>, "code": <stable code> }`
  with 14 stable codes; SDKs expose `MemoturnError.code`, the CLI prints actionable hints.
- OpenAPI 3.1 spec (`docs/api/openapi.yaml`, published at docs.memoturn.ai/openapi.yaml) with a
  router drift-guard test.
- TypeScript SDK: automatic retries for transient failures (network, 502/503/504, 429 with
  `Retry-After`); `retries: 0` opts out.
- Python SDK: `AsyncMemoturn` async twin, `py.typed` + TypedDict results, context managers.
- CLI: `memoturn completions <shell>`, `memoturn init` first-run check, error hints;
  `memory erase --memory-id` (old `--memory` kept as alias).
- Local dev: `.env.example` covering every `MEMOTURN_*` var; `docker-compose.yml` multi-node
  cluster (etcd + MinIO + 2 nodes); `make check|fmt|venv|e2e|up|down|release-check`.
- CI: fmt/clippy/test, SDK + examples e2e against a shared node, MCP tests, docs build, helm lint.
- Docs: errors reference, troubleshooting, point-in-time recovery, and ask/answer-synthesis
  pages; READMEs for `examples/`, `docs/`, `mcp/`, `bench/`; `docs/development.md`.
