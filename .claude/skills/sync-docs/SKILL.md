---
name: sync-docs
description: How memoturn keeps hand-written docs in sync with code — the coupling map between code facts and docs, how to run the drift checker, and how to fix drift. Use when editing package.json scripts, ports, dev credentials, worker crons, /v1 routes, or MCP tools, or when asked to check/update the docs.
paths: docs/*.md, apps/docs/src/content/docs/**
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
| `docs/*.md` content | apps/docs/src/content/docs/*.md site mirror (checked by hand, not by the script) |
| `apps/mcp/README.md` + `packages/server/src/mcp-tools.ts` + `apps/api/src/mcp.ts` | apps/docs/src/content/docs/mcp.md (no docs/mcp.md exists) |

## Rule

**Code wins; docs follow.** When `docs:check` flags drift, read the code, then edit the doc to match — never the reverse. Re-run `bun run docs:check` until green, then `bun run format`.

The drift checker covers five mechanical couplings; two are hand-checked only:

- `app.ts` → `docs/api.md` endpoint tables — review when routes change.
- `docs/*.md` → the **docs-site mirror** (`apps/docs/src/content/docs/`) — when a feature lands in
  a source doc, the site page must be resynced by hand (whole-body replace, not line patches).
  On site pages the script only validates the five mechanical facts, so content staleness is silent.

## Site mirror conventions

Site pages = Starlight frontmatter (`title`/`description`, kept — update `description` only if the page's scope materially changed) + the source body minus its `# H1`, with these adaptations: `./x.md` → `/x/` links (anchors `→ /x/#y`), repo-file refs → GitHub blob links, mermaid → ASCII (no mermaid plugin), images `./images/*` → `../../assets/screenshots/*` (omit if missing; keep site-only screenshot enrichments), and **no competitor names on public pages** (neutralize, don't copy — docs/roadmap.md's Horizon-3 intro is the known case). Two exceptions: `mcp.md` has no `docs/` source — it mirrors `apps/mcp/README.md` + `packages/server/src/mcp-tools.ts` + `apps/api/src/mcp.ts` (incl. the OAuth story in `packages/server/src/betterauth.ts`); and site-only pages (`index.mdx`, `use-cases.mdx`, `getting-started.mdx`) are adaptations, not mirrors — leave their structure alone, only fix factual drift. Verify with `bun --filter @memoturn/docs build` (must exit 0, all pages).

For a full sweep-and-fix pass (mechanical + site parity), delegate to the **doc-sync-auditor** agent.
