# memoturn Helm chart

Deploys the memoturn **API** (Hono/Bun), **worker** (BullMQ), and **console** (SPA) to
Kubernetes. The stateful dependencies — Postgres, Apache Doris, Redis, and an S3-compatible
blob store — are **not** bundled; point the chart at managed services or in-cluster
operators. This keeps the app tier stateless and horizontally scalable (the API runs behind
a CPU HPA; the worker ships with an optional CPU HPA, but its work is I/O-bound — for
queue-depth scaling, drive replicas from the BullMQ `waiting` count in the worker's
`/metrics` with an external autoscaler such as KEDA).

## Prerequisites

- Kubernetes 1.23+ and Helm 3.8+
- Reachable Postgres, Apache Doris (FE MySQL port), Redis, and S3-compatible blob bucket
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
  doris:
    host: doris-fe
    port: 9030
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
# or the published chart (pushed to GHCR on every release tag, versioned with the platform):
helm install memoturn oci://ghcr.io/memoturn/charts/memoturn --version 0.6.0 -f my-values.yaml
```

Every pod runs as uid 1000 with all capabilities dropped and privilege escalation
forbidden (`podSecurityContext` / `containerSecurityContext`); the console's root
filesystem is read-only. PodDisruptionBudgets keep one api/console replica through drains;
`networkPolicy.enabled` adds a default-deny policy once you fill in the datastore egress.
Readiness probes hit `/ready` (which pings every datastore); liveness stays on the cheap
health routes.

Prefer to manage secrets yourself? Create a Secret with the keys `DATABASE_URL`,
`REDIS_URL`, `BETTER_AUTH_SECRET`, `ENCRYPTION_KEY`, `DORIS_HOST`,
`DORIS_PASSWORD`, `BLOB_ENDPOINT`, `BLOB_ACCESS_KEY_ID`, `BLOB_SECRET_ACCESS_KEY`
and set `config.existingSecret: <name>`.

## Migrations

When `migrations.enabled` (default `true`), a `pre-install,pre-upgrade` hook Job runs
`bun run db:migrate` (Prisma) then the Doris DDL runner using the API
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
