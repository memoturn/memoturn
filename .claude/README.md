# Claude Code setup for memoturn

Team-shared [Claude Code](https://code.claude.com/docs) configuration for this monorepo: agents, skills, hooks, and drift checkers that encode memoturn's recurring, error-prone workflows and keep docs/code in sync. Everything here is committed; personal settings live in the git-ignored `settings.local.json`.

## Agents (`agents/`)

Delegated subagents for multi-file work that benefits from its own context. Invoke with `@<name>` or let Claude route to them by description.

| Agent | Model · color | Use it for |
| --- | --- | --- |
| `doc-sync-auditor` | sonnet · cyan | Sweep docs vs. code, run `docs:check`, fix stale docs (incl. the hand-checked `app.ts` → `docs/api.md` tables). |
| `endpoint-builder` | sonnet · blue | Add/change a `/v1` endpoint across contracts → server → API route → console client, with the read-only guard + audit. |
| `prisma-migrator` | sonnet · green | Change `schema.prisma`: the `Project` reverse-relation rule, migrate with env loading, regenerate, typecheck. |
| `ingest-syncer` | opus · purple | Change an ingest event shape, keeping `events.ts` ↔ `mappers.ts` ↔ ClickHouse SQL ↔ tests aligned. |
| `rbac-auditor` | sonnet · red | Run `rbac:check` and fix confirmed gaps (mutating routes missing `denyIfReadOnly` + `403`). |
| `tdd-engineer` | sonnet · yellow | Build/change logic test-first (red → green → refactor) in core/server/worker. |

## Skills (`skills/`)

Knowledge-first recipes loaded on demand, usable in the main thread or by the agents above.

| Skill | Covers |
| --- | --- |
| `add-endpoint` | The 4-layer endpoint recipe + the `app.openapi` contract type-check as the drift guard. |
| `change-prisma-schema` | Prisma 7 driver-adapter workflow, `Project` reverse relation, migrate/generate/typecheck. |
| `ingest-event-change` | The files that move together for an ingest shape change; ReplacingMergeTree `event_ts`. |
| `clickhouse-query` | Parameterized queries, `FINAL`, `Number(...)` string-count coercion, `project_id`-first sort keys. |
| `console-feature` | apps/console: file-based routes, the typed `api.ts` client, TanStack Query + cache invalidation. |
| `add-evaluator` | LLM-as-judge config, online vs offline, deterministic FNV sampling, never-fail-ingest, `EVAL` write-back. |
| `model-registry` | The USD-per-1M-token cost registry, first-match-wins ordering, per-project overrides. |
| `add-mcp-tool` | The `ToolDef` registry, plain JSON Schema, handlers into `@memoturn/server`, stderr-only logging. |
| `sync-docs` | The doc↔code coupling map and how to run/fix drift. |

## Hooks (`hooks/`, wired in `settings.json`)

| Hook | Event | Behavior |
| --- | --- | --- |
| `guard-generated.ts` | PreToolUse (Edit/Write) | Blocks edits to generated/immutable files: `routeTree.gen.ts`, `packages/db/prisma/migrations/**`. |
| `doc-drift-reminder.ts` | PostToolUse (Edit/Write) | When an edited file is coupled to hand-maintained docs (per `doc-coupling.json`), injects a reminder to update them. |

`doc-coupling.json` is the manifest the reminder hook reads — code paths → coupled docs + next-step notes.

## Drift checkers (`scripts/`, in the repo root)

Deterministic, read-only, exit non-zero on drift — safe to wire into lefthook pre-push or CI.

| Command | Checks |
| --- | --- |
| `bun run docs:check` | Docs match code: script names, dev credentials, ports, worker crons, MCP tool names. |
| `bun run rbac:check` | Every mutating `/v1` route enforces `denyIfReadOnly(c)` + a `403` (or is `// rbac-exempt`-marked). |

## Conventions

- **Code is the source of truth; docs follow.** When a checker flags drift, fix the doc to match the code.
- Hook scripts are Bun TS run via `bun "$CLAUDE_PROJECT_DIR/.claude/hooks/<file>.ts"`.
- Adding an agent/skill: drop a `*.md` (agents) or `<name>/SKILL.md` (skills) with frontmatter; no registration needed. Keep this README's roster in sync.
