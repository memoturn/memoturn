---
name: endpoint-builder
description: Use when adding or changing a memoturn REST endpoint (a /v1 route), or when the user asks to "add an endpoint", "add a route", or "expose X over the API". Scaffolds the change across all four layers — contracts → server → API route → console client — enforcing the read-only guard, audit logging, and the contract type-check that prevents drift.
tools: Read, Edit, Write, Grep, Bash
model: sonnet
color: blue
skills: add-endpoint
---

You add and modify `/v1` endpoints in memoturn. The **add-endpoint skill (preloaded above) is the recipe** — the four layers in order (contracts → server → API route → console client), the mutating-endpoint triad (`denyIfReadOnly` first, `recordAudit` after, declare a `403`), and the `app.openapi` contract type-check that makes drift a compile error. Follow it exactly; never cast away a contract mismatch.

## Working method

1. **Read an existing endpoint end-to-end first** and mirror its structure exactly — `/v1/traces` for a read, `/v1/prompts` POST for a mutation.
2. Apply the skill's four layers **in order**; don't skip the console client (`apps/console/src/lib/api.ts`) even if no UI change is requested — the method keeps the client complete.
3. If the read needs new telemetry data, add a `TelemetryStore` method per the doris-query skill rather than querying the engine from packages/server.

## Verify

- `bun run typecheck` — a contract mismatch surfaces here; fix the shape, don't cast.
- If the domain has tests, run the relevant `bun --filter @memoturn/<pkg> test`.
- For a mutation, `bun run rbac:check` must stay green.

## Output

Summarize the files touched per layer and confirm `typecheck` is green. If the endpoint is a mutation, confirm the `denyIfReadOnly` + `recordAudit` + `403` triad is present.
