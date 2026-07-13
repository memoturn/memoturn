---
title: Architecture
description: How memoturn's async ingest pipeline splits storage across Postgres, Apache Doris, Redis, and blob.
---

memoturn is an async, decoupled, Bun-native system. Ingestion is fire-and-forget: the
API persists raw events and acks immediately; a worker does the heavy writes.

```
SDKs / OTel / LangChain / OpenAI
   │  POST /v1/ingest  (Basic auth)
   ▼
apps/api (Hono on Bun)
   ├── write raw batch ──► S3 / MinIO      (source of truth)
   ├── enqueue job ──────► Redis / BullMQ
   └── ack 207 ──────────► client
                             │
Redis / BullMQ ──────────────┘
   │ deliver job
   ▼
apps/worker (Bun + BullMQ)
   ├── fetch raw batch ──► S3 / MinIO
   └── merge + insert ───► Apache Doris

apps/console (SPA) ── TanStack Query ──► apps/api ── reads ──► Postgres + Doris
```

## Services

| Service | Tech | Responsibility |
| --- | --- | --- |
| `apps/api` | Hono on Bun | Public `/v1` REST, OTel receiver, Better Auth, OpenAPI/Scalar |
| `apps/console` | Vite + TanStack Router SPA | Dashboard (talks to the API via TanStack Query) |
| `apps/worker` | Bun + BullMQ | Async ingest → Doris, online evaluators, retention cron |

## Storage tiers

| Store | Tech | Holds |
| --- | --- | --- |
| OLTP | PostgreSQL (Prisma 7, pg driver adapter) | Workspaces, projects, users/sessions, API keys, prompts, datasets, evaluators, review queues, provider connections (encrypted), audit log, retention policies |
| OLAP | Apache Doris | `traces`, `observations`, `scores` (`UNIQUE KEY` merge-on-write tables); dashboard metrics are aggregated on the fly from `observations` |
| Queue / cache | Redis (Valkey) + BullMQ | Async ingest queue, API-key cache, retention cron |
| Blob | S3-compatible (MinIO locally) | Raw replayable event log, exports |

## Ingestion pipeline

1. **SDK → API**: `POST /v1/ingest` (batch, Basic auth).
2. **API** validates the batch (zod).
3. **API → blob**: writes the raw batch to S3/MinIO — the source of truth.
4. **API → queue**: enqueues an ingest job on Redis/BullMQ.
5. **API → SDK**: responds `207` with a per-event status.
6. **Queue → worker**: delivers the job.
7. **Worker → blob**: fetches the raw batch back.
8. **Worker → Doris**: merges and inserts traces/observations/scores.
9. **Worker**: runs sampled online evaluators on completed traces.

- The API acks fast; the blob event log is the source of truth, so Doris is
  rebuildable.
- Merge semantics: Doris `UNIQUE KEY` merge-on-write tables keyed on `(project_id, id)`
  with `event_ts` as the sequence column, so late/partial/out-of-order events converge
  (last writer — the newest `event_ts` — wins). Create + update for one observation are
  merged in the worker when they arrive in the same batch.

## Packages

| Package | Purpose |
| --- | --- |
| `packages/core` | Zod **ingest** event contracts (SDK ↔ API ↔ worker), model/cost registry |
| `packages/contracts` | Zod **API response** schemas + inferred types (API doc + console types) |
| `packages/db` | Prisma client + blob / queue clients |
| `packages/telemetry` | `TelemetryStore` interface + Apache Doris implementation (all telemetry SQL) |
| `packages/server` | Shared server logic: auth, traces, metrics, prompts, datasets, evaluators, review, export, retention, Better Auth |
| `packages/llm` | Provider gateway (mock / Anthropic / OpenAI via the AI SDK) + API-key encryption |
| `sdks/js`, `sdks/python` | Client SDKs |

## Type-safety model

- **Ingest contracts** (`packages/core`) are the single source of truth for the
  SDK → API → worker wire format.
- **Response contracts** (`packages/contracts`) are zod schemas used by the API's
  OpenAPI responses *and* inferred into TypeScript types consumed by both the server
  (return types) and the console (client types). A drift between what the server returns
  and the contract is a compile error.

## Auth model

- **API keys** (Basic auth, `pk-mt-…` / `sk-mt-…`) — for SDKs and programmatic access;
  scoped to one project, hashed in Postgres, cached in Redis.
- **Better Auth session** (cookie) — for the dashboard; resolves the user's role and
  active project (via the `x-memoturn-project` header / project switcher).

See [Data model](/concepts/) for the entities and [Deployment](/deployment/) for
scaling.
