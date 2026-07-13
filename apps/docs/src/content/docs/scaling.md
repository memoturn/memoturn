---
title: Scaling out
description: Horizontal scale-out — consistent-hash ownership, ownership leases, transparent owner-proxy, and live migration.
---

A single Memoturn process is fully functional. To run **multiple replicas** behind a load balancer,
enable scale-out: agents are distributed across replicas by a consistent-hash ring, each agent has
exactly one owner at a time, and requests that land on the wrong replica are transparently
forwarded to the owner.

Enable with [`MEMOTURN_SCALEOUT_ENABLED`](/configuration/#scale-out). Scale-out needs a **shared
control plane** — set `MEMOTURN_POSTGRES_DSN` (Postgres) so membership and leases are visible to
every replica — and a **durable snapshot store** (`MEMOTURN_SNAPSHOT_BACKEND=s3`) so agent state can
follow ownership across replicas. `validate_runtime()` **fails fast at startup** if either is
missing under scale-out (so a misconfigured fleet can't race or silently drop agent state), and
warns on a missing `MEMOTURN_INTERNAL_TOKEN` or — when limits are on — a missing `MEMOTURN_REDIS_URL`.

## Ownership

Each replica heartbeats its identity (`MEMOTURN_REPLICA_ID`, `MEMOTURN_REPLICA_ADDRESS`) into the
control plane every `MEMOTURN_REPLICA_HEARTBEAT_SECONDS` (default `5`). Live replicas (those seen
within `MEMOTURN_REPLICA_STALE_SECONDS`, default `15`) form a **consistent-hash ring**
(`MEMOTURN_HASHRING_VNODES` virtual nodes each, default `100`). An agent `tenant/name` maps to one
owning replica; adding or removing a replica only remaps the agents near that point on the ring.

## Ownership leases

A consistent-hash owner is not enough during churn, so ownership is also backed by a **lease** in
the control plane (`MEMOTURN_LEASE_TTL_SECONDS`, default `30`; set `0` to disable). A replica must
hold and renew the lease to run an agent, guaranteeing a single live writer fleet-wide even while
the ring is converging. Leases are renewed each heartbeat.

## Owner-proxy

Requests don't have to reach the right replica:

- **REST / MCP / A2A** — a middleware checks ownership; a non-owner forwards the request to the
  owner and relays the response, tagged with a loop-guard header.
- **WebSocket** — a non-owner bridges the socket to the owner's socket, pumping frames both ways.

If a forwarded request still isn't local (loop guard tripped), the replica responds directly. A
non-owner that can't proxy returns **HTTP 421** (Misdirected Request) with the owner's id and
address, so clients can retry against the owner.

## Live migration & handoff

When the ring changes, the shard manager calls `hibernate_disowned` so a replica that no longer
owns an agent flushes its state (to the snapshot store) — the new owner restores it on the next
request. During the brief window where this replica owns the ring slot but the prior owner still
holds the lease, requests are **transparently proxied to the lease holder** until it releases. If
the lease is momentarily unavailable, the API returns `503` with `Retry-After: 1`.

## Profiles under scale-out

[Cross-agent memory profiles](/memory/#cross-agent-profiles) are owned per profile (consistent-hash
routed); non-owners proxy reads/writes to the owner using `MEMOTURN_INTERNAL_TOKEN`. With the
Postgres profile backend, the database is the shared store, so profiles need no owner-routing or
leases at all.

## Checklist

- `MEMOTURN_SCALEOUT_ENABLED=true`
- `MEMOTURN_POSTGRES_DSN=...` (shared control plane)
- `MEMOTURN_SNAPSHOT_BACKEND=s3` + `MEMOTURN_S3_*` (state follows ownership)
- `MEMOTURN_INTERNAL_TOKEN=...` (same on every replica)
- `MEMOTURN_REPLICA_ADDRESS` reachable replica-to-replica
- shared `MEMOTURN_REDIS_URL` (Valkey or any Redis-protocol store) **required** to enforce
  [rate limits and quotas](/security/#rate-limits--quotas) fleet-wide — otherwise each replica
  keeps its own counters and the effective cap is N× too loose

## Related

- [Agents & actors](/agents/) — hibernation and rehydration, which make migration possible.
- [Deployment](/deployment/) — running replicas on Kubernetes.
- [Configuration](/configuration/#scale-out) — every scale-out setting.
