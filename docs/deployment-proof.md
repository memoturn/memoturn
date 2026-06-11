# Deployment Proof — kind + Helm + MinIO (2026-06-10, refreshed with the memory layer)

The Helm chart deploys a working, authenticated Memoturn cell to Kubernetes,
and the disposable-node architecture holds: a killed data-plane pod recovers
all state from object storage with no PersistentVolume.

## Setup

```bash
docker build -t memoturn/memoturnd:0.1.0 .
kind create cluster --name memoturn
kind load docker-image memoturn/memoturnd:0.1.0 --name memoturn
kubectl create secret generic memoturn-auth \
  --from-literal=PLATFORM_KEY=... --from-literal=CLUSTER_KEY=...
# For tokens to survive pod replacement (the chaos test below), also give the
# secret an AUTH_KEY (base64 PKCS8 Ed25519), or set --set server.persistAuthKey=true
# (persists a generated key to object storage, unencrypted — secret preferred).
helm install memoturn deploy/helm/memoturn     # memoturnd + in-cluster MinIO
kubectl port-forward svc/memoturn 8080:8080
```

Topology: 1× `memoturnd` (Deployment, `emptyDir` cache tier, auth **on**,
`MEMOTURN_SINGLE_NODE=1` — the chart refuses more replicas without
`cluster.etcd.enabled`) + 1× MinIO (`s3://memoturn`, path-style,
`AWS_ALLOW_HTTP`). Pods run the chart's secure-by-default posture: non-root
(uid 65532), read-only root filesystem, all capabilities dropped, no API token
mounted, NetworkPolicy on (DNS + MinIO + optional 443 egress only).

## HTTP benchmarks through the full stack

`python3 scripts/bench-http.py http://127.0.0.1:8080 --platform-key ... --n 200`
— full client-experienced latency: port-forward + service + auth middleware +
engine + MinIO.

| metric | target | p50 | p99 |
| --- | --- | --- | --- |
| memory ingest (typed fact, ns token) | <25 ms | **2.81 ms** | 7.53 ms |
| hybrid recall @1k memories | <50 ms | **4.08 ms** | 5.97 ms |
| provision database | <100 ms | **1.61 ms** | 3.43 ms |
| hot SQL write | <10 ms | **1.59 ms** | 2.83 ms |
| hot KV write / read | <10 / <5 ms | **1.66 / 1.63 ms** | 3.53 / 2.94 ms |
| hot doc insert / find | <10 ms | **1.65 / 1.65 ms** | ~3.1 ms |
| branch create (CoW) | <100 ms | **3.01 ms** | 3.69 ms |
| write + segment ship (to MinIO) | <50 ms | **6.54 ms** | 8.67 ms |

The memory rows run the headline product through the full stack: a namespace
token minted via `/v1/namespaces/{ns}/tokens`, a profile auto-created on first
ingest, 1k memories seeded with 64-dim embeddings, then hybrid
(FTS5 + topic + ANN) recall.

Hot-path p50s are dominated by network hops (~1.6 ms floor through the
port-forward); the engine cost underneath is microseconds (see README). The
segment ship reflects a real object-storage PUT round-trip.

## Chaos: kill the data-plane pod (`scripts/chaos-pod-kill.sh`)

1. Provision `chaos-agent` (admin JWT, KV + document) **and a memory profile**
   `chaos/alice` (namespace token, typed fact with a topic key); `sync` both.
2. `kubectl delete pod -l app.kubernetes.io/component=dataplane`.
3. Replacement pod (fresh `emptyDir`, nothing local): **~30 s** after the kill
   (pod start + port-forward re-establish dominate), the **same tokens** read
   the **same data** — `kv = "survives pod death"`, document intact, and
   `recall {"topic_key": "user.seat"}` returns Alice's fact with its txid.
   If you drive the test through `kubectl port-forward`, restart the forward
   after the new pod is ready (the old one pins the dead pod).

What made that work, in order: the auth signing key survives the pod (from the
auth secret's `AUTH_KEY`, or via `server.persistAuthKey=true` which persists a
generated key to object storage — the secret is the production posture) and the
prototype catalog restores from object storage on startup (production: catalog
in the control-plane Postgres — doc 03), then cold wake replays the snapshot +
segment chain for the touched database.

## Caveats / next

- Single-node cell as shipped (`dataplane.replicas: 1`). Multi-node is a values
  change — `cluster.etcd.enabled=true` plus reachable endpoints (the chart
  doesn't deploy etcd itself, and refuses extra replicas without it). The full
  multi-node data path — lazy ownership, write forwarding, failover, epoch
  fencing — is verified against a real etcd in
  `crates/api/tests/distribution_etcd.rs` (gated on `ETCD_ENDPOINTS`).
- MinIO on `emptyDir` — fine for kind; real clusters use S3/GCS/Azure or a
  persistent MinIO.
- EKS/GKE + real S3 is the next rung: same chart, `objectStorage.backend: s3`,
  IRSA credentials; expect cold wake + segment ship to gain same-region S3
  RTTs (~10–40 ms) — still far inside targets.
