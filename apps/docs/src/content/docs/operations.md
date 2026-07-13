---
title: Operations
description: "Running Memoturn securely in production: auth, scaling, backup, hardening."
---


This guide covers running Memoturn securely in production. It complements
[architecture.md](/architecture/).

## Deployment

**Kubernetes (Helm) is the production target and the single shippable artifact** (hosted SaaS *and*
BYOC). See [deployment](/deployment/) for the cluster choice (GKE/EKS) and rationale.

Memoturn ships as **two images**: the Apache-2.0 `memoturn` (built from `Dockerfile`; bundles the
Postgres/storage/Redis/OIDC/OTel extras) and `memoturn-enterprise` (built from `enterprise/Dockerfile`;
adds the BSL enterprise package + Stripe billing). The Helm chart serves either — point
`image.repository` at `memoturn-enterprise` for the managed plane. The required-backend matrix
(when Postgres / a Redis-protocol store / object storage become mandatory) is in `deploy/README.md`.

- **Kubernetes (Helm)** — `helm install mt deploy/helm/memoturn -f my-values.yaml`. The chart ships
  hardened pod defaults (non-root, read-only rootfs, dropped capabilities, seccomp `RuntimeDefault`),
  a `runtimeClassName` hook for gVisor, and a `scaleout.enabled` mode (diskless replicas + S3
  snapshots + Postgres control plane + ownership leases). One Deployment is the whole runtime — the
  control plane, durable-fiber scheduler, and hibernation reaper all run in-process (FastAPI
  lifespan), so no separate worker/cron is needed.
- **docker-compose** — `docker compose up --build` (single host; see `docker-compose.yml`) for local
  all-in-one dev.

> A PaaS such as Render is **not** a supported target: it can't run a Helm chart and has no
> privileged runtime for the gVisor sandbox, so untrusted code and compliance/VPC controls aren't
> possible. Use kind/k3d for local dev with the same chart.

## Authentication & authorization

Set `MEMOTURN_AUTH_MODE`:

- `none` *(default, dev only)* — every caller is an admin of the default tenant.
- `api_key` — provide `MEMOTURN_AUTH_API_KEYS` as a JSON list of
  `{key, tenant, subject, roles}`. Clients send `X-API-Key` (or `Authorization: Bearer <key>`).
- `jwt` — validate HS256 SSO/gateway tokens. Set `MEMOTURN_AUTH_JWT_SECRET` (and optionally
  `…_ISSUER` / `…_AUDIENCE`). Tenant and roles are read from the configured claims. Rotate
  without downtime via `MEMOTURN_AUTH_JWT_SECRETS` (additional active secrets by `kid`).
- `oidc` — verify IdP-issued RS256/ES256 tokens against the issuer's JWKS (the `oidc` extra).
  SCIM provisioning and per-tenant issuers build on this; SAML shops bridge SAML→OIDC at the
  IdP.

Unknown modes fail closed at startup. Run several modes together with `MEMOTURN_AUTH_MODES`
(e.g. `["api_key", "oidc"]`). Set `MEMOTURN_REQUIRE_AUTH=true` in production so the server
refuses to start while auth is still `none`. WebSocket clients should authenticate via the
`Authorization` header or the `memoturn.bearer` subprotocol; disable the deprecated `?token=`
query parameter with `MEMOTURN_AUTH_WS_ALLOW_QUERY_TOKEN=false` once clients have migrated.

**Roles:** `viewer` (read), `member` (chat + manage own sessions/fibers), `admin` (full within
tenant), `superadmin` (cross-tenant). **Hard tenant isolation:** the effective tenant is derived from
the authenticated principal — a non-superadmin cannot address another tenant's agents.

## Secrets

Secrets resolve from mounted files (`/run/secrets/<NAME>`, e.g. Kubernetes/Docker secrets) first,
then environment variables. Never bake secrets into images. Relevant keys: `ANTHROPIC_API_KEY`,
`MEMOTURN_AUTH_JWT_SECRET`, `MEMOTURN_BLOB_ENCRYPTION_KEY`. A Vault-backed provider can be added
behind `SecretProvider`.

## Encryption

- **In transit** — terminate TLS at your ingress / load balancer (and use `wss://` for WebSockets).
  Then opt into `MEMOTURN_HSTS_ENABLED=true` and `MEMOTURN_TLS_REQUIRED=true` so the app itself
  rejects plain HTTP (`X-Forwarded-Proto` aware; `/health` stays exempt for probes). Security
  response headers are on by default (`MEMOTURN_SECURITY_HEADERS_ENABLED`).
- **At rest** — set `MEMOTURN_BLOB_ENCRYPTION_KEY` to encrypt workspace blobs (Fernet/AES). Encrypt
  the volume backing `/data` (SQLite databases) at the storage layer (e.g. LUKS, EBS encryption).

## Rate limiting & quotas

Per-tenant controls: `MEMOTURN_RATE_LIMIT_PER_MINUTE` and `MEMOTURN_QUOTA_TURNS_PER_DAY` (0 = off).
The default in-process limiter suits a single replica. For multi-replica scale-out, set
`MEMOTURN_REDIS_URL` (and install the `redis` extra) so limits/quotas are enforced **across all
replicas** from one shared store — otherwise each replica keeps its own counters and the effective
limit is N× too loose. The recommended store is **Valkey** (BSD-3, Redis-protocol-compatible — the
`redis-py` client and `redis://`/`rediss://` URLs are unchanged); `validate_runtime()` warns at
startup when scale-out is enabled with limits on but no Redis URL.

Mutating REST routes carry an additional per-principal limit: `MEMOTURN_REST_RATE_LIMIT_PER_MINUTE`
(falls back to the per-tenant value).

## Observability

- Set `MEMOTURN_OTEL_ENABLED=true` (install the `otel` extra) to emit traces for agent turns, tool
  calls, and fiber runs. Configure the exporter via standard `OTEL_*` environment variables.
- **Audit log** — security-relevant actions are emitted as JSON on the `memoturn.audit` logger;
  route it to your SIEM and retain per policy.

## Backup & disaster recovery

- Per-agent state is SQLite under `<data>/agents/<tenant>/<name>.db` (WAL mode) plus blobs under
  `<data>/blobs`. Run `scripts/backup.sh` (uses SQLite's online `.backup`, safe on a live system) on
  a schedule and ship the tarball to object storage with versioning.
- **Restore:** stop the control plane, extract the tarball into the data directory, restart.
- Snapshot the `/data` volume regularly as an additional recovery point.

## High availability & scale-out

Per-agent SQLite requires a single writer, so each agent is owned by exactly one replica.

**Single replica (default).** Run one control-plane replica with a `ReadWriteOnce` volume (the Helm
chart uses `Recreate`). For HA, rely on fast restart + a replicated/snapshotted volume.

**Horizontal scale-out.** Set `MEMOTURN_SCALEOUT_ENABLED=true` with a **shared control plane**
(`MEMOTURN_POSTGRES_DSN=...`) and a durable snapshot backend (below); `validate_runtime()` **fails
fast at startup** if either is missing. Each replica heartbeats into the `replicas` table; a consistent hash
ring maps `tenant/name` to an owning replica. **Requests that reach a non-owner are transparently
proxied to the owner** — REST is forwarded and the owner's response relayed; WebSocket frames are
bridged to the owner's socket. Clients talk to any replica (or a plain round-robin LB) and never
handle redirects. A `_mt_proxied` marker prevents loops during membership churn (a forwarded request
that still isn't local falls back to HTTP 421 / a `misdirected` event instead of re-forwarding).

Per-replica settings: `MEMOTURN_REPLICA_ID` (defaults to hostname), `MEMOTURN_REPLICA_ADDRESS` (the
URL peers proxy to — must be reachable cluster-internally), `MEMOTURN_REPLICA_HEARTBEAT_SECONDS`,
`MEMOTURN_REPLICA_STALE_SECONDS`.

> Each replica still needs its own agent-storage volume (per-agent SQLite is owner-local). The
> shared Postgres holds only membership + agent/tenant metadata. The chart's HPA `maxReplicas` can
> be raised once scale-out is enabled; give each replica a distinct `MEMOTURN_REPLICA_ADDRESS`.

**Durable snapshots (elastic resizing).** With only owner-local volumes, the fleet must stay a fixed
size — adding/removing a replica reassigns ownership, but the new owner has none of the agent's data.
Enable **object-storage-backed snapshots** to make state *follow ownership*: set
`MEMOTURN_SNAPSHOT_BACKEND=s3` (with `MEMOTURN_S3_*`) — or `file` for a shared/NFS volume. Each agent
is snapshotted to object storage on hibernate (SQLite online backup, a consistent copy) and restored
on its next wake, on whatever replica now owns it; the local disk becomes a hot cache that's evicted
after each flush (`MEMOTURN_SNAPSHOT_EVICT_LOCAL=true`). On every ring rebalance the shard manager
hibernates agents this replica no longer owns, flushing their snapshots so the new owner restores
current state. Combined with hibernation this is **scale-to-zero**: an idle agent is just an object in
storage.

**Shared profiles at scale (pgvector).** By default each shared profile is a per-profile SQLite DB,
owner-routed under scale-out. For very large profiles, set `MEMOTURN_PROFILE_BACKEND=postgres` (+ the
`postgres` extra and `MEMOTURN_PROFILE_POSTGRES_DSN`, or reuse `postgres_dsn`): profiles then live in
one shared Postgres + pgvector table with Postgres full-text + HNSW vector search. Postgres is the
shared, concurrency-safe store, so pg-backed profiles need **no owner-routing or leases**. Set
`MEMOTURN_PROFILE_EMBEDDING_DIM` to your embedding model's dimension.

**Ownership leases (single writer under churn).** A control-plane **lease** guarantees one live
writer per agent even while membership is in flux. A replica acquires the agent's lease (in the
`agent_leases` table) before going live, renews it every shard-manager tick, and releases it on
hibernate (after the snapshot is flushed). If another replica still holds a valid lease, the
ring owner **transparently proxies the request to the current lease holder** (REST and WebSocket
alike) until it releases — migration is invisible to clients, no retry hop. The proxy check is a
cold-path-only control-plane read: a warm owner that already holds the agent live skips it entirely.
If the holder's address can't be resolved, the new owner falls back to a brief retry and then **HTTP
503 / `Retry-After`** (WebSocket: an error event). Tune with
`MEMOTURN_LEASE_TTL_SECONDS` (default 30s; keep it well above `MEMOTURN_REPLICA_HEARTBEAT_SECONDS`;
0 disables leases). Together with durable snapshots this makes the fleet safe to **autoscale** —
add/remove replicas freely, including under live write load.

## Sandbox hardening

For untrusted/multi-tenant code execution use a hardened backend; the default `subprocess` backend is
**not** a strong isolation boundary and is for trusted/single-tenant or development use.

- **`docker`** — throwaway container, no network, dropped caps, read-only rootfs, non-root,
  memory/CPU/PID limits. For single-host Docker deployments.
- **`k8s`** — on Kubernetes, schedules a throwaway **gVisor-isolated** exec pod per run (no
  service-account token, non-root, read-only rootfs, all caps dropped, seccomp RuntimeDefault,
  resource limits, hard `activeDeadlineSeconds`). Set `MEMOTURN_SANDBOX_K8S_RUNTIME_CLASS` to your
  cluster's gVisor RuntimeClass (`gvisor` on GKE Sandbox; an EKS gVisor node pool otherwise) and
  `MEMOTURN_SANDBOX_K8S_NAMESPACE` to a namespace with a **deny-all NetworkPolicy** (a pod can't
  self-disable networking). Needs the `k8s` extra and an in-cluster service account with permission
  to create/read/delete pods in that namespace. The Helm chart ships a default-deny
  NetworkPolicy for the control-plane pods (`networkPolicy.enabled=true`) that allows the
  bridge port in from the sandbox namespace and nothing else. **Capabilities:** enable the **network capability
  bridge** (`MEMOTURN_SANDBOX_K8S_BRIDGE_ENABLED=true`) so in-code `workspace`/`caps` work — sandbox
  pods connect back to the launching control-plane pod (its `POD_IP`) on
  `MEMOTURN_SANDBOX_K8S_BRIDGE_PORT` (default 8077) using a one-time per-execution token (expires shortly after the pod's own deadline); scope the
  namespace's NetworkPolicy to allow *only* that egress. Without the bridge the backend is pure
  compute (capabilities fail closed). Runtime `dependencies` aren't supported yet
  (see the [roadmap](/roadmap/)).

## Supply chain

CI gates are **blocking**: dependency audit (pip-audit), image scan (Trivy, CRITICAL/HIGH),
and SAST (bandit). Triaged findings are
allowlisted explicitly (`.trivyignore`, `[tool.bandit]`) with rationale — never
silently skipped. CI also generates an SBOM (Syft) and lints the Helm chart on every change. Pin
and review image bases and dependencies before release.
