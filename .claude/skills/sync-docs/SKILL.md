---
name: sync-docs
description: How memoturn keeps hand-written docs in sync with code — the coupling map between code facts and docs, how to run the drift checker, and how to fix drift. Use when editing package.json scripts, ports, dev credentials, worker crons, /v1 routes, or MCP tools, or when asked to check/update the docs.
---

# Keep memoturn docs in sync

memoturn has **no generated API docs** (Scalar/OpenAPI are runtime-only). `CLAUDE.md`, `README.md`, `CONTRIBUTING.md` and `docs/*.md` hand-restate concrete facts that live in code, so they drift. Two mechanisms catch it:

- **`bun run docs:check`** (`scripts/check-doc-drift.ts`) — deterministic checker, exits non-zero on drift.
- **The doc-drift-reminder hook** — after you edit a coupled file, it reminds you which docs to review (from `.claude/doc-coupling.json`).

## Coupling map (code → docs)

| Code (source of truth) | Docs that restate it |
|---|---|
| `package.json` scripts | CLAUDE.md, README.md, CONTRIBUTING.md, docs/getting-started.md |
| `scripts/seed.ts` dev creds | README.md, CLAUDE.md, CONTRIBUTING.md, docs/getting-started.md, docs/sdk-*.md |
| `.env.example` / `infra/docker-compose.dev.yml` ports | docs/configuration.md, docs/getting-started.md, CLAUDE.md |
| `apps/worker/src/index.ts` crons | CLAUDE.md |
| `packages/server/src/mcp-tools.ts` tool names | apps/mcp/README.md |
| `apps/api/src/app.ts` routes | docs/api.md tables (checked by hand, not by the script) |

## Rule

**Code wins; docs follow.** When `docs:check` flags drift, read the code, then edit the doc to match — never the reverse. Re-run `bun run docs:check` until green, then `bun run format`.

The drift checker covers five mechanical couplings; the `app.ts` → `docs/api.md` endpoint tables are not diffed automatically — review those by hand when routes change.

For a full sweep-and-fix pass, delegate to the **doc-sync-auditor** agent.
