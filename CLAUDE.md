# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

memoturn is an open-source AI engineering platform (LLM observability, evals, metrics, prompt management, playground, datasets). Bun-native monorepo, OpenTelemetry-native, self-hostable. See `README.md` and `docs/` for product detail; this file covers what's needed to be productive in the code.

## Commands

```bash
bun run setup        # one-time: install + infra up + wait-healthy + Prisma migrate + Doris migrate + seed
bun run dev          # turbo: api (:3001) + worker + console (:3000), all with --watch (public sites excluded)
bun run dev:status   # turbo: confirm infra containers + api/worker/console dev servers are all up (per-app dev:status task)
bun run dev:site     # marketing site (:3003) + docs site (:4321)
bun run quickstart   # emit a sample trace via the SDK, then open http://localhost:3000

bun run lint         # Biome check (format + lint + import order); `bun run format` to auto-fix
bun run typecheck    # turbo: tsc --noEmit across packages
bun run test         # turbo: vitest (core + server + worker + telemetry have real tests)
bun run build        # turbo build (respects ^build dependency order)

bun run infra:up / infra:down / infra:logs / infra:status   # docker compose for PG/Doris/Redis/MinIO
bun run db:migrate   # prisma migrate deploy
bun run db:telemetry # apply Doris migrations (infra/doris; schema_migrations ledger)
bun run seed         # seed organization/project/dev API key
bun run seed:demo    # seed ~30 days of realistic demo telemetry via /v1/ingest (--days, --traces-per-day, --wipe, --dry-run); needs dev api+worker running
bun run dlq          # inspect the ingest dead-letter queue; `--replay` re-enqueues failed batches from blob
bun run deploy:site  # wrangler deploy of memoturn.ai + docs.memoturn.ai (Cloudflare Workers; per-app deploy:staging for staging)
```

Per-package: `bun --filter @memoturn/<name> <script>` (e.g. `bun --filter @memoturn/worker test`).
Single test: `bun --filter @memoturn/worker test -- mappers` or `cd packages/core && bunx vitest run events`.

After a Prisma schema change: `bun --filter @memoturn/db migrate:dev --name <change>`, then re-run typecheck — the generated client must be regenerated (also runs on `postinstall`).

Dev credentials: console login `admin@memoturn.dev` / `memoturn-dev-123`; SDK API key `pk-mt-dev` / `sk-mt-dev`; Scalar API docs at http://localhost:3001/docs.

## Architecture

The defining pattern is an **async, decoupled ingest pipeline** that splits storage by access pattern: relational metadata in **Postgres** (Prisma 7), high-volume telemetry in **Apache Doris**, raw replayable event log in **blob** (S3/MinIO), jobs in **Redis/BullMQ**.

```
SDK / OTel / LangChain / OpenAI
   │ POST /v1/ingest  (Basic auth = publicKey:secretKey)
   ▼
apps/api (Hono/Bun) ─ validate ─ write raw batch to blob ─ enqueue BullMQ job ─ 207 ack
   ▼
apps/worker (Bun) ─ re-read batch from blob ─ map ─ insert into Doris
   │                                         └─ run sampled online evaluators (best-effort)
   ▼
apps/console (SPA) ── TanStack Query ──► apps/api
```

Key consequence: the API **never writes telemetry synchronously**. It persists the raw batch to blob (the source of truth for replay) and acks 207; the worker does all telemetry-store work. Don't add direct Doris writes in the request path.

### Workspaces

- **`apps/api`** — Hono + `@hono/zod-openapi`. `src/app.ts` is the entire route surface; **handlers are thin** — they call into `@memoturn/server`. Same app is served by `server.bun.ts` (primary) and `server.node.ts`. Auth resolution in `src/middleware/auth.ts`. Global hardening middleware (applied at the top of `app.ts`): `secureHeaders` (X-Frame-Options/DENY, no-referrer, etc.), CORS scoped to `AUTH_TRUSTED_ORIGINS`, and request body-size limits (1 MB default, 12 MB for `/v1/ingest`, `/v1/otel/*`, and `/v1/media`). Observability (`src/metrics.ts`): a first middleware times every request and emits a structured JSON log line; in-process metrics (request counts, status classes, per-route latency percentiles bucketed by route pattern, in-flight gauge) are exposed at `GET /metrics` — token-gated (404 unless `API_METRICS_TOKEN` is set, then `Authorization: Bearer <token>`). `GET /health` is a public liveness probe.
- **`apps/worker`** — BullMQ consumers. `processors/ingest.ts` (merge → telemetry store + online evals), plus daily maintenance crons (retention sweep `0 3 * * *`, scheduled blob exports `0 4 * * *`, embedding-projection reduction `0 5 * * *`), an hourly mutable-state prune (`17 * * * *` — bounds the Postgres `*State` working set per ADR-0001), a per-minute alert-evaluation cron (`* * * * *` — stateful alert rules + cost budgets), and a health/metrics HTTP endpoint (`WORKER_PORT`, default 3002). `mappers.ts` converts ingest events → engine-neutral telemetry rows, including the computed `latency_ms` (has the only worker tests). Key hardening details: jobs that exhaust retries land in a **dead-letter queue** (`ingest-dlq`) for inspection/replay; each telemetry table (`traces`, `observations`, `scores`) is inserted **independently** so one table failure doesn't discard the others; large input/output payloads (> 256 KB) are **offloaded to blob** with a marker reference before insert; all log output is **structured JSON** (`logJson`); counters (`ingest_events_total`, `ingest_errors_total`, `ingest_rows_total`, `evaluator_runs_total`) plus `telemetry_insert` latency and `dlqDepth` are exposed in the `/metrics` JSON; retention and export crons are guarded by a **Redis lock** (`withLock`) to prevent concurrent runs across multiple worker replicas. Per-event token counts are clamped to `MAX_EVENT_TOKENS` (10 M) in `packages/core/src/models.ts` to prevent runaway cost inflation.
- **`apps/console`** — Vite + TanStack Router (file-based routes in `src/routes/`) + TanStack Query. `routeTree.gen.ts` is **generated** (`tsr generate`, runs in build/typecheck) — never edit it; it's gitignored from Biome.
- **`apps/web`** — public marketing site (memoturn.ai). TanStack Start (React SSR) + Vite + Tailwind 4, deployed as a Cloudflare Worker (`wrangler.jsonc`; staging via `CF_ENV=staging`). Dev port **3003**. The whole landing page is `src/routes/index.tsx`; shared design system from `@memoturn/ui`.
- **`apps/docs`** — public docs site (docs.memoturn.ai). Astro + Starlight, static-assets Cloudflare Worker. Dev port **4321**. Content in `src/content/docs/` mirrors the hand-written `docs/*.md` (which stay the source of truth — update both when product facts change).
- **`apps/mcp`** — stdio MCP server exposing prompts/datasets/review queues as tools for agent IDEs. Scoped to one project via a `MEMOTURN_PUBLIC_KEY`/`MEMOTURN_SECRET_KEY` pair (resolved through `@memoturn/server`). The tool registry lives in **`packages/server/src/mcp-tools.ts`** (plain JSON Schema, no zod coupling) and is shared with the remote HTTP endpoint; `index.ts` wires the low-level `Server` to stdio. **All logging goes to stderr** — stdout is the JSON-RPC channel. The same registry is also served over **Streamable HTTP** by the API at `/v1/mcp/:projectId` (per-project resource; own API-key Basic auth + per-tool RBAC in `apps/api/src/mcp.ts`, via `@hono/mcp`) — don't add a `requireAuth` guard there, its method-based scope gate can't distinguish read tools from writes (every call is a POST).
- **`packages/server`** — all business logic, one file per domain (`traces`, `metrics`, `prompts`, `datasets`, `evaluators`, `review`, `export`, `playground`, `retention`, `webhooks`, `audit`, `auth`, `betterauth`, `ingest`, `otel`, `providers`). Shared by the API and (for some) the worker.
- **`packages/core`** — wire contracts. `src/events.ts` holds the Zod ingest event schemas (shared by SDK, API, worker — **change ingest shapes here**); `models.ts` is the model/cost registry; `ids.ts` ID helpers; queue name constants.
- **`packages/contracts`** — Zod **API response** schemas + inferred TS types, shared by API and console to kill type drift (imported as `C` in `app.ts`).
- **`packages/ui`** — shared design system for the public sites (`apps/web`, `apps/docs`): shadcn primitives + composites (`BrandMark` logo, `CodeBlock`, `ThemeToggle`) on Tailwind 4, brand tokens in `src/styles/tokens.css` (lagoon teal `#4fb8b2 → #328f97`). The console does **not** use it (it has its own shadcn setup). Brand/design specs live in `docs/brand/`.
- **`packages/tsconfig`** — shared TS configs for the public-site workspaces only (`base`/`library`/`dashboard`/`docs`).
- **`packages/telemetry`** — the **analytical-store seam**: the `TelemetryStore` interface (`src/store.ts`, ~20 domain methods typed against `@memoturn/contracts`) and its **Apache Doris** implementation (`src/doris/`, mysql2 against the FE). All telemetry SQL lives here — packages/server and the worker call store methods, never hand-written engine SQL. Tables are UNIQUE KEY **merge-on-write** with sequence column `event_ts` (last-writer-wins: re-inserting an id with a newer event_ts overwrites; that's what makes ingest retries and score corrections idempotent). `src/migrate.ts` applies `infra/doris/*.sql` tracked in a `schema_migrations` ledger. `conformance.test.ts` is the behavioral contract any future engine must pass. Gotcha: never insert ARRAY columns via `CAST('[…]' AS ARRAY<STRING>)` — Doris's string→array parser corrupts values with quotes/commas; use array constructors with per-element placeholders (see `doris/serialize.ts`). Writes default to multi-row INSERT; setting `TELEMETRY_STREAM_LOAD=true` switches `insertRows` to the HTTP **Stream Load** path (`doris/streamload.ts`) — higher throughput, native `ARRAY<FLOAT>` JSON, `event_ts` as the sequence column so LWW still holds. In-network deploys hit the FE (8030, which redirects to a BE); a host-run worker points `DORIS_STREAM_LOAD_PORT` at a BE (8040) to load it directly.
- **`packages/db`** — Prisma client singleton (`index.ts`, Prisma 7 driver-adapter style — connection URL lives in code + `prisma.config.ts`, not the schema), plus `blob.ts`, `queue.ts` (subpath exports: `@memoturn/db/queue`, `/blob`). API-key hashing helpers live here too.
- **`packages/llm`** — provider gateway (mock / Anthropic / OpenAI) for the playground + LLM evaluators, plus `crypto.ts` for encrypting stored provider keys.
- **`sdks/js`** (`@memoturn/sdk`), **`sdks/python`** (`memoturn`), and **`sdks/go`** (`github.com/memoturn/memoturn/sdks/go`).

### Auth & access (two paths, one resolution)

`requireAuth` in `apps/api/src/middleware/auth.ts` accepts either:
1. **API key** (Basic auth, SDK/programmatic) → full access as role `OWNER`.
2. **Better Auth session cookie** (console) → honors the `x-memoturn-project` header (project switcher) and the user's organization role, resolved against the session's active organization.

Both set `projectId` + `role` (+ `organizationId`) on the context. Mutating handlers must call `denyIfReadOnly(c)` — `VIEWER` is read-only (returns 403). RBAC roles: OWNER/ADMIN/MEMBER (write) vs VIEWER.

Tenancy is the **Better Auth organization plugin** (`organization`/`member`/`invitation` tables; config + roles in `packages/server/src/betterauth.ts`). Projects belong to an `Organization`; `member.role` is a lowercase string mapped to our `WorkspaceRole` via `toWorkspaceRole`. Org management (create/switch/invite) uses `authClient.organization.*` directly — note org mutations require an `Origin` header (browsers send it; scripts must set a trusted one). New orgs auto-provision a default project via the plugin's `afterCreateOrganization` hook.

**SSO** uses the Better Auth `@better-auth/sso` plugin (`ssoProvider` table; endpoints under `/auth/sso/*`) so customers sign into memoturn with their own OIDC/SAML IdP, mapped by email `domain` (and optionally an `organizationId`). Register/list/delete from the Organizations page; full IdP sign-in needs a real provider. Session cookies are prefixed `memoturn.` (`advanced.cookiePrefix`).

**Remote MCP OAuth** uses the `@better-auth/oauth-provider` plugin (OAuth 2.1: mandatory PKCE S256, dynamic client registration, rotating refresh tokens; tables `oauthClient`/`oauthRefreshToken`/`oauthAccessToken`/`oauthConsent` + `jwks` from the `jwt()` plugin). Access tokens are JWTs verified statelessly by `verifyMcpBearer` in `packages/server/src/betterauth.ts` (issuer = `${AUTH_BASE_URL}/auth`, audience = API origin); the console serves the `/login` + `/consent` pages the authorize flow bounces to (the signed query string must be round-tripped verbatim).

## Recipes

### Add a read endpoint
1. Add/extend the zod schema in `packages/contracts/src/index.ts` (export schema + inferred type).
2. Implement the query in `packages/server/src/<domain>.ts`; its return type is the inferred contract type.
3. Add the route in `apps/api/src/app.ts` with the contract schema in `responses` (rich OpenAPI) + a `app.use("/v1/…", requireAuth)` guard. Because `app.openapi` type-checks `c.json(...)` against the response schema, a server result that doesn't match the contract is a **compile error** — that's the drift guard, so don't cast it away.
4. Add a method in `apps/console/src/lib/api.ts`; response types come from contracts via the re-export (no new console interfaces).

### Add a mutating endpoint
Same as above, plus: call `denyIfReadOnly(c)` first and `recordAudit(projectId, actor, action, target)` after; declare a `403` response in the route.

### Change the Prisma schema
1. Edit `packages/db/prisma/schema.prisma` — **add the reverse relation on `Project`** for any new project-scoped model.
2. `cd packages/db && set -a; . ../../.env; set +a; bunx prisma migrate dev --name <change>`.
3. Re-run `bun run typecheck`. Stale-client type errors (e.g. "Property X does not exist") mean the generated client needs `bun run db:generate`.

## Conventions & gotchas

- **Dev infra uses non-default host ports** to avoid clashes: Postgres **5433**, Redis **6380** (Doris FE 9030 MySQL + 8030 HTTP, MinIO standard). The `.env` reflects this — don't "fix" them to 5432/6379.
- **Biome** is the only formatter/linter: 2-space indent, double quotes, semicolons, line width 120. Run `bun run format` before committing. Generated files (`routeTree.gen.ts`) and Prisma migrations are excluded.
- **Git hooks (lefthook)**: pre-commit runs Biome on staged files; pre-push runs `typecheck` + `rbac:check` (every mutating `/v1` route must `denyIfReadOnly` + declare a `403`) + `docs:check` (doc/code coupling). Keep `typecheck` + `build` green.
- **Online eval failures never fail ingestion** — they're wrapped best-effort in the worker. Sampling is deterministic (FNV hash of `traceId:evaluatorName`), not random.
- **Local curl testing under zsh**: zsh does not word-split unquoted vars, so `A='-u pk:sk'; curl $A ...` silently 401s. Use literal flags: `curl -u pk-mt-dev:sk-mt-dev http://localhost:3001/v1/metrics`. For scripted verification prefer `bun --filter @memoturn/api start` (stable) over `dev` (`--watch`), and allow a few seconds after boot for cold connections.
- **Numeric coercion lives in the telemetry store**: Doris returns `COUNT`/`SUM`/BIGINT values that mysql2 may surface as strings, so every store method `Number(...)`-normalizes before returning — methods return contract-shaped values, and the console's residual defensive coercion is harmless. Don't re-introduce raw engine rows into packages/server.
- **Engine policy — Apache Doris only, behind the seam** (the store deliberately sits on an ASF-governed engine to stay vendor-neutral). All engine SQL stays inside `packages/telemetry`; if it ever has to change again, a new engine implements `TelemetryStore` + passes `conformance.test.ts`, and the blob raw-event log is the replay path for data. Don't scatter Doris SQL into packages/server or the worker.
- **`start` vs `dev` env**: the `dev` scripts load `--env-file=../../.env`; the `start` scripts don't (Docker injects env). When running a `start` script locally, export the env first: `set -a; . ./.env; set +a`.
- Commits: conventional-ish (`feat(scope): …`, `fix(scope): …`, `chore: …`).
