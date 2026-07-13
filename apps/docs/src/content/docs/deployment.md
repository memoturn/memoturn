---
title: Deployment
description: Kubernetes (Helm) and the dev-to-production path for hosting Memoturn.
---


Decision record + path for hosting Memoturn. Complements [operations](/operations/) (how to run)
and the [roadmap](/roadmap/). Memoturn ships as **two images**: the Apache-2.0 `memoturn`
(built from `Dockerfile`; bundles the Postgres/storage/Redis/OIDC/OTel extras) and
`memoturn-enterprise` (built from `enterprise/Dockerfile`; adds the BSL enterprise package + Stripe
billing). See `deploy/README.md` for the build commands and the required-backend matrix.

## Decision

Inputs (product direction):
- **Delivery:** self-hosted / BYOC (customers deploy in their own cloud) is what ships today. A
  hosted SaaS tier is a Phase 2 intent (planned in `docs/managed-cloud.md` in the repo, not a live
  service); the artifact below is chosen so one chart can serve both when that lands.
- **Sandbox:** agents run **untrusted / customer-supplied code**.
- **Compliance:** SOC2 / VPC-isolation / data-residency **required now**.

All three point to **Kubernetes as the single deployment target**, with the **Helm chart
([`deploy/helm/memoturn`](../deploy/helm/memoturn)) as the one shippable artifact** — it serves
BYOC installs today and the future hosted tier from one source.

> **Why not a PaaS (e.g. Render):** no privileged container runtime → the hardened gVisor sandbox
> can't run (untrusted code is unsafe), and no VPC/compliance controls. A PaaS also can't consume a
> Helm chart, so it would be a second, diverging artifact. We standardize on Helm-on-managed-K8s;
> local dev uses the same chart on kind/k3d.

### Where to run the Helm chart

| Target | Ops | Untrusted sandbox (gVisor) | Use |
|---|---|---|---|
| **GKE** (Standard/Autopilot) | low | **GKE Sandbox = gVisor is first-class** (a `RuntimeClass`) | strong candidate for the future **hosted SaaS** tier |
| **EKS** | medium | build a Bottlerocket + gVisor node pool yourself | AWS-native; common **BYOC** target |
| **DOKS / Civo** | low | not turnkey | cheap dev/staging |
| local **kind/k3d** | n/a | n/a (trusted only) | dev |

**GKE Sandbox is the single biggest shortcut for the untrusted-code requirement** — gVisor is a
checkbox/`RuntimeClass` rather than the node-pool build EKS needs. Recommendation: target **GKE for
the future hosted tier** (free first-cluster management, native gVisor), ship the **same Helm chart for BYOC** on
whatever K8s the customer runs (EKS/AKS/on-prem). The chart is cloud-agnostic; the snapshot/lease/
handoff layer works on any S3-compatible store (S3, R2, GCS via the S3 API).

## Phase 1 — Dev / staging

`helm install` the chart on **kind/k3d** (local) or a cheap managed cluster (DOKS/Civo). Defaults are
single-replica with a PVC; `subprocess` sandbox (trusted only). Good for internal envs and demos.
**Do not** run untrusted code or onboard compliance-bound customers here — those need the gVisor
sandbox (Phase 2).

## Phase 2 — Production (GKE / EKS): BYOC artifact + future SaaS tier

Reference architecture (componentwise):

| Component | Mapping |
|---|---|
| Runtime | Deployment via the Helm chart (`scaleout.enabled=true`); HPA autoscaling; hibernation + snapshots = scale-to-zero economics. `validate_runtime()` **fails fast** if scale-out is enabled without Postgres or a snapshot backend |
| Per-agent SQLite | `MEMOTURN_SNAPSHOT_BACKEND=s3` → **S3/GCS** (SSE-KMS, versioned); pods diskless (snapshots are source of truth, lease guards single-writer) |
| Control plane | **RDS/Aurora** or **Cloud SQL** Postgres (Multi-AZ), `MEMOTURN_POSTGRES_DSN` |
| Shared rate-limit/quota store | **Valkey** (or any Redis-protocol store) via `MEMOTURN_REDIS_URL` — required under scale-out for fleet-wide limits |
| Large workspace blobs | object storage (existing `S3BlobStore`) |
| Untrusted sandbox | **gVisor** — GKE Sandbox `RuntimeClass`, or an EKS Bottlerocket+gVisor node pool — via `MEMOTURN_SANDBOX_BACKEND=k8s` |
| LLM | **Bedrock / Vertex** (in-region Claude) for data residency — see gap #2; or public Anthropic/OpenAI API |
| Ingress / TLS | ALB/NLB or GCLB + managed certs; **PrivateLink/PSC** for customer-private access; WAF |
| Inter-replica proxy | owner-proxy over cluster DNS; `MEMOTURN_REPLICA_ADDRESS` = pod IP; shared `MEMOTURN_INTERNAL_TOKEN` |
| Secrets | Secrets Manager / Secret Manager via **Secrets Store CSI** (the `SecretProvider` reads `/run/secrets/*`) |
| Encryption | KMS everywhere (object SSE-KMS, DB, disks); `MEMOTURN_BLOB_ENCRYPTION_KEY` from KMS |
| Compliance | CloudTrail/Audit Logs, GuardDuty/SCC, VPC flow logs; app audit log → CloudWatch/Cloud Logging → SIEM |
| Observability | OTel → ADOT / OTel Collector → CloudWatch / Cloud Monitoring |

### Engineering gaps for Phase 2 (prioritized)

1. **Hardened K8s sandbox — _built_** (`MEMOTURN_SANDBOX_BACKEND=k8s`,
   [`sandbox/k8s.py`](../src/memoturn/sandbox/k8s.py)): throwaway gVisor-isolated exec pods (no SA
   token, non-root, read-only rootfs, all caps dropped, seccomp RuntimeDefault, limits, hard
   deadline), with the **network capability bridge** (`MEMOTURN_SANDBOX_K8S_BRIDGE_ENABLED=true`,
   [`sandbox/bridge.py`](../src/memoturn/sandbox/bridge.py)) so in-pod `workspace`/`caps` work.
   The **deny-all-except-bridge NetworkPolicy** for the sandbox namespace ships in both the GKE
   Terraform module (gap #3) and the Helm chart (`sandbox.networkPolicy.enabled`). Follow-up:
   in-pod **dependency support**.
2. **In-region LLM provider — _built_**: `MEMOTURN_LLM_PROVIDER=bedrock` (AWS) or `vertex` (GCP) runs
   Claude via the Messages API in your cloud/region for data residency, reusing
   [`AnthropicProvider`](../src/memoturn/providers/anthropic.py) with an injected client. Credentials
   come from the cloud default chain (IRSA / Workload Identity); extras `[bedrock]` / `[vertex]`.
3. **Terraform module — _GKE built_** ([`deploy/terraform/gke`](../deploy/terraform/gke)): VPC +
   private GKE (Workload Identity, Dataplane V2) with a **gVisor sandbox node pool** (scale-to-zero),
   Cloud SQL (private), a CMEK GCS bucket via S3-interop, the deny-all-except-bridge NetworkPolicy,
   and the wired Helm release. `terraform validate`-clean. **Follow-up: an EKS module** (note: gVisor
   on EKS needs a custom Bottlerocket+gVisor node AMI, unlike GKE Sandbox's turnkey RuntimeClass).
4. **IRSA / Workload Identity** for object-store + secrets access (pod identity; drop static keys).
5. **Shared rate limiter — _built_** (`MEMOTURN_REDIS_URL`, the `redis` extra): a Redis-protocol
   store — **Valkey** (BSD-3) or ElastiCache/Memorystore — enforces rate limits and quotas across
   replicas. `validate_runtime()` warns when scale-out is enabled with limits on but no Redis URL
   (the in-process limiter is per-replica, so each replica keeps its own counters).
6. **Compliance wiring** — KMS keys, audit-log shipping, VPC/PrivateLink, pen-test + SOC2 controls
   mapping.

### BYOC (self-hosted enterprise)

Ship **Helm chart + Terraform module** so a customer installs into their own account/VPC. Same
artifact as the hosted tier; they bring their own object storage, Postgres, KMS, and LLM access.

## Sequencing

1. **Now:** Phase 1 on kind/k3d (or a cheap managed cluster) for dev/demo + trusted partners.
2. **Before the first untrusted-code / compliance customer:** Terraform (gap #3) + NetworkPolicy,
   stand up GKE/EKS with `scaleout.enabled` + the gVisor sandbox, cut production over.
3. **Then:** IRSA (#4) and compliance wiring (#6); the in-region provider (#2) and shared rate
   limiter (#5) already ship.
