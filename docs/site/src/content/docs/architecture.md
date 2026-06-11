---
title: Architecture
description: The Memoturn data plane, object-storage source of truth, replication, branching, leases, and control plane.
---

Memoturn is a distributed agent-memory database. The headline surface is typed agent memory —
[namespaces and profiles](/profiles/), [typed memories](/memories/), [hybrid recall](/recall/) —
built on a substrate where **every memory profile is its own tiny database** that replicates,
branches, and rewinds as a single unit.

## Topology

```
                        ┌────────────────────────────────────────────┐
   SDKs (TS/Py)         │                Region cell                 │
   MCP clients   ─────► │  ┌─────────┐   ┌───────────────────────┐   │
   CLI / dashboard      │  │ gateway │──►│ memoturnd data plane  │   │
                        │  │ (route  │   │  hot/warm/cold DBs    │   │
        ▲               │  │  cache) │   │  per-DB writer lease  │   │
        │               │  └────┬────┘   └───────┬───────▲───────┘   │
   control-plane API    │       │                │ ship  │ restore   │
   (catalog: Postgres)  │  ┌────▼────┐   ┌───────▼───────┴───────┐   │
                        │  │  etcd   │   │  object storage       │   │
                        │  │ leases  │   │  (source of truth)    │   │
                        │  └─────────┘   └───────────────────────┘   │
                        └────────────────────────────────────────────┘
```

| Component | Role |
| --- | --- |
| `memoturnd` | Rust data-plane node; embeds libSQL as a library; hosts millions of tiny databases |
| Object storage | S3 / GCS / Azure Blob / MinIO; snapshots, segment logs, branch manifests — the source of truth |
| etcd | Writer leases and placement; one lease per node |
| Gateway | Stateless router with a placement cache; retries on epoch mismatch |
| Control-plane API | Tenants, databases, branches, tokens, usage; catalog in Postgres |

## The data plane

`memoturnd` is a single Rust binary embedding libSQL (the C fork of SQLite) as a library — not as
a server. Each database is one SQLite-format file, which is why a profile is cheap enough to
provision per user, per agent, or per session: creating one is a metadata write (no file I/O),
measured at **17 µs p50** on the prototype.

Databases live in three temperature tiers:

| Tier | State | Resident cost | Transition |
| --- | --- | --- | --- |
| Hot | open libSQL handle, pages cached | ~300–600 KB | idle >60 s → warm |
| Warm | file on NVMe, no handle | disk only | idle >1 h or disk pressure → cold |
| Cold | object storage only | zero node cost | wake on demand (restore + open) |

Node memory does not grow with the number of hot databases: per-handle page caches are tiny, and
the real cache is a node-global RAM+NVMe budget. Cold wake measured **0.7 ms p50** on the
prototype, plus object-store round-trip in production.

## Object storage as the source of truth

Local disk is a cache. Every committed transaction is captured from the WAL and shipped as an
**immutable page segment** to object storage; periodic compaction produces snapshots, and a
**branch manifest** (CAS-updated JSON) indexes them. A node can be deleted at any time — a fresh
pod with no PersistentVolume restores any database from object storage and serves the same data.

Segments are also streamed to read replicas, which apply them by atomic file replacement guarded
by txid-chain contiguity; any gap falls back to object-storage restore, so streaming is an
optimization, never a correctness dependency. Segment ship measured **61 µs p50** (prototype,
in-process object store).

Writes ack on local commit and ship asynchronously by default; `MEMOTURN_DURABILITY=durable` (or
a per-request `Memoturn-Durability: durable` header) acks only after the segment ships and the
manifest CAS lands — see [Consistency](/consistency/#durability-modes). Unreferenced objects —
orphaned segments, expired burner branches — are reclaimed by a refcounted GC across all branch
manifests, safe under copy-on-write, after a grace window.

## Single writer, epoch fencing

Each database (branch) has exactly one writer at a time:

- **One etcd lease per node**, not per database. Databases attach to their owner node's lease
  session lazily, on first write — so a node hosting a million databases holds one lease.
- Every segment and manifest write carries an **epoch**; manifest updates are compare-and-swap.
  A zombie writer with a stale epoch produces writes that the manifest CAS rejects — harmless by
  construction, not just unlikely.
- Failover is bounded by lease expiry: **≤15 s** to a warm replacement.

## Reads and consistency

Every read response carries `Memoturn-Txid`. Primary reads are strongly consistent; replica and
cached reads are eventually consistent within a bounded window and always disclose their `txid`.
Clients pass `Memoturn-Min-Txid` for read-your-writes. The full contract is on
[Consistency](/consistency/).

## Request path

1. Client (SDK, MCP, CLI, or raw HTTP) sends a request addressed to a database — for memory
   routes, the profile database `{ns}--{profile}`.
2. The gateway resolves the owner node from its placement cache and forwards.
3. Writes: the owner checks its lease and epoch, commits the transaction to the local WAL
   (the Standard-durability commit point), acks, then seals and ships the segment.
4. Reads: served from the hot handle, a local replica, or by waking the database from object
   storage; the response carries `txid`.
5. Epoch mismatch (ownership moved) → the gateway refreshes placement and retries.

## Multi-model surface

One profile database holds every shape of agent state, all behind one HTTP/JSON API:

| Surface | Mechanism |
| --- | --- |
| [Typed memory](/memories/) | reserved `__memoturn_memories*` tables: supersession, FTS5, DiskANN |
| Documents | JSON document collections with filter queries, compiled to SQL over JSONB — see [Data model](/data-model/) |
| KV | reserved `__memoturn_kv` fast path with TTL and cached reads |
| Vectors | libSQL native `F32_BLOB` + DiskANN, ordinary columns in the file |
| SQL | the escape hatch; reserved `__memoturn_` tables are unreachable from user SQL |

Because vectors, documents, and memories are rows in the same file, they replicate, fork, and
rewind together through the same segment/manifest machinery.

## Branching

A fork is a CAS of a new manifest referencing `parent@txid` — **O(1), no data movement**, measured
**47 µs p50** on the prototype. Checkpoints, rewind, PITR, and burner branches are covered on
[Branching](/branching/).

## Deployment

The whole stack ships as one Helm umbrella chart to any Kubernetes (EKS/GKE/AKS/self-hosted):
`memoturnd` plus object storage and etcd dependencies. Nodes are stateless by design — no
PersistentVolumes. See [Deployment](/deployment/) and [Scaling](/scaling/).

## Further reading

- [Namespaces & profiles](/profiles/) — the isolation model
- [Typed memories](/memories/) and [Hybrid recall](/recall/) — the headline API
- [Consistency](/consistency/) — txid, min_txid, durability modes
- [Configuration](/configuration/) — `MEMOTURN_*` environment variables
- Full design documents: [github.com/memoturn/memoturn](https://github.com/memoturn/memoturn)
