---
title: Deployment
description: Running Memoturn from a single dev node to a Kubernetes cell with Helm, ephemeral NVMe, and multi-cloud object storage.
---

Memoturn nodes are disposable. Object storage is the source of truth; local disk is a cache. That
single invariant shapes every deployment topology on this page: no node ever needs its disk to
survive, so there are no PersistentVolumes anywhere in the data plane.

## Local development

A single node needs nothing but the binary. It listens on `127.0.0.1:8080`, keeps its cache under
`./data`, and uses a local-filesystem object store at `./data/objects`:

```bash
cargo run -p memoturnd
```

Auth is off by default in dev (the node warns loudly). See [Configuration](/configuration/) for
every `MEMOTURN_*` variable and [Security & tokens](/security/) for enabling auth.

## Multi-node development

Multiple nodes need two shared things: etcd for writer leases and a common object store.

```bash
docker run -d -p 2379:2379 quay.io/coreos/etcd:v3.5.21 etcd \
  --listen-client-urls http://0.0.0.0:2379 --advertise-client-urls http://0.0.0.0:2379

MEMOTURN_ETCD=http://127.0.0.1:2379 MEMOTURN_OBJECT_STORE=s3://bucket \
  MEMOTURN_LISTEN=0.0.0.0:8081 memoturnd
```

Each node holds one etcd lease; databases attach to their owner node's lease. Writes arriving at
the wrong node are forwarded to the owner. See [Scaling & tiering](/scaling/) for the lease model.

etcd is enforced, not assumed: without `MEMOTURN_ETCD`, a node **refuses to start** when it looks
multi-node — auth on, or a non-loopback `MEMOTURN_ADVERTISE` — unless `MEMOTURN_SINGLE_NODE=1`
declares it genuinely alone. The in-process lease fallback is safe for exactly one node.

## Kubernetes

One Helm umbrella chart (`deploy/helm/memoturn`) deploys a complete Memoturn cell to any
Kubernetes — EKS, GKE, AKS, or self-hosted. The same chart serves both the cloud profile and the
self-hosted profile (MinIO or your own bucket, your ingress).

| Workload | Kind | Notes |
| --- | --- | --- |
| `memoturnd` data plane | **Deployment** (not StatefulSet) | pods are disposable; ephemeral local NVMe via `emptyDir`; no PersistentVolumes |
| `memoturn-gateway` | Deployment + HPA | stateless router; scales on RPS/CPU |
| `memoturn-api` | Deployment | control-plane REST |
| etcd | 3 nodes, spread across zones | or point at external endpoints |
| Postgres | subchart or external DSN | control-plane catalog |
| MinIO | optional subchart | dev/self-hosted only; cloud uses native object storage |

The data plane is a Deployment because object storage holds all durable state. A replaced pod
starts with an empty `emptyDir`, restores what it needs from the bucket, and serves the same data
with the same tokens. StatefulSets, PVCs, and volume scheduling buy nothing here.

### Chart parameters

Real keys from `values.yaml`:

```yaml
dataplane:
  replicas: 1                # > 1 requires cluster.etcd.enabled — the chart refuses otherwise
  hotHandleCap: 50000        # MEMOTURN_HOT_CAP
  cacheSize: 10Gi            # emptyDir sizeLimit for the local cache tier
  resources:
    requests: { cpu: 250m, memory: 512Mi }
    limits: { memory: 2Gi }

cluster:
  etcd:
    enabled: false           # required for replicas > 1; a single replica runs MEMOTURN_SINGLE_NODE=1
    endpoints: ""            # "http://etcd-0:2379,http://etcd-1:2379"

objectStorage:
  backend: minio             # minio | s3 (gcs/azure arrive with the object_store config surface)
  s3:
    bucket: memoturn
    region: us-east-1
    existingSecret: ""       # AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY, or IRSA/workload identity

minio:
  enabled: true              # dev/self-hosted only; pinned image, secret-managed credentials

auth:
  enabled: true
  existingSecret: memoturn-auth   # keys: PLATFORM_KEY, CLUSTER_KEY (+ AUTH_KEY for multi-replica)

server:                      # request-surface + durability knobs; empty = node default
  requestTimeoutSecs: ""     # MEMOTURN_REQUEST_TIMEOUT (default 30)
  maxBodyBytes: ""           # MEMOTURN_MAX_BODY_BYTES (default 32 MiB)
  maxConcurrency: ""         # MEMOTURN_MAX_CONCURRENCY (default 1024)
  controlRate: ""            # MEMOTURN_CONTROL_RATE (default 10 req/s)
  durability: ""             # "" (standard) | durable — ack writes only after they ship
  gcGraceSecs: ""            # MEMOTURN_GC_GRACE_SECS (default 600)
  persistAuthKey: false      # persist a generated signing key to object storage (unencrypted)

networkPolicy:
  enabled: true              # egress locked to DNS + object store + optional 443
  allowExternalIngress: true # false restricts ingress to extraIngressFrom (+ node-to-node)
  allowHttpsEgress: true     # false for fully in-cluster (MinIO + self-hosted embedder)
  extraIngressFrom: []
  extraEgress: []            # e.g. etcd (TCP 2379)

podDisruptionBudget:
  enabled: false             # recommended for multi-replica (etcd) deployments
  minAvailable: 1

ai:
  existingSecret: ""         # optional: EXTRACT_API_KEY and/or EMBED_API_KEY
  embedProvider: ""          # voyage | openai (openai + embedBaseUrl reaches any compatible server)
```

### Hardened by default

The chart's security posture needs nothing turned on:

- Pods run **non-root (uid 65532)** with a **read-only root filesystem**, all Linux capabilities
  dropped, and the RuntimeDefault seccomp profile; the only writable paths are explicit
  `emptyDir` mounts.
- A dedicated **ServiceAccount with no Kubernetes API token** — `memoturnd` never calls the
  K8s API.
- A **NetworkPolicy** locks egress to DNS, the object store, and (optionally) TCP 443; adjust
  the edges with `allowExternalIngress`, `extraIngressFrom`, and `extraEgress`.
- The dev **MinIO subchart** uses a pinned image and secret-managed credentials — and is not for
  production.
- Setting `replicas > 1` without `cluster.etcd.enabled` **fails at template time**: the
  in-process lease table cannot prevent split-brain. A single replica runs with
  `MEMOTURN_SINGLE_NODE=1`.

### Install

```bash
kubectl create secret generic memoturn-auth \
  --from-literal=PLATFORM_KEY=... --from-literal=CLUSTER_KEY=...
helm install memoturn deploy/helm/memoturn
kubectl port-forward svc/memoturn 8080:8080
```

For more than one replica: enable `cluster.etcd` with endpoints, add `AUTH_KEY` (base64 PKCS#8
Ed25519 signing key) to the auth Secret so tokens validate across pods, and consider
`podDisruptionBudget.enabled=true`.

`helm lint deploy/helm/memoturn` validates the chart.

## Multi-cloud object storage

All object-storage access goes through the Rust `object_store` crate — S3, GCS, Azure Blob, and
MinIO behind one API, including the conditional-write (CAS) operations that epoch fencing depends
on. Credential modes per cloud:

- **IRSA** on EKS
- **Workload Identity** on GKE/AKS
- **Static keys** for MinIO and self-hosted clusters (via `objectStorage.s3.existingSecret`)

For in-cluster MinIO or other HTTP endpoints, the node honors `AWS_ENDPOINT` and
`AWS_ALLOW_HTTP=true`.

## Graceful upgrades and autoscaling

- A `preStop` hook drains writer leases — hand databases to peers, finish segment shipping —
  before termination; `terminationGracePeriodSeconds` is sized to drain time, and
  PodDisruptionBudgets keep quorum and capacity. Rolling a node costs milliseconds of write pause
  per database, not failovers.
- The fleet autoscales on **hot** load (open handles, cache pressure, CPU), never on database
  count — millions of cold databases are free. Scale-in drains leases first, on the same preStop
  path. See [Scaling & tiering](/scaling/).

## Proven on kind

The chart deploys a working, authenticated cell to kind with in-cluster MinIO
(`docs/deployment-proof.md` in the [repository](https://github.com/memoturn/memoturn)). All HTTP
benchmarks pass through the full stack — provision 1.61 ms p50, memory ingest 2.81 ms p50,
write + segment ship to MinIO 6.54 ms p50.

Nodes are disposable, and we test the claim by killing one: `kubectl delete pod` on the data plane brings up
a replacement with a fresh `emptyDir` and **no PersistentVolume**, and in roughly 15 s the same
tokens read the same data — KV, documents, and a typed memory recalled by topic key. (Driving the
test through `kubectl port-forward` adds time to re-establish the forward.) Cold wake replays the
snapshot and segment chain for each touched database.

Next: [Configuration](/configuration/) for the full env-var reference,
[Observability](/observability/) for SLOs and dashboards.
