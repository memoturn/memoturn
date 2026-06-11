---
name: sync-docs
description: Update the published docs.memoturn.ai pages (docs/site) to match product changes since the last sync — env vars, CLI, HTTP API, MCP tools, SDKs, Helm.
disable-model-invocation: true
---

## Product changes since last sync

Last synced commit: !`cat docs/site/.docs-sync`

```!
git log --oneline $(cat docs/site/.docs-sync)..HEAD -- crates/ mcp/ sdk/ deploy/ examples/
git diff --stat $(cat docs/site/.docs-sync)..HEAD -- crates/ mcp/ sdk/ deploy/ examples/
```

## Task

Bring the published docs pages in `docs/site/src/content/docs/` up to date with the changes
above. If the log is empty, say so and stop.

Page map — which source surfaces feed which pages:

| Changed surface | Pages to check |
| --- | --- |
| `MEMOTURN_*` env vars (`crates/memoturnd/src/main.rs`) | `configuration.md`, `security.md` |
| CLI commands/flags (`crates/cli/src/main.rs`) | `cli.md`, `quickstart.mdx` |
| HTTP routes / auth (`crates/api`) | `api-rest.md`, `security.md`, `consistency.md` |
| MCP tools (`mcp/src`) | `mcp.md` |
| SDKs (`sdk/typescript`, `sdk/python`) | `sdk-typescript.md`, `sdk-python.md` |
| Helm chart / K8s (`deploy/helm`) | `deployment.md`, `scaling.md`, `observability.md` |
| Memory semantics (`crates/docstore`, esp. `memories.rs`) | `memories.md`, `recall.md`, `profiles.md`, `data-model.md` |
| Branching/replication (`crates/replication`) | `branching.md`, `consistency.md`, `architecture.md` |

Process:

1. For each commit above, read the actual diff to learn what the surface change was — don't
   guess from the commit message.
2. Update the mapped pages. Match each page's existing customer-facing voice; these pages are
   rewritten product prose, not copies of `docs/architecture/`. Never name competitors.
   `docs/architecture/` and `docs/adr/` are background reading, never sources to copy from.
3. Validate: `cd docs/site && npm run build` must pass.
4. Update the marker: `git rev-parse HEAD > docs/site/.docs-sync`.
5. Report: pages changed and why, plus anything needing a human call (pricing, roadmap,
   positioning claims) — flag those instead of writing them.

Deploying is a separate, user-triggered step (`cd docs/site && npm run deploy`) — do not deploy.
