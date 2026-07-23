---
name: sdk-change
description: How to change the memoturn SDKs (sdks/js, sdks/python, sdks/go) — the per-SDK isolation discipline (one branch/PR per SDK, no cross-SDK files), how the wire contract flows from packages/core, version-parity couplings, and release mechanics. Use when adding an SDK feature, porting a change across SDKs, or fixing an SDK bug.
paths: sdks/**
---

# Change a memoturn SDK

Three SDKs live in-repo: **`sdks/js`** (`@memoturn/sdk`, npm), **`sdks/python`** (`memoturn`, PyPI, `src/memoturn/` layout), **`sdks/go`** (`github.com/memoturn/memoturn/sdks/go`). All speak the same wire contract: the Zod ingest event schemas in `packages/core/src/events.ts` (`POST /v1/ingest`, Basic auth `publicKey:secretKey`). The JS SDK shares the workspace types; Python and Go mirror the shapes by hand — a wire change must be ported to each.

## Isolation discipline (hard rule)

- **One branch + one PR per SDK**, cut from `main` — never mix files from two SDKs in one PR. For parallel work use per-SDK worktrees.
- Cross-SDK consistency comes from a **shared spec in the PR descriptions** (same feature described identically), not shared commits.
- In fresh agent worktrees, verify lefthook actually ran (typecheck/rbac/docs pre-push) before trusting a push — hook installs don't always carry over.

## Parity + couplings

- Feature parity is tracked SDK-by-SDK: wrappers (Anthropic, Bedrock, Gemini, Groq, …), guardrails, trace-context helpers, dataset/prompt clients. When adding a capability to one SDK, note the parity gap for the others (separate PRs).
- `bun run docs:check` enforces **version parity**: `sdks/js/package.json` version, `sdks/python/pyproject.toml` ↔ `src/memoturn/__init__.py` `__version__`, and the versions restated in docs. A version bump that misses one fails the checker.
- Each SDK has its own README + `docs/sdk-*.md` page (and the docs-site mirror) — update them with behavior changes (see the sync-docs skill).

## Verify

- JS: `bun --filter @memoturn/sdk test` (or `cd sdks/js && bunx vitest run`), plus `bun run typecheck`.
- Python: `cd sdks/python && uv run pytest`.
- Go: `cd sdks/go && go test ./...`.
- End to end: `bun run quickstart` (JS) emits a sample trace against the dev stack.

## Gotchas

- A breaking wire change starts in `packages/core/src/events.ts` — that's the ingest-event-change skill's territory; the SDK PRs follow it, one per SDK.
- Releases publish npm + PyPI + Go tag together with the server images — don't ship an SDK version bump outside a release PR.
