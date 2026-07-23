<!-- Thanks for contributing to memoturn! Keep PRs focused; link the issue they resolve. -->

## What & why

<!-- A short description of the change and the motivation. Reference any issue: "Closes #123". -->

## Type of change

- [ ] Bug fix
- [ ] New feature
- [ ] Refactor / chore
- [ ] Docs
- [ ] Breaking change

## Checklist

- [ ] `bun run lint` passes (Biome)
- [ ] `bun run typecheck` passes
- [ ] `bun run test` passes (added/updated tests where it makes sense)
- [ ] Commits follow the conventional style (`feat(scope): …`, `fix(scope): …`, `chore: …`)
- [ ] For a new/changed `/v1` route: it enforces `denyIfReadOnly` + declares a `403` (mutations) — `bun run rbac:check`
- [ ] For changes to scripts/ports/creds/crons/routes/MCP tools: docs updated — `bun run docs:check`
- [ ] For an ingest-shape change: updated `packages/core/src/events.ts`, the worker mappers, and the Doris columns together

## Notes for reviewers

<!-- Anything non-obvious: trade-offs, follow-ups, areas to scrutinize. -->
