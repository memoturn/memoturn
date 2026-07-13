# Troubleshooting

Common failure modes when running memoturn locally or self-hosted, and how to get unstuck.
Each symptom lists the usual cause first.

## Setup & infrastructure

### `bun run infra:up` fails with "port is already allocated"

Dev infra intentionally uses **non-default host ports** to avoid clashing with other local
services: Postgres **5433**, Redis **6380** (Doris 9030/8030, MinIO 9000/9001). If one is still
taken, another container or process on your machine holds it — find it with
`docker ps --format '{{.Names}}\t{{.Ports}}'` (or `lsof -i :5433`) and stop it, or edit the
host-side port mapping in `infra/docker-compose.dev.yml` **and** the matching URL in `.env`.
Don't "fix" the ports back to 5432/6379 — the offsets are deliberate.

### `bun run infra:wait` never becomes healthy

Docker isn't running, or a container is crash-looping. `bun run infra:logs` shows which one.
The Doris FE + BE containers want ~4 GB of Docker memory — raise Docker's memory limit if
they get OOM-killed. A container that loops after an unclean shutdown usually recovers on
`bun run infra:down && bun run infra:up` (volumes persist — no data loss).

### `db:migrate` (or another script) fails with "The datasource.url property is required"

The `dev` scripts load `--env-file=../../.env`; the `start` and some package scripts don't.
Export the env into your shell first, then re-run:

```bash
set -a; . ./.env; set +a
bun run db:migrate
```

## Ingestion

### `/v1/ingest` returns 207 but nothing appears in the console

A 207 means the API accepted the batch and enqueued it — **the worker does the Doris
write**. Check, in order:

1. Is the worker running? (`bun run dev` starts it; its health endpoint is
   http://localhost:3002/metrics.)
2. Did the job fail repeatedly? Batches that exhaust retries land in the dead-letter queue —
   inspect with `bun run dlq`, re-enqueue with `bun run dlq --replay`.
3. Console time range — backdated or slow-arriving data may be outside the selected window.

### `/v1/ingest` returns 429

Per-project ingest rate limiting. Raise `INGEST_EVENTS_PER_MINUTE` (and the general
`RATE_LIMIT_PER_MINUTE` for other endpoints) in the environment.

### curl returns 401 with credentials that "should" work

Auth is HTTP Basic with `publicKey:secretKey`. Two classics:

- **zsh does not word-split unquoted variables** — `A='-u pk:sk'; curl $A …` sends no auth
  header at all and 401s. Spell the flags out: `curl -u pk-mt-dev:sk-mt-dev http://localhost:3001/v1/metrics`.
- Using the console login (email/password) against the API — SDK/API calls need the **API key
  pair**, not the dashboard credentials.

### `bun run seed:demo` fails or seeds nothing

It sends data through the real ingest pipeline, so the dev API **and worker** must be running
(`bun run dev`) before you seed. It also loads `.env` itself — no manual export needed.

## Console

### Login fails with the documented dev credentials

`bun run seed` creates the login user (`admin@memoturn.dev` / `memoturn-dev-123`) — run it (or
`bun run setup`) at least once. In production images, seeding is guarded by `ALLOW_SEED` and the
`SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` variables.

### Dashboard is empty right after the quickstart

One trace makes for an empty dashboard. Seed ~30 days of realistic telemetry with
`bun run seed:demo` (requires `bun run dev` running), then refresh.

### Organization actions (create/switch/invite) fail from scripts

Better Auth org mutations require an `Origin` header. Browsers send it automatically; scripts
must set a trusted one (see `AUTH_TRUSTED_ORIGINS`).

## Development

### TypeScript errors like "Property X does not exist" after a schema change

The generated Prisma client is stale. Regenerate with `bun run db:generate` (also runs on
`postinstall`), then re-run `bun run typecheck`.

### Doris counts come back as strings

`COUNT` / `SUM` / BIGINT values can surface as strings from the mysql2 client — wrap them in
`Number(...)` inside the store method in `packages/telemetry`, so consumers only ever see
contract-shaped numbers.

Still stuck? [Open an issue](https://github.com/memoturn/memoturn/issues) with the output of the
failing command and `bun run infra:logs`.
