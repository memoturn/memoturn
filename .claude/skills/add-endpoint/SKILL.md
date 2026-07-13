---
name: add-endpoint
description: How to add or change a memoturn REST endpoint (a /v1 route) across the contracts → server → API → console layers, with the read-only guard and audit logging for mutations. Use when implementing a new API endpoint or extending an existing one in this repo.
---

# Add a memoturn endpoint

memoturn threads **one** Zod contract through four layers so types can't drift. `app.openapi` type-checks `c.json(...)` against the response schema — a server result that doesn't match the contract is a **compile error**. That's the drift guard; never cast it away.

## Read endpoint

1. **Contract** — `packages/contracts/src/index.ts`: add the Zod schema and export both it and its `z.infer` type.
2. **Server** — `packages/server/src/<domain>.ts`: implement the query; its return type is the inferred contract type. Telemetry reads go through a `TelemetryStore` method from `@memoturn/telemetry` (see the `doris-query` skill for adding one); Postgres reads use Prisma.
3. **Route** — `apps/api/src/app.ts`: `app.openapi(createRoute({ method, path, responses: { 200: { ...schema: C.<schema> } } }), handler)`. Add `app.use("/v1/…", requireAuth)`.
4. **Console** — `apps/console/src/lib/api.ts`: add the method; types come from the contracts re-export. No new console interfaces.

## Mutating endpoint

Everything above, plus in the handler:

1. `denyIfReadOnly(c)` **first** (`apps/api/src/middleware/auth.ts`) — `VIEWER` is read-only → `403`.
2. Call the server mutation.
3. `recordAudit(projectId, actor, action, target)` (`packages/server/src/audit.ts`) **after**.
4. Declare a `403` response in the route.

## Verify

- `bun run typecheck` — contract mismatches surface here; fix the shape, don't cast.
- Mirror an existing endpoint: `/v1/traces` (read), `/v1/prompts` POST (mutation).

For a multi-file build with a verification loop, delegate to the **endpoint-builder** agent.
