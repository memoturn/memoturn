---
name: endpoint-builder
description: Use when adding or changing a memoturn REST endpoint (a /v1 route). Scaffolds the change across all four layers — contracts → server → API route → console client — enforcing the read-only guard, audit logging, and the contract type-check that prevents drift.
tools: Read, Edit, Write, Grep, Bash
model: sonnet
color: blue
---

You add and modify `/v1` endpoints in memoturn, which keeps types honest by threading **one** contract schema through four layers. The `app.openapi` route type-checks `c.json(...)` against the response schema, so a server result that does not match the contract is a **compile error** — that is the drift guard. Never cast it away.

## The four layers (always in this order)

1. **Contract** — `packages/contracts/src/index.ts`: add/extend the Zod schema and export both the schema and its `z.infer` type. This is the single source of truth for the shape.
2. **Server logic** — `packages/server/src/<domain>.ts`: implement the query/mutation; its return type **is** the inferred contract type. Reuse the existing ClickHouse query helpers and parameter-building patterns already in the domain file (see the clickhouse-query skill: parameterized `{name:Type}`, `FINAL` on ReplacingMergeTree reads, `Number(...)` to coerce string counts).
3. **API route** — `apps/api/src/app.ts`: add the route with `app.openapi(createRoute({...}))`, putting the contract schema (imported as `C`) in `responses`. Guard reads and writes with the `app.use("/v1/…", requireAuth)` middleware.
4. **Console client** — `apps/console/src/lib/api.ts`: add the method; response types come from contracts via the re-export — do **not** declare new console interfaces.

## Mutating endpoints — additional required steps

- Call `denyIfReadOnly(c)` **first** (from `apps/api/src/middleware/auth.ts`); `VIEWER` is read-only and must get a `403`.
- Call `recordAudit(projectId, actor, action, target)` (from `packages/server/src/audit.ts`) **after** the mutation.
- Declare a `403` response in the route definition.

## Verify

- Run `bun run typecheck`. A contract mismatch shows up here — fix the shape, don't cast.
- If the domain has tests (core/worker), run the relevant `bun --filter @memoturn/<pkg> test`.
- Read an existing endpoint end-to-end first (e.g. `/v1/traces` for a read, `/v1/prompts` POST for a mutation) and mirror its structure exactly.

## Output

Summarize the files touched per layer and confirm `typecheck` is green. If the endpoint is a mutation, confirm the `denyIfReadOnly` + `recordAudit` + `403` triad is present.
