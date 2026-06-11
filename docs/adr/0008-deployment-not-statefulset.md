# ADR-0008: Data plane as Deployment with ephemeral NVMe; cells per region; no operator in v1

**Status:** accepted · 2026-06

**Decision:** `memoturnd` runs as a Kubernetes **Deployment** with ephemeral local NVMe, because
object storage is the source of truth and pods must be disposable (ADR-0003). Graceful rollouts
drain writer leases in `preStop`. Regions are independent **cells** (own etcd, gateways, data
plane, bucket); the global control plane sits on the provisioning path only. No CRDs/operator in
v1 — the control plane is API-driven; an operator is an enterprise-phase addition. One Helm
umbrella chart parameterizes object-storage backend, etcd/Postgres internal-vs-external, ingress,
and observability for both Memoturn Cloud and self-hosted enterprise.

**Rejected:** *StatefulSet + PVCs* — PVCs invite treating local state as durable, pin pods to
zones, slow failover, and complicate multi-cloud; the design gets durability from object storage
instead. *Global mesh topology* — cross-cell blast radius and data-residency entanglement.

**Deferred (tracked here):** cross-region replication (bucket CRR + remote replicas), per-tenant
KMS encryption, operator/CRDs, Durable-mode via low-latency object-storage tiers, billing
pipeline beyond Postgres counters.

**Update (2026-06):** the chart is security-hardened. The data plane refuses
`dataplane.replicas > 1` unless `cluster.etcd.enabled` (a single replica runs with
`MEMOTURN_SINGLE_NODE=1`). Pods are secure-by-default: non-root (uid 65532), read-only root
filesystem, all capabilities dropped, no privilege escalation, RuntimeDefault seccomp, explicit
`emptyDir` mounts for `/var/lib/memoturn` and `/tmp`; a dedicated ServiceAccount mounts no API
token. A NetworkPolicy locks egress to DNS + the object store (+ optional 443), with
`allowExternalIngress`/`extraIngressFrom`/`extraEgress` knobs; a PodDisruptionBudget covers
multi-replica; MinIO (dev) runs a pinned image with secret-based credentials. `server.*` exposes
the request/durability/GC knobs and `persistAuthKey`; `auth.existingSecret` carries
`PLATFORM_KEY`/`CLUSTER_KEY` (+ `AUTH_KEY` for multi-replica fleets).
