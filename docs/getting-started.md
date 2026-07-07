# Getting started

## Prerequisites

- [Bun](https://bun.sh) ≥ 1.3 (package manager + runtime)
- Docker (Postgres, ClickHouse, Redis/Valkey, MinIO)
- [uv](https://docs.astral.sh/uv/) — only if you work on the Python SDK

## Install & run

```bash
git clone git@github.com:memoturn/memoturn.git
cd memoturn
cp .env.example .env
bun run setup     # install + start infra + wait healthy + migrate + clickhouse + seed
bun run dev       # api (:3001) + worker + console (:3000)
```

`bun run setup` runs, in order:

1. `bun install` (also regenerates the Prisma client + installs git hooks)
2. `bun run infra:up` — start the dependency containers
3. `bun run infra:wait` — block until Postgres/Redis/ClickHouse/MinIO are reachable
4. `bun run db:migrate` — apply Prisma (Postgres) migrations
5. `bun run db:clickhouse` — apply the ClickHouse DDL
6. `bun run seed` — create a default workspace/project, a dev API key, a login user, and a sample prompt

## What you get

| Surface | URL / value |
| --- | --- |
| Console (dashboard) | http://localhost:3000 |
| Dashboard login | `admin@memoturn.dev` / `memoturn-dev-123` |
| API | http://localhost:3001 |
| API reference (Scalar) | http://localhost:3001/docs |
| OpenAPI document | http://localhost:3001/openapi.json |
| Dev API key (SDKs) | `pk-mt-dev` / `sk-mt-dev` |

## Emit your first trace

```bash
bun run quickstart        # TypeScript SDK → a trace with a span + generation + score
```

Open http://localhost:3000/traces and click the trace to see the waterfall timeline and
its scores.

From Python:

```bash
cd sdks/python
MEMOTURN_PUBLIC_KEY=pk-mt-dev MEMOTURN_SECRET_KEY=sk-mt-dev uv run examples/quickstart.py
```

## Fill the dashboards with demo data

One trace makes for an empty dashboard. To exercise the metrics, trace list, and sessions
views with realistic volume, seed ~30 days of backdated demo telemetry (requires `bun run dev`
running — data flows through the real ingest pipeline):

```bash
bun run seed:demo                                  # 30 days × ~1000 traces/day
bun run seed:demo -- --days 7 --traces-per-day 100 # smaller/faster
bun run seed:demo -- --dry-run                     # generate + validate only, send nothing
bun run seed:demo -- --wipe                        # delete previous demo rows first
```

The run is deterministic (`--seed`): re-running on the same day replaces the same rows
instead of duplicating them. On a later day the seeded window shifts forward, so pass
`--wipe` to clear the previous run's rows first.

## Common commands

```bash
bun run dev          # run api + worker + console (turbo)
bun run lint         # Biome (format + lint + import order)
bun run format       # auto-fix
bun run typecheck
bun run test
bun run build
bun run infra:down   # stop the dependency containers
```

> **Note (zsh):** when testing the API with `curl`, use literal flags — zsh does not
> word-split unquoted variables, so `curl $A ...` sends the auth as one argument and 401s.
> Use `curl -u pk-mt-dev:sk-mt-dev http://localhost:3001/v1/metrics`.

Next: [Architecture](./architecture.md) · [Concepts](./concepts.md)
