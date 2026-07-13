---
title: Configuration
description: Every memoturn environment variable — defaults, production requirements, and what they do.
---

All configuration is via environment variables. Copy `.env.example` to `.env`; the
defaults match `infra/docker-compose.dev.yml`.

## Postgres (OLTP)

| Var | Default | Notes |
| --- | --- | --- |
| `DATABASE_URL` | `postgresql://memoturn:memoturn@localhost:5433/memoturn?schema=public` | Host port is **5433** in dev to avoid clashing with other local Postgres |

## ClickHouse (OLAP)

| Var | Default |
| --- | --- |
| `CLICKHOUSE_URL` | `http://localhost:8123` |
| `CLICKHOUSE_USER` | `memoturn` |
| `CLICKHOUSE_PASSWORD` | `memoturn` |
| `CLICKHOUSE_DB` | `memoturn` |

## Redis / Valkey

| Var | Default | Notes |
| --- | --- | --- |
| `REDIS_URL` | `redis://localhost:6380` | Host port **6380** in dev |
| `WORKER_CONCURRENCY` | `10` | Ingest worker concurrency |
| `WORKER_PORT` | `3002` | Worker `/health` + `/metrics` HTTP endpoint |

## Blob storage (S3-compatible)

| Var | Default |
| --- | --- |
| `BLOB_ENDPOINT` | `http://localhost:9000` |
| `BLOB_REGION` | `us-east-1` |
| `BLOB_BUCKET` | `memoturn` |
| `BLOB_ACCESS_KEY_ID` | `memoturn` |
| `BLOB_SECRET_ACCESS_KEY` | `memoturn123` |
| `BLOB_FORCE_PATH_STYLE` | `true` |

## API & console

| Var | Default | Notes |
| --- | --- | --- |
| `API_PORT` | `3001` | Hono API |
| `CONSOLE_PORT` | `3000` | Vite SPA |
| `MEMOTURN_API_URL` | `http://localhost:3001` | API target for the console dev proxy |
| `RATE_LIMIT_PER_MINUTE` | `0` | Per-project global request rate limit (requests/minute); `0` disables it (per-key limits still apply) |
| `INGEST_EVENTS_PER_MINUTE` | `0` | Per-project ingest event-rate budget (events/minute; `0` = disabled). Meters actual event volume — a single POST can carry up to 1000 events, so this catches burst loads that the request-count limit would miss. Returns `429` with `Retry-After` when exceeded. |

## Auth

**Production startup guard**: in production (`NODE_ENV=production`) the API and worker
refuse to start if `BETTER_AUTH_SECRET`, `ENCRYPTION_KEY`, or `AUTH_TRUSTED_ORIGINS` are
missing, shorter than 16 characters, or set to a known development placeholder. Generate
fresh values with `openssl rand -base64 48`.

| Var | Default | Notes |
| --- | --- | --- |
| `BETTER_AUTH_SECRET` | dev placeholder | **Required in production** — signs session cookies and tokens. Use `openssl rand -base64 48`. |
| `AUTH_BASE_URL` | `http://localhost:3001` | Better Auth base URL |
| `AUTH_TRUSTED_ORIGINS` | `http://localhost:3000` | **Required in production** — comma-separated console origins for CORS + auth. |
| `ENCRYPTION_KEY` | dev placeholder | **Required in production** — AES-256-GCM key for provider API keys stored at rest. Independent of `BETTER_AUTH_SECRET`. Rotating this invalidates all stored provider keys (they must be re-entered in Settings → Providers). |
| `MCP_LOGIN_PAGE` | `<first AUTH_TRUSTED_ORIGINS>/login` | Console sign-in page the remote-MCP OAuth flow (Better Auth `mcp()` plugin) redirects unauthenticated users to. Override only if the console login lives elsewhere. |

## Security

| Var | Default | Notes |
| --- | --- | --- |
| `ALLOW_PRIVATE_WEBHOOK_TARGETS` | unset | Set to `1` to permit `http://` and private/loopback webhook, automation, and analytics-sink URLs. Production blocks them by default to prevent SSRF. Useful for dev/LAN self-hosted targets. |

## SDK / examples

| Var | Default | Notes |
| --- | --- | --- |
| `MEMOTURN_BASE_URL` | `http://localhost:3001` | API base used by SDKs |
| `MEMOTURN_PUBLIC_KEY` | `pk-mt-dev` | Matches the dev key from `bun run seed` |
| `MEMOTURN_SECRET_KEY` | `sk-mt-dev` | |

## Seeding

`bun run seed` creates the default organization, project, API key, and admin user. In
development the credentials are the well-known dev defaults; in production the script
refuses to run unless `ALLOW_SEED=1` is set, at which point it generates random
credentials and prints them once.

| Var | Default | Notes |
| --- | --- | --- |
| `ALLOW_SEED` | unset | Set to `1` to allow `bun run seed` in `NODE_ENV=production`. Without it the script exits with an error (the dev credentials are public knowledge). |
| `SEED_ADMIN_EMAIL` | `admin@memoturn.dev` | Override the seeded admin email. In production a random value is generated unless this is set. |
| `SEED_ADMIN_PASSWORD` | `memoturn-dev-123` | Override the seeded admin password. In production a random value is generated unless this is set. |
