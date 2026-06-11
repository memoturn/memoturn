---
title: Security & tokens
description: Fail-closed auth with Ed25519-signed JWTs, per-database and namespace tokens, structural profile isolation, the SQL guard, token revocation, and network security in Kubernetes.
---

Memoturn's isolation story has two layers: **structural** — a profile is its own database file,
and no data-plane operation can touch two profiles — and **token-based** — short-lived
Ed25519-signed JWTs that widen authorization only, never the data plane's reach.

## Auth modes

Auth is **off by default** in dev; the node logs a loud warning at startup. Enable it for any
shared deployment:

```bash
MEMOTURN_AUTH=on MEMOTURN_PLATFORM_KEY=... memoturnd
```

With auth on, the posture is **fail-closed**: the node refuses to start without
`MEMOTURN_PLATFORM_KEY` — there is no generated platform key to leak or lose. It signs
per-database JWTs with an Ed25519 key; signing-key precedence is `MEMOTURN_AUTH_KEY` (base64
PKCS#8 — in production, mounted from a Kubernetes Secret) → a local file under the data dir →
object storage (only with `MEMOTURN_PERSIST_AUTH_KEY=1`, which persists a generated key
**unencrypted** — the mounted Secret is the preferred path) → generate. A multi-replica fleet
must share the signing key, or pods reject each other's tokens. See
[Configuration](/configuration/) for all auth variables.

## Token kinds

| Token | Covers | Posture |
| --- | --- | --- |
| **Per-database token** | exactly one profile's database | the agent posture — an agent is locked to the one profile it serves |
| **Namespace token** (`ns` claim) | every profile under one namespace, including its control routes | the orchestrator posture — mint per-profile tokens, checkpoint memories, list profiles |
| **Platform key** | control-plane operations: provision databases, mint tokens | operators and provisioning code only |
| **Cluster key** | node-internal hops (write forwarding) | never leaves the cluster |

Scopes are `read`, `write`, and `admin`: recall and get need `read`; ingest, forget, and
session-end need `write`. Tokens are short-lived (default TTL 3600 s).

The cluster key **must differ** from the platform key — they are separate trust boundaries, and
the node refuses to start if they match. Unset, it is derived from the signing key, so it is
identical on every node in the fleet with no extra secret to manage.

```bash
# per-database token: one agent, one profile
memoturn --platform-key ... token create acme--alice --scope write

# namespace token: every profile under acme — the orchestrator posture
memoturn --platform-key ... token create-ns acme --scope write --ttl 3600
```

The same mints are available over HTTP (`POST /v1/databases/{db}/tokens`,
`POST /v1/namespaces/{ns}/tokens`) — see [REST API](/api-rest/).

## Stateless verification

Gateways verify JWTs statelessly with the Ed25519 public key — no auth-service round-trip on the
data path. Nodes additionally enforce lease epochs on every write, so a stolen-but-valid token
still cannot make a zombie writer dangerous (see [Consistency](/consistency/)).

## Structural isolation

A profile boundary is a database file. There is no query, filter, join, or recall operation that
spans two profiles — the isolation is not a row-level policy that could be bypassed, it is the
shape of the storage. A namespace token widens which profiles a caller may address, one at a
time; it does not create any cross-profile operation. See [Profiles](/profiles/).

A further structural guard: **per-tenant object-store prefixes** — each database's segments and
manifests live under its own prefix in the bucket.

## The SQL guard

The SQL escape hatch (`POST /v1/db/{db}/sql`) is walled in:

- **Reserved tables are unreachable.** Everything Memoturn manages inside a database —
  `__memoturn_kv`, `__memoturn_docs_{collection}`, `__memoturn_memories*` — carries the
  `__memoturn_` prefix and cannot be referenced from user SQL, however the name is quoted.
- **Read tokens cannot mutate.** Mutating statements need `write` scope; a read-scoped token
  gets `403`.
- **No sandbox escapes.** `ATTACH`, `VACUUM INTO`, and `PRAGMA writable_schema` are rejected.
  Benign read-only PRAGMAs (`integrity_check`, `table_info`) still work.

## Token revocation

Deleting a database — or the profile it backs — writes a deletion tombstone. Write tokens minted
before the deletion are rejected with `403` (`token revoked: it predates this database's
deletion; mint a fresh token`), so a stale token cannot resurrect a re-created profile of the
same name.

## Network security in Kubernetes

The Helm chart is hardened by default (see [Deployment](/deployment/)):

- **Secure-by-default pods** — non-root (uid 65532), read-only root filesystem, all Linux
  capabilities dropped, RuntimeDefault seccomp; writable paths are explicit `emptyDir` mounts.
- **No Kubernetes API access** — a dedicated ServiceAccount with no API token mounted.
- **NetworkPolicy** — egress locked to DNS, the object store, and (optionally) HTTPS for real
  S3 and AI providers; ingress restricted to the HTTP port, tightenable with
  `allowExternalIngress` and `extraIngressFrom`.
- **Secrets via Kubernetes Secrets** (External Secrets Operator compatible for enterprise). The
  chart consumes `auth.existingSecret` (keys `PLATFORM_KEY`, `CLUSTER_KEY`, plus `AUTH_KEY` for
  multi-replica fleets) and an optional `ai.existingSecret` for extraction/embedding keys.

TLS at the ingress (cert-manager) and JWT verification at the gateway remain part of the full
cell design.

## Data residency

A database's **primary region is chosen at creation**. Regions are independent cells — each with
its own etcd, gateways, data plane, and regional object-storage bucket — so the cell model maps
directly onto residency requirements: a profile created in the EU cell stays in the EU cluster
and its EU bucket. The global control plane sits on the provisioning path, never the data path.

## Operational notes

- Without `MEMOTURN_ETCD`, a node that looks multi-node — auth on, or a non-loopback
  `MEMOTURN_ADVERTISE` — refuses to start unless `MEMOTURN_SINGLE_NODE=1`: the in-process lease
  table cannot enforce single-writer across nodes.
- Per-tenant encryption keys wrapped by cloud KMS are planned for enterprise — see
  [Roadmap](/roadmap/).
