---
title: Configuration
description: Reference for every MEMOTURN_* environment variable, its default, and what it controls.
---

`memoturnd` is configured entirely through environment variables. There is no config file. The
Helm chart maps its `values.yaml` keys onto these same variables (see
[Deployment](/deployment/)), so this page is the single reference for both paths.

## Core

| Variable | Default | Description |
| --- | --- | --- |
| `MEMOTURN_DATA_DIR` | `./data` | Local cache directory: materialized database files, WAL segments, node registry. Disposable — safe to mount on `emptyDir`. |
| `MEMOTURN_LISTEN` | `127.0.0.1:8080` | HTTP listen address for the API server. |
| `MEMOTURN_OBJECT_STORE` | `file://{MEMOTURN_DATA_DIR}/objects` | Object-store URL — the source of truth. `file://path` (local filesystem), `s3://bucket` (S3-compatible, including MinIO), or `mem://` (in-process, tests only). |

S3-compatible stores read standard AWS credentials from the environment
(`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_DEFAULT_REGION`, `AWS_ENDPOINT`). Set
`AWS_ALLOW_HTTP=true` for plain-HTTP endpoints such as in-cluster MinIO.

## Clustering

| Variable | Default | Description |
| --- | --- | --- |
| `MEMOTURN_ETCD` | unset (in-process leases) | Comma-separated etcd endpoints. When set, writer leases are real etcd leases (TTL 10 s); unset runs a single-node in-process lease manager. |
| `MEMOTURN_ADVERTISE` | `http://{MEMOTURN_LISTEN}` | Address other nodes use to reach this node (write forwarding, segment push). |
| `MEMOTURN_NODE_ID` | `node-{pid}` | Node identity recorded in lease attachments. Set a stable value in any multi-node deployment. |
| `MEMOTURN_SINGLE_NODE` | unset | `1` declares a genuinely single node. Without `MEMOTURN_ETCD`, the node **refuses to start** when it looks multi-node — auth on, or a non-loopback `MEMOTURN_ADVERTISE` — because the in-process lease table cannot enforce single-writer across nodes. |

## Auth

Auth is **off by default** for local development; the node logs a loud warning. Enable it for any
shared deployment. With auth on the posture is **fail-closed**: the node refuses to start without
a platform key. Full model: [Security & tokens](/security/).

| Variable | Default | Description |
| --- | --- | --- |
| `MEMOTURN_AUTH` | off | `on` enables per-database Ed25519 JWTs, the platform key, and the cluster key — and requires `MEMOTURN_PLATFORM_KEY`. |
| `MEMOTURN_PLATFORM_KEY` | — (required when auth is on) | Control-plane key: provisions databases, mints tokens. Never generated — the node refuses to start without it. |
| `MEMOTURN_CLUSTER_KEY` | derived from the signing key | Key for node-internal hops (write forwarding between nodes). Must differ from the platform key — the node refuses to start if they match. Unset, it is derived from the signing key, so it is identical across the fleet with no extra secret to manage. |
| `MEMOTURN_AUTH_KEY` | unset | Base64 PKCS#8 Ed25519 signing key. Precedence: this variable (production: mounted from a Kubernetes Secret) → local file under the data dir → object storage (only with `MEMOTURN_PERSIST_AUTH_KEY=1`) → generate. A multi-replica fleet **must** share the signing key, or pods reject each other's tokens. |
| `MEMOTURN_PERSIST_AUTH_KEY` | unset | `1` persists a generated signing key to object storage — **unencrypted** — so it survives disposable pods. Prefer `MEMOTURN_AUTH_KEY` from a mounted Secret in production. |

## Tuning

| Variable | Default | Description |
| --- | --- | --- |
| `MEMOTURN_HOT_CAP` | `50000` | Maximum open hot database handles per node (the hot tier of the temperature model — see [Scaling & tiering](/scaling/)). |
| `RUST_LOG` | `memoturnd=info,memoturn_api=info,memoturn_replication=info` | Standard tracing filter for log verbosity. |

## Request limits & durability

The request surface is bounded by default; every knob is per node.

| Variable | Default | Description |
| --- | --- | --- |
| `MEMOTURN_REQUEST_TIMEOUT` | `30` | Per-request wall-clock budget, in seconds. |
| `MEMOTURN_MAX_BODY_BYTES` | `33554432` (32 MiB) | Body cap for data-bearing writes; larger requests return `413`. |
| `MEMOTURN_MAX_CONCURRENCY` | `1024` | Global in-flight request cap. |
| `MEMOTURN_CONTROL_RATE` | `10` | Control-endpoint requests per second (with burst headroom); sustained overruns return `429`. |
| `MEMOTURN_DURABILITY` | standard | `durable` acks every write only after its segment ships and the manifest CAS lands in object storage. The default acks on local WAL fsync and ships asynchronously. A request can escalate itself with the `Memoturn-Durability: durable` header — see [Consistency & txid](/consistency/#durability-modes). |
| `MEMOTURN_GC_GRACE_SECS` | `600` | Grace window before the refcount object GC reclaims unreferenced segments and manifests. |

## Opt-in features

Server-side extraction and auto-embedding are **per-node opt-ins that run outside the write
path**. Unconfigured, both stay bring-your-own: the extract endpoint returns 503, and ingest and
recall silently skip the vector channel for text-only requests.

### Extraction

| Variable | Default | Description |
| --- | --- | --- |
| `MEMOTURN_EXTRACT_API_KEY` | unset (extraction disabled) | API key for the extraction model. When set, `POST /v1/memory/{ns}/{profile}/extract` distills raw transcripts into typed memories. See [Extraction](/extraction/). |
| `MEMOTURN_EXTRACT_MODEL` | `claude-opus-4-8` | Model override for extraction. |

### Auto-embedding

| Variable | Default | Description |
| --- | --- | --- |
| `MEMOTURN_EMBED_API_KEY` | unset (embedding disabled) | API key for the embeddings provider. When set, bare-text ingest and recall get the vector channel automatically. See [Embeddings](/embeddings/). |
| `MEMOTURN_EMBED_PROVIDER` | `voyage` | `voyage` or `openai`. The `openai` provider speaks the OpenAI-compatible embeddings protocol, so it also reaches local servers. |
| `MEMOTURN_EMBED_MODEL` | provider default | Embedding model override. |
| `MEMOTURN_EMBED_BASE_URL` | provider default | Base URL override — point the `openai` provider at any OpenAI-compatible server, including a self-hosted one. |
| `MEMOTURN_EMBED_SELF_HOSTED_HOSTS` | unset | Comma-separated hosts to treat as self-hosted for the `ai_egress.embed: self_hosted_only` governance rule — covers a self-hosted embedding server behind a public DNS name. Loopback, private-network, and cluster-internal hosts qualify automatically. |

## Data governance

Per-namespace [governance policies](/security/#data-governance-policies) — retention caps,
memory aging, task-TTL ceilings, and AI egress rules — are data, not node config: they are set
through the API (`PUT /v1/namespaces/{ns}/policy`) and stored in object storage, so every node
enforces the same policy. One node knob controls how fast policy changes propagate:

| Variable | Default | Description |
| --- | --- | --- |
| `MEMOTURN_POLICY_CACHE_SECS` | `30` | Per-node policy read-cache TTL. A policy change takes effect on the node that served it immediately and on every other node within this window. |

Policies tighten what the node would otherwise allow — node-level settings such as the
retention windows above remain the outer ceilings.

## Examples

Single dev node, everything default:

```bash
memoturnd
```

Authenticated node against S3 with etcd leases:

```bash
MEMOTURN_AUTH=on \
MEMOTURN_PLATFORM_KEY=... \
MEMOTURN_ETCD=http://etcd-0:2379,http://etcd-1:2379,http://etcd-2:2379 \
MEMOTURN_OBJECT_STORE=s3://memoturn-cell-1 \
MEMOTURN_LISTEN=0.0.0.0:8080 \
MEMOTURN_ADVERTISE=http://10.0.3.17:8080 \
MEMOTURN_NODE_ID=node-a \
memoturnd
```

Auto-embedding against a local OpenAI-compatible server:

```bash
MEMOTURN_EMBED_API_KEY=unused-but-required \
MEMOTURN_EMBED_PROVIDER=openai \
MEMOTURN_EMBED_BASE_URL=http://localhost:11434/v1 \
MEMOTURN_EMBED_MODEL=nomic-embed-text \
memoturnd
```

In Kubernetes, prefer the Helm values (`auth.existingSecret`, `ai.existingSecret`,
`objectStorage.*`, `server.*` for the limit and durability knobs) over hand-set env vars — the
chart wires Secrets and values to these variables for you. See [Deployment](/deployment/).
