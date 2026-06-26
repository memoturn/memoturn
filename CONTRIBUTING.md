# Contributing to memoturn

Thanks for helping build memoturn! This is a Bun-native monorepo.

## Prerequisites

- **Bun** ≥ 1.3 (package manager + runtime)
- **Docker** (for Postgres, ClickHouse, Redis/Valkey, MinIO)
- **uv** (only if you work on the Python SDK)

## Setup

```bash
cp .env.example .env
bun run setup   # install + infra up + wait-for-healthy + migrate + clickhouse + seed
bun run dev     # api (:3001) + worker + console (:3000)
```

`bun install` also runs `postinstall` (regenerates the Prisma client — no more stale-client
type errors after a schema change) and `prepare` (installs git hooks via lefthook).

Then `bun run quickstart` emits a trace; open http://localhost:3000.

- Console: http://localhost:3000 — login `admin@memoturn.dev` / `memoturn-dev-123`
- API + Scalar docs: http://localhost:3001/docs
- Dev API key (SDKs): `pk-mt-dev` / `sk-mt-dev`

## Layout

```
apps/api       Hono (Bun) — public /v1 REST, OTel receiver, Better Auth, OpenAPI/Scalar
apps/console   Vite + TanStack Router SPA + TanStack Query
apps/worker    Bun + BullMQ — ingest -> ClickHouse, online evaluators
packages/core      Zod ingest event contracts, model/cost registry
packages/contracts Zod API response schemas + inferred types (shared by API + console)
packages/db    Prisma (Postgres) + ClickHouse/blob/queue clients
packages/server shared server logic (auth, traces, metrics, prompts, datasets, evals, review, export)
packages/llm   provider gateway (mock/Anthropic/OpenAI) + key encryption
sdks/js        @memoturn/sdk      sdks/python  memoturn
```

## Checks (CI parity)

```bash
bun run lint        # Biome (format + lint + import order); `bun run format` to auto-fix
bun run typecheck && bun run test && bun run build
```

`bun run test` is infra-free by default; the API/worker integration tests run only when
the datastore env (`DATABASE_URL`, `CLICKHOUSE_URL`, `REDIS_URL`, `BLOB_ENDPOINT`) is set,
so they exercise real infra in CI but stay skipped locally unless you opt in.

### End-to-end (console)

Playwright drives the console against the full stack. With infra up (`bun run infra:up`),
run `bun --filter @memoturn/console test:e2e` — it boots the API + console, seeds the dev
org/project/user, and runs the browser suite (reusing a running `bun run dev` if present).
First run: `cd apps/console && bunx playwright install chromium`. CI runs it in `e2e.yml`.

Git hooks (lefthook): pre-commit runs Biome on staged files; pre-push runs typecheck.

## Conventions

- **Data flow**: SDK/OTel → `POST /v1/ingest` → blob (raw event log) → BullMQ → worker → ClickHouse. Relational metadata is in Postgres (Prisma); high-volume telemetry is in ClickHouse.
- **Auth**: API keys (Basic auth) for SDKs; Better Auth session cookie for the console. Both resolve a project + role in `apps/api/src/middleware/auth.ts`.
- **After a Prisma schema change**: `bun --filter @memoturn/db migrate:dev --name <change>` then re-run typecheck (the generated client must be regenerated).
- **Wire contracts** live in `packages/core/src/events.ts` (shared by SDK, API, worker) — change them there.

## Gotcha: local API testing uses zsh

The dev shell is **zsh**, which does **not** word-split unquoted variables. So this silently fails (sends the auth as one bogus arg → 401):

```sh
A='-u pk-mt-dev:sk-mt-dev'
curl $A http://localhost:3001/v1/metrics      # FAILS -> 401 (one bogus arg)
```

Use literal flags instead:

```sh
curl -u pk-mt-dev:sk-mt-dev http://localhost:3001/v1/metrics   # works
```

Also: run services with `bun --filter @memoturn/api start` (stable) rather than `dev` (`--watch`) when scripting verification, and give the first authed request a few seconds after boot (cold Redis/Postgres connections).

## Commits

Conventional-ish messages (`feat(scope): …`, `fix(scope): …`, `chore: …`). Keep `bun run typecheck && bun run build` green.
