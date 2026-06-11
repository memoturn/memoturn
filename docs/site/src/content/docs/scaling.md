---
title: Scaling & tiering
description: The hot/warm/cold temperature model, per-node writer leases, deterministic memory budgets, and what actually drives autoscaling.
---

Memoturn hosts millions of tiny databases per node by making idleness nearly free. Databases move
through three temperature tiers; only the hot tier costs memory, only the active set costs etcd
state, and only hot load drives autoscaling. Database count is never the scaling variable.

## Temperature tiers

| Tier | State | Resident cost | Transition |
| --- | --- | --- | --- |
| **Hot** | open libSQL handle, pages cached | ~300–600 KB | idle >60 s → warm (close after passive checkpoint) |
| **Warm** | `main.db` on NVMe, no handle | disk only | reopen: sub-ms. idle >1 h or disk pressure → cold (after segments shipped) |
| **Cold** | object storage only | zero node cost | wake: fetch snapshot + segment tail, 50–200 ms (≤16 MB databases) |

The hot pool is an LRU over open handles, capped per node (`MEMOTURN_HOT_CAP`, default 50,000 —
see [Configuration](/configuration/)). Cold databases cost object-storage cents and nothing else:
no handle, no cache entry, no lease, no placement-map entry. **Millions of cold databases are
free.**

Provisioning is metadata only — a catalog row and an empty branch manifest. The file
materializes lazily on first write, which is why provisioning measures in microseconds (see
[Observability](/observability/)).

## Deterministic memory budget

Node memory does not grow with the number of hot databases — the property Kubernetes resource
limits require:

- Each open handle gets a tiny per-handle page cache (`PRAGMA cache_size`, 64–256 KB).
- The real cache is **node-global**: a hybrid RAM + NVMe-spill cache keyed by
  `(db_uuid, page_no, txid)` with a fixed budget of roughly 60% of container RAM.

Hot-handle count and cache budget are the two knobs; both are fixed per node, so capacity
planning is arithmetic, not observation.

## Writer leases: one per node, not per database

Single-writer SQL semantics come from etcd leases — but a lease per database would melt etcd at
agent scale. Instead:

- **One etcd lease per node.** Databases a node owns *attach* to that node's lease, so etcd lease
  churn stays flat regardless of database count. Attachment keys exist only for the active set.
- **Lazy ownership.** Cold databases are unowned. First write → the gateway finds no owner →
  placement picks a node (locality, load) → that node acquires ownership at `epoch+1`, wakes the
  database, and serves.
- **Failover ≤15 s.** An owner dies → its node lease expires (≤10 s) → all its attachments
  release → the next write triggers re-acquisition at `epoch+1` → the new owner restores from
  object storage and CAS-bumps the manifest epoch. Every segment and manifest write carries an
  epoch, so a zombie writer is harmless, not just unlikely (see [Consistency](/consistency/)).

Each cell caps its active set; beyond that you add cells, never grow etcd.

Multi-node is enforced, not assumed: without `MEMOTURN_ETCD`, a node refuses to start when it
looks multi-node unless `MEMOTURN_SINGLE_NODE=1`, and the Helm chart refuses `replicas > 1`
without etcd (see [Deployment](/deployment/)). The lease lifecycle is integration-tested against
a real etcd.

## Read replicas

Replicas subscribe lazily on first read of a branch they don't own. Owners push sealed segments
to subscribers, which apply them by atomic file replacement, guarded by txid-chain contiguity —
any gap falls back to object-storage restore, so push is an optimization, never a correctness
dependency. Replicas catch up from object storage before joining the live stream; history never
burdens the primary.

Every read response carries `txid`; clients send `min_txid` when read-your-writes matters.

## Autoscaling

The fleet scales on **hot load** — open handles, cache pressure, CPU — not on database count.
A node serving 50,000 hot databases at full cache is at capacity; a node fronting 10 million
cold databases is idle.

Scale-in drains writer leases first: the `preStop` path hands owned databases to peers and
finishes segment shipping before the pod terminates, the same mechanism as rolling upgrades (see
[Deployment](/deployment/)). Rolling a node costs milliseconds of write pause per database, not
failovers.

## What this means for agent workloads

A profile is a database (see [Profiles](/profiles/)), so the tiering model maps directly onto
agent behavior: a user's profile is hot while their agents are active, warm between sessions,
and cold — at near-zero cost — for the months they're away. Wake on the next
[recall](/recall/) is 50–200 ms for databases up to 16 MB. [Branches](/branching/) are O(1)
manifest operations and inherit the same tiering.
