# Configuration

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
| `RATE_LIMIT_PER_MINUTE` | `0` | Per-project global request rate limit; `0` disables it (per-key limits still apply) |

## Auth

| Var | Default | Notes |
| --- | --- | --- |
| `BETTER_AUTH_SECRET` | dev value | **Use a 32+ char random secret in production** (`openssl rand -base64 32`) |
| `AUTH_BASE_URL` | `http://localhost:3001` | Better Auth base URL |
| `AUTH_TRUSTED_ORIGINS` | `http://localhost:3000` | Comma-separated origins allowed to call auth |
| `ENCRYPTION_KEY` | falls back to `BETTER_AUTH_SECRET` | AES-256-GCM key for provider API keys at rest |

## SDK / examples

| Var | Default | Notes |
| --- | --- | --- |
| `MEMOTURN_BASE_URL` | `http://localhost:3001` | API base used by SDKs |
| `MEMOTURN_PUBLIC_KEY` | `pk-mt-dev` | Matches the dev key from `bun run seed` |
| `MEMOTURN_SECRET_KEY` | `sk-mt-dev` | |
