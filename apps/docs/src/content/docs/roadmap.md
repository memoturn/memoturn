---
title: Roadmap
description: Tracked work across memory, scale-out, deployment, and the Enterprise Edition — and what's already shipped.
---


Tracked work and what's already shipped. See [architecture.md](/architecture/) and
[operations.md](/operations/) for the full picture of what exists today.

## Enterprise Edition

> **Open-core split — done.** The Apache-2.0 core (`memoturn`) and the separately-licensed
> `memoturn-enterprise` distribution are wired through a runtime plugin seam
> ([`plugins.py`](../src/memoturn/plugins.py)); a build without the package runs as a pure
> open-source control plane. See [Enterprise Edition](/enterprise/).

> **SSO + SCIM — done.** OIDC bearer verification with per-tenant issuers and console login
> ([SSO](/sso/)), and SCIM 2.0 user/group provisioning ([SCIM](/scim/)).

> **Runtime API keys — done.** Hashed, anti-escalation keys issued at runtime via
> `/v1/admin/api-keys` ([API keys](/api-keys/)).

> **Persistent audit trail — done.** `MEMOTURN_AUDIT_PERSIST_ENABLED` persists audit events to a
> queryable store behind `GET /v1/admin/audit`, with an optional OTel SIEM export.

> **Usage-metered Stripe billing — done.** Four meters (tokens/turns/compute_s/storage), a
> free/pro/enterprise/suspended plan ladder, self-serve signup + checkout/portal, and an
> idempotent, retrying Stripe webhook. See [Billing](/billing/).

## Memory

> **Bounded history retention — done.** `MEMOTURN_MEMORY_HISTORY_RETENTION_DAYS` and/or
> `MEMOTURN_MEMORY_HISTORY_MAX_PER_TOPIC` (0 = keep forever) bound superseded/forgotten versions:
> [`MemoryStore`](../src/memoturn/memory/long_term.py) hard-deletes inactive rows older than the
> window and/or beyond the newest N per `topic_key` (active versions never pruned), clearing the FTS
> entry + `sqlite_vec` shadow. Runs opportunistically on `remember` and via an admin sweep
> (`POST /v1/agents/{name}/memories/prune`, and the profile equivalent).

> **In-region embeddings — done.** `MEMOTURN_MEMORY_EMBEDDER=bedrock` (Titan/Cohere) or `vertex`
> (text-embedding) keeps semantic-recall embeddings in your cloud/region for data residency, reusing
> the `Embedder` seam ([`memory/embeddings.py`](../src/memoturn/memory/embeddings.py)); credentials
> from the cloud default chain. With the Bedrock/Vertex LLM provider + pgvector profiles, a GKE
> deployment can run fully in-region: inference, embeddings, vectors, and state.

## Scale-out

> **Done.** Durable object-backed snapshots ([`storage/snapshots.py`](../src/memoturn/storage/snapshots.py))
> let agent state follow ownership; the cross-replica **ownership lease** (`agent_leases` in the
> control plane) guarantees a single live writer even during membership churn; and the **lease-aware
> proxy handoff** makes migration latency-transparent (the new ring owner bridges to the current
> lease holder until it releases, instead of returning 503). Together these make the fleet safe to
> autoscale with no client-visible disruption. See
> [operations.md](/operations/#high-availability--scale-out).

## Vector search

> **pgvector profile backend — done.** `MEMOTURN_PROFILE_BACKEND=postgres` stores shared profiles in
> one Postgres + pgvector table ([`memory/pg.py`](../src/memoturn/memory/pg.py)) with Postgres FTS +
> HNSW cosine search, for profiles that outgrow per-profile SQLite. Because Postgres is the shared
> store, pg-backed profiles need **no owner-routing or leases** — any replica reads/writes directly.
> Needs the `postgres` extra + `MEMOTURN_PROFILE_POSTGRES_DSN` (or `postgres_dsn`); set
> `MEMOTURN_PROFILE_EMBEDDING_DIM` to match your embedding model.

## Deployment

See [deployment-plan.md](/deployment/) for the cluster choice and decision record. Production
(untrusted code + compliance + BYOC) targets **Kubernetes (GKE/EKS)** via the Helm chart, the single
shippable artifact; local dev uses the same chart on kind/k3d. Build items it defines:

- **Hardened K8s sandbox backend** — **done** (`MEMOTURN_SANDBOX_BACKEND=k8s`, gVisor exec pods, see
  [`sandbox/k8s.py`](../src/memoturn/sandbox/k8s.py)), **with the network capability bridge** so
  in-pod `workspace`/`caps` work (`MEMOTURN_SANDBOX_K8S_BRIDGE_ENABLED=true`; token-multiplexed TCP,
  see [`sandbox/bridge.py`](../src/memoturn/sandbox/bridge.py)). The **deny-all-except-bridge
  NetworkPolicy** for the sandbox namespace ships in both the GKE Terraform module and the Helm
  chart (`sandbox.networkPolicy.enabled`). Follow-up: **dependency support** in pods.
- **Terraform module** — **GKE done** ([`deploy/terraform/gke`](../deploy/terraform/gke): private GKE
  + gVisor sandbox pool + Cloud SQL + CMEK GCS + NetworkPolicy + wired Helm release). Follow-up: an
  **EKS module** (gVisor there needs a custom Bottlerocket+gVisor node AMI, unlike GKE Sandbox).
- **In-region LLM provider** — **done** (`MEMOTURN_LLM_PROVIDER=bedrock` / `vertex`): Claude via
  Bedrock/Vertex for data residency, reusing `AnthropicProvider` with an injected client. In-region
  embeddings are also done — see [Memory](#memory) above.
- **Shared rate limiter** — **done** (`MEMOTURN_REDIS_URL` → `RedisRateLimiter`): per-tenant
  limits/quotas enforced across replicas (ElastiCache/Memorystore/any Redis); in-process fallback.

## Pluggable backends

The `Sandbox` and `Durability` interfaces are deliberately shaped to accept backends beyond the
shipped ones. **On the roadmap — interface targets, not shipped:**

> **Firecracker microVM sandbox.** A `Sandbox` backend running untrusted code in a KVM-isolated
> Firecracker microVM, alongside the shipped subprocess / Docker / gVisor-on-Kubernetes backends —
> hardware-grade isolation without a Kubernetes cluster.

> **Temporal-backed durability.** A `Durability` backend that runs fibers as Temporal workflows for
> distributed durable execution, as an alternative to the shipped SQLite checkpoint engine.
