# memoturn Helm chart

Deploys the memoturn **API** (Hono/Bun), **worker** (BullMQ), and **console** (SPA) to
Kubernetes. The stateful dependencies — Postgres, ClickHouse, Redis, and an S3-compatible
blob store — are **not** bundled; point the chart at managed services or in-cluster
operators. This keeps the app tier stateless and horizontally scalable (the API runs behind
an HPA; the worker scales on queue load).

## Prerequisites

- Kubernetes 1.23+ and Helm 3.8+
- Reachable Postgres, ClickHouse, Redis, and S3-compatible blob bucket
- Container images published to `ghcr.io/memoturn/{api,worker,console}` (see
  [`docs/releasing.md`](../../../docs/releasing.md)); override `image.*` for a private registry

## Install

Create a values file with your datastore connection strings and the two required secrets:

```yaml
# my-values.yaml
config:
  databaseUrl: postgresql://memoturn:pass@pg:5432/memoturn?schema=public
  redisUrl: redis://redis:6379
  betterAuthSecret: <openssl rand -hex 32>
  encryptionKey: <openssl rand -hex 32>
  clickhouse:
    url: http://clickhouse:8123
    password: pass
  blob:
    endpoint: https://s3.amazonaws.com
    accessKeyId: <key>
    secretAccessKey: <secret>
  blobForcePathStyle: "false" # "true" for MinIO/R2
  authBaseUrl: https://memoturn.example.com

ingress:
  enabled: true
  className: nginx
  host: memoturn.example.com
```

```bash
helm install memoturn ./infra/helm/memoturn -f my-values.yaml
```

Prefer to manage secrets yourself? Create a Secret with the keys `DATABASE_URL`,
`REDIS_URL`, `BETTER_AUTH_SECRET`, `ENCRYPTION_KEY`, `CLICKHOUSE_URL`,
`CLICKHOUSE_PASSWORD`, `BLOB_ENDPOINT`, `BLOB_ACCESS_KEY_ID`, `BLOB_SECRET_ACCESS_KEY`
and set `config.existingSecret: <name>`.

## Migrations

When `migrations.enabled` (default `true`), a `pre-install,pre-upgrade` hook Job runs
`bun run db:migrate` (Prisma) then `bun run db:clickhouse` (ClickHouse DDL) using the API
image, so schema changes apply before pods roll.

## Key values

| Key | Default | Description |
| --- | --- | --- |
| `image.registry` / `image.repository` | `ghcr.io` / `memoturn` | Images: `<registry>/<repository>/{api,worker,console}` |
| `image.tag` | `.Chart.appVersion` | Image tag for all components |
| `config.existingSecret` | `""` | Use a pre-created Secret instead of chart-managed values |
| `api.autoscaling.enabled` | `true` | HPA on the API (CPU target) |
| `worker.autoscaling.enabled` | `false` | HPA on the worker |
| `console.enabled` | `true` | Deploy the console SPA |
| `ingress.enabled` | `false` | Single ingress: `/v1`,`/auth`,`/docs`,`/openapi.json` → API, `/` → console |
| `extraEnv` / `extraEnvFrom` | `[]` | Inject extra env (e.g. `RATE_LIMIT_PER_MINUTE`, `WORKER_CONCURRENCY`) |

See [`values.yaml`](values.yaml) for the full set.

## Uninstall

```bash
helm uninstall memoturn
```

Datastores are external, so their data is untouched.
