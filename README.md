# memoturn

Open-source AI engineering platform — **LLM observability, evals, metrics, prompt
management, playground, and datasets**. Self-hostable, OpenTelemetry-native, and
integrates with LangChain, the OpenAI SDK, LiteLLM, the Vercel AI SDK, and more.

> Status: **Phase 1 — foundation + ingestion MVP.** Runs on **Bun**.

## Architecture

memoturn is an async, decoupled system:

| Tier | Tech | Role |
| --- | --- | --- |
| API | **Hono** on **Bun** (`apps/api`) | Public `/v1` ingest + OTel receiver + read API + OpenAPI |
| Console | **Vite + TanStack Router SPA** (`apps/console`) | Dashboard; talks to the API via TanStack Query |
| Worker | **Bun + BullMQ** (`apps/worker`) | Async ingest processing → ClickHouse |
| OLTP | **PostgreSQL** (Prisma) | Workspaces, projects, API keys, prompts, datasets, evaluators |
| OLAP | **ClickHouse** | High-volume `traces` / `observations` / `scores` for fast analytics |
| Queue/cache | **Redis (Valkey)** + BullMQ | Async ingest, evals, exports, automations, caches |
| Blob | **S3-compatible** (MinIO) | Raw replayable event log, multimodal media, exports |

```
SDKs / OTel / LangChain / LiteLLM
      │  POST /v1/ingest  (batched, Basic auth = publicKey:secretKey)
      ▼
  apps/api (Hono/Bun) ─► validate ─► write raw to blob ─► enqueue (BullMQ) ─► 207 ack
      ▼
  apps/worker (Bun) ─► merge trace/observation/score updates ─► ClickHouse
      ▼
  apps/console (SPA) ──TanStack Query──►  apps/api  (GET /v1/traces/:id)
```

The API acks fast; the worker does the heavy writes. The raw blob event log is the
source of truth, so ClickHouse is always rebuildable.

## Runtime & toolchain

- **Bun** is the package manager and the runtime for the API, worker, scripts, and SDK.
- The **console** is a static SPA built/served by **Vite** (runs on Bun).
- **Better Auth** will provide dashboard auth in the platform phase (API keys already secure the SDK/API).

## Monorepo

```
apps/api        Hono (Bun) — public /v1 REST, OTel receiver, OpenAPI + Swagger UI
apps/console    Vite + TanStack Router SPA + TanStack Query — dashboard
apps/worker     Bun + BullMQ — ingest processor (eval/automation/export later)
packages/core   Zod event contracts, shared types, model/cost registry
packages/db     Prisma + ClickHouse/blob/queue clients
packages/server Shared server logic (auth, ClickHouse reads, OTel mapping, ingest submit)
sdks/js         @memoturn/sdk — tracing, wrapOpenAI, MemoturnCallback, getPrompt
integrations/   LiteLLM adapter, …
infra/          docker-compose (dev + full), ClickHouse DDL, Helm, Terraform
```

## Quickstart

```bash
bun install
cp .env.example .env

# 1. Start dependencies (Postgres, ClickHouse, Redis, MinIO)
bun run infra:up

# 2. Apply schemas + seed a workspace/project/API key
bun run db:migrate
bun run db:clickhouse
bun run seed

# 3. Run API (:3001), worker, and console (:3000)
bun run dev

# 4. In another shell, emit a trace end-to-end
bun run quickstart
# → open http://localhost:3000/traces
# → API docs: http://localhost:3001/docs   (OpenAPI: /openapi.json)
```

## Ports

| Service | URL |
| --- | --- |
| Console (SPA) | http://localhost:3000 |
| API (Hono) | http://localhost:3001 |
| API docs (Swagger UI) | http://localhost:3001/docs |
| MinIO console | http://localhost:9001 |

## Roadmap

1. **Foundation + MVP** — ingest spine, JS SDK, API, console trace view *(current)*
2. **Observability complete** — trace explorer, sessions, users, integrations, Python SDK
3. **Metrics & dashboards** — materialized views, cost registry, dashboards, metrics API
4. **Prompts & playground** — versioned registry, channels, playground
5. **Evals & datasets** — datasets, experiments, evaluators, review queues
6. **Platform/enterprise** — RBAC, Better Auth + SSO/SAML, audit logs, automations, retention, exports

## License

Apache-2.0
