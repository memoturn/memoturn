# Deployment

Memoturn is self-hostable with no cloud lock-in. Dev uses Docker Compose; production is
the same components (managed or self-run).

## Local / dev dependencies

```bash
bun run infra:up     # Postgres, Apache Doris (FE + BE), Redis/Valkey, MinIO (infra/docker-compose.dev.yml)
bun run infra:down
bun run infra:logs
```

With `TELEMETRY_ENGINE=postgres` in `.env`, `infra:up` skips the Doris containers entirely
(they sit behind a compose profile) — see [Telemetry engine](#telemetry-engine-doris-or-postgres).

## Telemetry engine: Doris or Postgres

Memoturn runs its telemetry store on one of two engines, selected by `TELEMETRY_ENGINE`
([ADR-0002](./adr/0002-postgres-telemetry-tier.md)). Both pass the same behavioral
conformance suite; the product is identical on either.

| | `doris` (default) | `postgres` |
| --- | --- | --- |
| Best for | Sustained volume, long retention, big scans | Small installs — the lightest possible footprint |
| Telemetry lives in | Apache Doris FE + BE | The same Postgres you already run (schema `telemetry`) |
| Extra containers | 2 (JVM-based, ~4 GB+ between them) | **None** (Postgres image must include pgvector — the shipped compose files use `pgvector/pgvector:pg16`) |
| Comfortable up to | See [Doris sizing](#doris-sizing) | Roughly 10–50 M observation rows / low hundreds of GB |
| Vector search | Exact cosine scan | Exact cosine scan (pgvector) |

Selecting the engine:

- **Dev**: set `TELEMETRY_ENGINE=postgres` in `.env` — `bun run infra:up`, `infra:wait`,
  and `bun run db:telemetry` all follow it (Doris containers never start; migrations from
  `infra/postgres-telemetry/` apply into the `telemetry` schema).
- **Production**: layer the overlay on the single-VM stack —

  ```bash
  docker compose -f infra/docker-compose.prod.yml \
                 -f infra/docker-compose.prod.postgres.yml up -d --build
  ```

  The overlay parks the Doris services (never started), rewires service dependencies, and
  sets `TELEMETRY_ENGINE=postgres` for the API, worker, and migrate step. Requires Docker
  Compose ≥ 2.24. No `DORIS_PASSWORD` needed — the base file defaults it to empty and the
  required-password guard lives in the (parked) `doris-setup` service.

**When to graduate to Doris**: trace-list facets and dashboards getting slow, sustained
ingest in the thousands of rows/sec, long retention at high volume, or embedding spaces
past ~100k vectors. The move is a defined, verifiable runbook — a seam-level row copy with
no API downtime and blob replay as the fallback
([ADR-0004](./adr/0004-telemetry-graduation-path.md)); it also works in reverse (within the
Postgres envelope) for downsizing. Retention and deletes behave identically on both engines.

The copy is driven by `bun run telemetry:migrate` (both engines' connection env must be
set; the run is idempotent and resumable, and re-verification is built in):

```bash
bun run telemetry:migrate -- --from postgres --to doris --dry-run   # size the copy
bun run telemetry:migrate -- --from postgres --to doris             # bulk copy + verify, system live
# pause the worker (API keeps acking; queue + blob buffer all ingest)
bun run telemetry:migrate -- --from postgres --to doris             # fast LWW top-up + re-verify
# set TELEMETRY_ENGINE=doris on api + worker, resume the worker
```

The CLI verifies per-project row counts on both engines plus row-level spot checks, and
exits non-zero (do not flip) on any mismatch. `--verify-only` re-runs just the checks.

## Full self-host stack

`infra/docker-compose.yml` builds and runs the API + worker alongside all dependencies:

```bash
docker compose -f infra/docker-compose.yml up -d --build
```

This stack has **no TLS termination**, so the API is published on `127.0.0.1:3001` only. Put a
TLS-terminating reverse proxy in front of it (or use the single-VM stack below, which ships
Caddy); set `API_BIND=0.0.0.0` only when that proxy runs on another host and the network
between them is trusted. Per-project rate limits are on by default here (`RATE_LIMIT_PER_MINUTE`,
`INGEST_EVENTS_PER_MINUTE`).

Images are built from `docker/{api,worker,console}.Dockerfile` (all `oven/bun`). The
console is a static SPA — build it (`bun --filter @memoturn/console build`) and serve the
output behind any static host / CDN, with a reverse proxy routing `/api/*` to the API and
SPA-fallback (rewrite unknown paths to `index.html`) for deep links.

### Architectures

The published images (`ghcr.io/memoturn/{api,worker,console}`) are **multi-arch manifest
lists covering `linux/amd64` and `linux/arm64`**, so `docker pull` gets a native image on an
Apple Silicon Mac or an arm64 server (Graviton, Ampere, Axion) — no `--platform` flag, no
QEMU emulation. Confirm what a tag resolves to:

```bash
docker buildx imagetools inspect ghcr.io/memoturn/api:latest
```

Every dependency the compose stacks pin publishes arm64 as well — `pgvector/pgvector:pg16`,
`valkey/valkey:8-alpine`, `minio/minio`, `caddy:2-alpine`, and `apache/doris:{fe,be}-4.1.2` —
so the full self-host stack runs natively on arm64, Doris included. (Doris on a laptop is
still a memory-hungry neighbour; for local or small installs the
[Postgres telemetry tier](#telemetry-engine-doris-or-postgres) is the lighter path,
independent of architecture.)

## Single-VM production (Docker Compose + Caddy)

`infra/docker-compose.prod.yml` is a self-contained, HTTPS-terminated stack for one server:
Caddy (auto Let's Encrypt) in front of the console + API + worker, plus self-hosted Postgres,
Doris (FE + BE), Valkey, and MinIO. Caddy is the only published port (80/443); everything else stays
on the internal network. A one-shot `doris-setup` service sets the Doris root password
(`DORIS_PASSWORD` is required in production), and a one-shot `migrate` service runs the Prisma +
Doris migrations before the API/worker start.

> **Never expose Doris ports without a root password.** While root's password is empty, the FE
> HTTP query API (8030) accepts *any* credentials — anyone who can reach it can run SQL. The
> bundled prod compose keeps Doris internal-only and always sets a password; the dev compose
> binds 9030/8030 to loopback because dev runs password-less.

**Prerequisites:** a VM with Docker, a DNS A/AAAA record pointing at it, and ports 80+443 open.

```bash
cp .env.production.example .env          # set MEMOTURN_DOMAIN, ACME_EMAIL, and the secrets
openssl rand -base64 48                  # generate each secret (BETTER_AUTH_SECRET, ENCRYPTION_KEY, passwords)
bun run prod:up                          # docker compose -f infra/docker-compose.prod.yml --env-file .env up -d --build
```

Companion scripts: `bun run prod:ps` (status), `bun run prod:logs` (tail logs), `bun run prod:down` (stop).

The compose file derives `AUTH_BASE_URL=https://DOMAIN` (the **origin only — no `/api`**; Better
Auth mounts at `/auth` and a path in the base URL would break it) and `AUTH_TRUSTED_ORIGINS=https://DOMAIN`
from `MEMOTURN_DOMAIN`; required secrets use `${VAR:?}` so a missing value aborts the command. Caddy
routes `/api/*` to the API (prefix stripped, matching the dev Vite proxy) and everything else to the
console SPA — so the console's default `VITE_API_BASE=/api` works unchanged.

**First admin:** do **not** run `bun run seed` in production (it seeds the well-known dev key). Open
`https://DOMAIN/`, sign up the first admin (Better Auth email/password) — the org plugin auto-provisions
a default project — then mint an SDK API key from Settings. Point the SDK at `https://DOMAIN/api`.

**Backups:** `bun run prod:backup` (scripts/backup.sh) takes a verified Postgres dump
(`pg_dump -Fc`, checked with `pg_restore --list`), a Redis/Valkey RDB snapshot (the queues,
including the ingest dead-letter queue), and a mirror of the blob bucket — the replayable raw
event log, the source of truth from which Doris or the Postgres tier is rebuilt — into
`./backups/`, keeping the newest `BACKUP_KEEP` (default 7) of each. It exits non-zero if any
artifact fails verification. Schedule it with cron (`0 2 * * * cd /opt/memoturn && bun run
prod:backup`, hourly on a busy install — the blob mirror is incremental) and ship `./backups/`
off-host; a backup on the same disk is not a backup. **RPO** is the backup interval; for
point-in-time recovery add WAL archiving (pgBackRest/wal-g) against the `pgdata` volume.

**Restore:** `bash scripts/restore.sh <timestamp>` stops the app tier, restores Postgres from
the dump, Redis from the RDB, mirrors the blob backup into the bucket, then rebuilds the
telemetry store by replaying every raw batch through the ingest queue (`bun run replay --
--all`) and restarts the api. Doris (or the Postgres tier) is deliberately not snapshotted:
the replay is the recovery path, and it is idempotent (last-writer-wins by `event_ts`), so
replaying on top of surviving rows is safe. Replayed batches skip usage metering and online
evaluators. Expect the rebuild to take roughly the original ingest volume ÷ worker throughput;
`bun run dlq` shows any batch that failed to re-apply. Add Doris `BACKUP SNAPSHOT` to an S3
repository if you need faster restores than a full replay. **Run the drill** on a staging
copy before you need it — see [Runbooks](./runbooks.md#restore-from-backup). All datastores
persist to named volumes (`pgdata`, `dorisfemeta`, `dorisbedata`, `redisdata`, `miniodata`).

`bun run replay -- --project <id> [--from YYYY-MM-DD --to YYYY-MM-DD]` also backfills a single
project (e.g. after an engine move, or into a fresh store); `--dry-run` sizes the job first.

**Note:** a single VM has no HA. If volume or uptime needs grow, move to the Helm chart below with
managed datastores.

## Public demo (per-visitor sandboxes)

`DEMO_MODE` turns a deployment into a public demo: any visitor who signs in with an email
gets a throwaway, **read-only** sandbox — their own organization + project, pre-seeded with
generated telemetry — hard-deleted after `DEMO_TTL_DAYS` (default 7) by the `sandbox-prune`
cron. Read-only (`viewer` role) means no ingest, no playground spend, and no API keys, so a
public sandbox can't run up cost or be abused for storage.

[demo.memoturn.com](https://demo.memoturn.com/demo) is exactly this configuration, running on a
single small VM — open it if you want to see the result before you build one.

Run it on the **Postgres telemetry tier** (no Doris) — a demo's data volume sits far inside
that tier's envelope, and it drops the box to ~4 GB RAM (a few €/month) versus the Doris
footprint. That's what makes a hosted demo affordable.

Prerequisites (do these first — they're outside the repo):

- [ ] **Subdomain DNS** — an A/AAAA record for your demo host (e.g. `demo.example.com`)
  pointing at the VM, ports 80+443 open. Caddy provisions the TLS cert on first boot.
- [ ] **Email transport** — a working sender (Resend or SMTP) on your domain, with SPF/DKIM/
  DMARC set. **This is a hard requirement:** magic-link sign-in is the only way into the
  demo, and with no transport configured the console *hides* passwordless sign-in entirely
  (it only offers what the server can send). Verify a `From` address on the domain.

Then deploy the prod stack with the Postgres overlay and demo env. Add to `.env` (see
`.env.production.example`):

```bash
MEMOTURN_DOMAIN=demo.example.com
DEMO_MODE=true
# DEMO_TTL_DAYS=7  DEMO_MAX_SANDBOXES=500  DEMO_SEED_DAYS=3  DEMO_SEED_TRACES_PER_DAY=15  (defaults)
EMAIL_FROM=memoturn <hello@example.com>
RESEND_API_KEY=re_...          # or the SMTP_* set
```

```bash
docker compose -f infra/docker-compose.prod.yml \
               -f infra/docker-compose.prod.postgres.yml --env-file .env up -d --build
```

Verify: open `https://demo.example.com/demo`, enter an email, follow the magic link — you
should land on a "preparing your sandbox" screen and then a dashboard of seeded traces, with
a "Demo sandbox · read-only · expires in N days" banner. The `sandbox-prune` cron
(`30 3 * * *`) reclaims expired sandboxes automatically; nothing else to operate.

Keep the standard [production checklist](#production-checklist) — a public demo is
internet-facing, so the rate limits and secrets there still apply.

## Kubernetes (Helm)

For production, the chart at `infra/helm/memoturn` deploys the stateless API (behind an
HPA), the worker, and the console; Postgres / Doris / Redis / blob are expected to be
external (managed services or operators — e.g. the community doris-operator or any managed
Doris; Memoturn only needs the FE MySQL endpoint). A pre-install/upgrade hook Job runs the
Prisma + Doris migrations (`bun run db:migrate && bun packages/telemetry/src/migrate.ts`)
before pods roll. Published images come from `ghcr.io/memoturn/*`.

```bash
helm install memoturn ./infra/helm/memoturn -f my-values.yaml
# or the published chart, versioned with the platform:
helm install memoturn oci://ghcr.io/memoturn/charts/memoturn --version <release> -f my-values.yaml
```

The chart enforces non-root pods with all capabilities dropped, keeps one api/console replica
up through node drains (PodDisruptionBudgets), points readiness probes at `/ready`, and can
render a default-deny NetworkPolicy (`networkPolicy.enabled`).

See `infra/helm/memoturn/README.md` for required values (datastore URLs, `betterAuthSecret`,
`encryptionKey`) and the ingress / autoscaling options.

## Repartitioning

Fresh installs create the three time-series tables (`traces`, `observations`, `scores`)
**AUTO-partitioned by day** (`packages/telemetry/src/doris/schema.ts`): time-range queries
prune to the partitions they touch, and `TELEMETRY_MAX_RETENTION_DAYS` maps onto Doris's
native `partition.retention_count` so old partitions drop for free (per-project retention
is still a key-predicate `DELETE`, now partition-pruned). Installs created before this
change have unpartitioned tables — the migrator warns on every deploy until they are
converted:

```bash
bun run telemetry:repartition -- --plan     # which tables are unpartitioned, row counts
bun run telemetry:repartition               # bulk copy into <t>__v2, verify, atomic swap (system live)
# pause the worker (API keeps acking; queue + blob buffer ingest)
bun run telemetry:repartition               # fast top-up of anything ingested during the bulk copy
# resume the worker
bun run telemetry:repartition -- --cleanup  # drop the retained legacy copies once satisfied
```

Each conversion copies the table month by month with `INSERT … SELECT` (disk temporarily
doubles for that table), verifies per-project row counts on both copies, refuses to swap on
any mismatch, and then runs `ALTER TABLE … REPLACE WITH TABLE` — an atomic rename, so reads
and writes never see a half-state. Every write is last-writer-wins by `event_ts`, so a top-up
run over live ingest is idempotent. `--set-replication N` raises `replication_num` on every
table (and the migrations ledger) for multi-BE clusters; set `DORIS_REPLICATION_NUM` so new
partitions inherit it.

## Migrations

```bash
bun run db:migrate      # Prisma (Postgres)
bun run db:telemetry    # Doris DDL (infra/doris/*.sql, tracked in a schema_migrations ledger)
```

Run these on deploy. After a Prisma schema change, the client is regenerated by
`postinstall` (or `bun run db:generate`).

The Doris runner is single-runner by design (Doris DDL is not transactional): the compose
`migrate` service runs once before api/worker start, and the Helm hook Job has parallelism 1.
It only retries cluster-warming errors (no alive BE, connection refused) — a bad statement
fails immediately with its index in the file. `ADD COLUMN` statements are skipped when the
column already exists, so a file that failed halfway can be re-run; other partially-applied
statements are reported for manual inspection and the file is not recorded until every
statement has succeeded. `DORIS_REPLICATION_NUM` (default 1) is substituted into new DDL
files' `${REPLICATION_NUM}` placeholder.

## Upgrading

The compose stacks build from source, so an upgrade is: pin the new version, rebuild, and let
the one-shot `migrate` service run before the app services start.

```bash
bun run prod:backup                      # snapshot Postgres + the blob event log first
git fetch --tags && git checkout vX.Y.Z  # pin a release tag (or a commit) — don't track main in prod
bun run prod:up                          # rebuilds images and applies the upgrade
```

`docker compose up -d --build` (what `bun run prod:up` runs) handles the ordering for you:

1. The one-shot **`migrate`** service runs `bun --filter @memoturn/db migrate` (Prisma) and
   `bun packages/telemetry/src/migrate.ts` — the latter applies any new Doris DDL from
   `infra/doris/*.sql`, tracked in the `schema_migrations` ledger, so Doris schema changes ride
   the same step. Nothing else to run by hand.
2. **api** and **worker** start only after `migrate` exits successfully
   (`service_completed_successfully`) — they never run against an unmigrated schema.
3. **console** restarts alongside them; it's a static SPA, so order doesn't matter beyond Caddy
   staying up (Caddy and the datastores keep running through the upgrade — expect a brief API
   blip while the api container swaps).

If you deploy prebuilt images (`ghcr.io/memoturn/*`) instead of building, pin the image tag,
`docker compose pull`, then `up -d` — same migrate-first ordering applies.

**Kubernetes:** the Helm chart runs the same migrations in a `pre-install,pre-upgrade` hook Job
(`templates/migrate-job.yaml`), so `helm upgrade` with a new image tag migrates before pods roll.

**Rollback expectations:** migrations are **forward-only** — there are no down migrations. Roll
the *application* back to the previous tag only if no migration shipped in between; otherwise
restore Postgres from the pre-upgrade backup. Doris is rebuildable from the blob raw-event log
(the replay path), so telemetry is never the thing that blocks a recovery.

**Resource limits + logs (single-VM stack):** every service runs under a memory limit
(`API_MEM_LIMIT` 1g, `WORKER_MEM_LIMIT` 2g, `POSTGRES_MEM_LIMIT` 2g, `MINIO_MEM_LIMIT` 1g,
`REDIS_MEM_LIMIT` 512m, `CONSOLE_MEM_LIMIT`/`CADDY_MEM_LIMIT` 256m — Doris caps itself via
`DORIS_FE_XMX`/`DORIS_BE_MEM_LIMIT`) and rotated json-file logging (`LOG_MAX_SIZE` 50m ×
`LOG_MAX_FILES` 5), so one runaway process or an unrotated request log can't take the host down.
The worker gets `stop_grace_period` 600s (`WORKER_STOP_GRACE_PERIOD`) so minutes-long experiment
and evaluator-backfill jobs drain on restart instead of being SIGKILLed.

## Scaling

- **API** is stateless — scale horizontally behind a load balancer. Point the balancer's
  health check (and Kubernetes' readiness probe) at `GET /ready`, which pings Postgres, Redis,
  the telemetry store, and the blob bucket; `/health` is liveness only and never fails.
- **Connection budget.** Every replica opens its own pools: `PRISMA_POOL_SIZE` (10) against
  Postgres, `DORIS_POOL_SIZE` (10) against the Doris FE, and on the Postgres tier
  `TELEMETRY_PG_POOL_SIZE` (10) too. Keep
  `Σ replicas × (PRISMA_POOL_SIZE + TELEMETRY_PG_POOL_SIZE)` — API and worker replicas
  alike — under Postgres `max_connections` (default 100) with headroom for migrations and
  ops sessions, or put PgBouncer in front. The Helm defaults (API 2→10 + 1 worker) reach
  110 connections at full scale, so either raise `max_connections`, lower the pool sizes via
  `extraEnv`, or add a pooler before letting the HPA out.
- **Timeouts.** `API_REQUEST_TIMEOUT_MS` (60 s) bounds non-streaming requests;
  `DORIS_QUERY_TIMEOUT_S` / `TELEMETRY_PG_STATEMENT_TIMEOUT_MS` kill runaway analytical
  queries server-side; `SSE_MAX_STREAMS_PER_PROJECT` (20) caps open live-tail/streaming
  connections per project across replicas.
- **Worker** scales by process count and `WORKER_CONCURRENCY`; the BullMQ queue
  distributes ingest jobs. It also serves `/health` (liveness), `/ready` (readiness), and
  `/metrics` (JSON, or Prometheus text with `Accept: text/plain`) on `WORKER_PORT`
  (default `3002`).
- **Apache Doris** holds the high-volume telemetry; use a managed Doris or the community
  doris-operator in production — the store only needs the FE MySQL endpoint. **Postgres**
  stays small (metadata).
- The raw blob event log is the source of truth — Doris can be rebuilt from it.

## Doris sizing

Starting points, not guarantees — telemetry width (payload sizes, evaluator volume, retention
window) moves these numbers a lot. Observe and adjust; the failure mode of an undersized BE is
analytical queries (and eventually ingest inserts) erroring with `MEM_ALLOC_FAILED`.

| Load | Observations/day | `DORIS_FE_XMX` | `DORIS_BE_MEM_LIMIT` | CPU (BE) | Disk | `WORKER_CONCURRENCY` |
| --- | --- | --- | --- | --- | --- | --- |
| Light | < 100k | `2048m` | `4G` | 2–4 vCPU | 50 GB SSD | `10` (default) |
| Medium | ~1M | `4096m` (default) | `8G`–`12G` | 4–8 vCPU | 200–500 GB SSD | `20`, consider `TELEMETRY_STREAM_LOAD=true` |
| Heavy | > 5M | `8192m` | `24G`+ (dedicated host) | 16+ vCPU | 1 TB+ NVMe | multiple worker replicas + Stream Load |

Notes:

- On the shared single-VM stack, `DORIS_BE_MEM_LIMIT` defaults to `40%` of host memory (dev
  compose: `6G`) — an absolute value is safer once other services compete for the same host.
- The compose stacks run **one FE + one BE with no HA** — fine well into the medium tier, but
  heavy sustained volume (or uptime requirements) is the signal to move to the Helm chart with
  a managed Doris or the doris-operator.
- Postgres and Redis stay small at every tier (metadata + queues); size the blob bucket for the
  raw event log, which grows with retention, not query load.

## Data retention

Set a per-project max age; a daily worker cron deletes older telemetry — from the telemetry
store, the blob event log/payloads/media under the project's prefixes, AND the Postgres
mutable-state mirror (which holds full input/output copies). `TELEMETRY_MAX_RETENTION_DAYS`
sets an instance-wide ceiling applied to every project, with or without a policy.

```bash
curl -u pk-mt-dev:sk-mt-dev -X POST http://localhost:3001/v1/retention \
  -H 'content-type: application/json' -d '{"days":90}'      # 0 = keep forever
curl -u pk-mt-dev:sk-mt-dev -X POST http://localhost:3001/v1/retention/apply   # run now
```

## Production checklist

- Set a strong `BETTER_AUTH_SECRET` (32+ chars) and a distinct `ENCRYPTION_KEY`.
- Use managed/persistent Postgres, Doris, Redis, and S3 (rotate the dev credentials; set `DORIS_PASSWORD`).
- Put the API and console behind TLS; set `AUTH_BASE_URL` / `AUTH_TRUSTED_ORIGINS`.
- Configure object storage (S3/R2/GCS) for the blob event log + exports.
- Optionally cap ingest with `RATE_LIMIT_PER_MINUTE` (per-project global limit; `0` disables it).
- For enterprise tenants, register an SSO provider (OIDC/SAML) per organization from the
  Organizations page, and configure the event sink (CDP forwarding) / PII masking per project as needed.
- Walk the [security hardening guide](./hardening.md) — a checklist of every security knob
  (proxy trust, rate limits, metrics exposure, SSRF policy, account hardening) with defaults
  and failure modes.

See [Configuration](./configuration.md) for the full variable reference.
