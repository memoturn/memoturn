# 05 — Deployment: Kubernetes, Helm, Multi-Cloud

One Helm umbrella chart deploys a complete Memoturn cell to any Kubernetes — EKS, GKE, AKS, or
self-hosted — for both Memoturn Cloud and the self-hosted enterprise offering.

## Kubernetes design

| Workload | Kind | Notes |
| --- | --- | --- |
| `memoturnd` data plane | **Deployment** (not StatefulSet) | object storage is the source of truth, so pods are disposable; ephemeral local NVMe (`emptyDir` on NVMe-backed node pools / local SSD instance types). [ADR-0008](../adr/0008-deployment-not-statefulset.md) |
| `memoturn-gateway` | Deployment + HPA | stateless; scales on RPS/CPU |
| `memoturn-api` | Deployment | control-plane REST |
| etcd | external endpoints (`cluster.etcd.endpoints`) | 3–5 nodes spread across zones; the chart **refuses `dataplane.replicas > 1` without it** (the in-process lease table cannot prevent split-brain), and a single replica runs with `MEMOTURN_SINGLE_NODE=1` |
| Postgres | CloudNativePG subchart or external DSN | catalog |
| MinIO | optional, in-chart (`minio.enabled`) | self-hosted/dev only — pinned image, secret-based credentials; cloud uses native object storage |

**Graceful upgrades:** `preStop` hook drains writer leases (hand DBs to peers, finish segment
shipping) before termination; `terminationGracePeriodSeconds` sized to drain time;
PodDisruptionBudgets keep quorum and capacity. Rolling a node should cost milliseconds of write
pause per database, not failovers.

**Autoscaling:** the fleet scales on *hot* load (open handles, cache pressure, CPU), not database
count — millions of cold DBs are free. Scale-in drains leases first (same preStop path).

**No operator/CRDs in v1** — the control plane is API-driven; an operator (`MemoturnCell` CRD) is
an enterprise-phase nicety.

## Helm chart structure

```
deploy/helm/memoturn/
  Chart.yaml
  values.yaml
  templates/            # memoturnd Deployment, MinIO (dev), ServiceAccount, NetworkPolicy, PDB
```

Key parameterization (`values.yaml` — see the file for the full annotated shape):

```yaml
dataplane:     { replicas: 1, hotHandleCap: 50000, cacheSize: 10Gi, tmpSize: 64Mi }
cluster:       { etcd: { enabled: false, endpoints: "" } }   # required before replicas > 1
objectStorage: { backend: minio | s3, s3: { bucket, region, existingSecret } }
minio:         { enabled: true }       # dev/self-hosted only; pinned image, secret-based creds
auth:          { enabled: true, existingSecret: memoturn-auth }
               # secret keys: PLATFORM_KEY + CLUSTER_KEY, plus AUTH_KEY (base64 PKCS8
               # Ed25519) for multi-replica fleets so tokens validate across pods
server:        { requestTimeoutSecs, maxBodyBytes, maxConcurrency, controlRate,
                 durability, gcGraceSecs, persistAuthKey }   # node knobs; empty = built-in default
ai:            { existingSecret, extractModel, embedProvider, embedModel, embedBaseUrl }
networkPolicy: { enabled: true, allowExternalIngress: true, allowHttpsEgress: true,
                 extraIngressFrom: [], extraEgress: [] }
podDisruptionBudget: { enabled: false, minAvailable: 1 }     # recommended for multi-replica
```

Same chart, two profiles: **Cloud** (we operate, cloud object storage, managed Postgres) and
**self-hosted enterprise** (their cluster, MinIO or their bucket, their ingress).

## Multi-cloud notes

- All object-storage access goes through the Rust `object_store` crate — S3, GCS, Azure Blob, and
  MinIO behind one API, including the conditional-write (CAS) operations fencing depends on.
- Credential modes: IRSA (EKS), Workload Identity (GKE/AKS), static keys (MinIO/self-hosted).
- Node-pool guidance per cloud documented in chart README (NVMe-backed instance types).

## Security

- **Secure-by-default pods:** `runAsNonRoot` (uid 65532), read-only root filesystem, all Linux
  capabilities dropped, no privilege escalation, `RuntimeDefault` seccomp. The only writable
  paths are explicit `emptyDir` mounts (`/var/lib/memoturn` cache tier, `/tmp` scratch).
- **Dedicated ServiceAccount with no API token mounted** — `memoturnd` never calls the
  Kubernetes API, so the pod carries no credential for it.
- **NetworkPolicy:** ingress only on the HTTP port (`allowExternalIngress`/`extraIngressFrom` to
  restrict further; node-to-node write forwarding always allowed); egress locked to DNS, the
  object store, and optionally TCP 443 for managed S3/AI providers (`allowHttpsEgress: false`
  for a fully in-cluster deployment; `extraEgress` for etcd or sidecars). Egress lockdown is the
  high-value control for a data store — it blocks exfiltration paths.
- **Auth is fail-closed:** the chart wires `MEMOTURN_AUTH=on` to `auth.existingSecret`
  (`PLATFORM_KEY`, `CLUSTER_KEY`, optional `AUTH_KEY` signing key); a multi-replica fleet needs
  `AUTH_KEY` so tokens validate across pods. `server.persistAuthKey` instead persists a generated
  key to object storage (unencrypted) — prefer the secret in production.
- **PodDisruptionBudget** for multi-replica deployments; MinIO (dev) runs a pinned image with
  secret-based credentials, never `:latest`.
- TLS via cert-manager at the ingress; secrets via K8s secrets (External Secrets Operator
  compatible for enterprise).

## Observability

Shipped in the chart (optional subchart): kube-prometheus-stack + OTel collector + Grafana
dashboards. The SLO panel:

| SLO | Target |
| --- | --- |
| provision latency p50 | < 100 ms (target ~10 ms) |
| cold-wake p50 / p99 (≤16 MB) | < 200 ms / < 1 s |
| hot KV read p50 / SQL-doc write p50 | < 1 ms / < 5 ms |
| branch create/rewind p50 | < 50 ms |
| replication lag p99 (in-region) | < 1 s |
| lease failover (kill → writes resume) | < 15 s |
| segment-shipping backlog | ~0 sustained |
