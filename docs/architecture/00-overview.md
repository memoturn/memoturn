# 00 — Overview

## Vision

**Memoturn is memory for agents.** The product surface is a typed, searchable, durable memory —
`namespace > profile > memory`, where every agent acting for a user shares that user's profile:
facts that supersede each other, events that accumulate, instructions that evolve, tasks that
expire, recalled through hybrid keyword + topic + vector search. → [07](07-agent-memory.md)

Underneath, agents need a different database. An agent's state is not one big application schema —
it is **millions of small, independent state bundles**: one per profile, per agent, per session,
per task. Each bundle mixes shapes (JSON documents, scratch KV, embeddings, conversation turns,
occasional relational data), evolves constantly, is idle most of the time, and benefits enormously
from *fork-test-discard* experimentation.

Memoturn's thesis: **give every memory profile its own database** — instantly provisioned,
near-zero cost when idle, holding every shape of state, and branchable/rewindable as a single
unit. Memory you can checkpoint, fork, and rewind.

## The hybrid

Memoturn deliberately fuses two design lineages:

| Lineage | What we take |
| --- | --- |
| **SQLite / embedded per-tenant DBs** | Full SQL on a single file, single-writer simplicity, ~zero marginal cost per database, file-format ubiquity |
| **Cloudflare-KV-style global KV** | Simple `get/put/list` with TTL, edge/replica-cached reads, an explicit eventual-consistency contract for hot reads |

On top sits a **document-first, multi-model API** (Mongo-style collections on JSONB) because
agents natively speak JSON — with SQL kept as the power-user escape hatch.

## System diagram

```
                        ┌────────────────────────────────────────────┐
   SDKs (TS/Py)         │                Region cell                 │
   MCP clients   ─────► │  ┌─────────┐   ┌───────────────────────┐   │
   CLI / dashboard      │  │ gateway │──►│ memoturnd data plane  │   │
                        │  │ (route  │   │  hot/warm/cold DBs    │   │
        ▲               │  │  cache) │   │  per-DB writer lease  │   │
        │               │  └────┬────┘   └───────┬───────▲───────┘   │
   control-plane API    │       │                │ LTX   │ restore   │
   (catalog: Postgres)  │  ┌────▼────┐   ┌───────▼───────┴───────┐   │
   built-in assistant   │  │  etcd   │   │  object storage       │   │
                        │  │ leases  │   │  (source of truth)    │   │
                        │  └─────────┘   └───────────────────────┘   │
                        └────────────────────────────────────────────┘
```

- **`memoturnd`** (Rust): hosts millions of tiny libSQL databases in hot/warm/cold tiers; produces
  per-DB page-segment logs; serves SQL/docs/KV/vector reads and writes. → [01](01-storage-engine.md)
- **Object storage** (S3/GCS/Azure Blob/MinIO): the source of truth. Snapshots + segment logs +
  branch manifests. Nodes are disposable. → [01](01-storage-engine.md), [02](02-branching.md)
- **etcd**: writer leases and placement. One lease per *node*; databases attach to their owner
  node's session. A node without etcd refuses to start when it looks multi-node, unless
  `MEMOTURN_SINGLE_NODE=1` asserts it really is alone. → [03](03-control-plane.md)
- **Gateway**: stateless router; placement cache; epoch-mismatch retry. → [03](03-control-plane.md)
- **Control-plane API**: tenants/databases/branches/tokens/usage, catalog in Postgres. → [03](03-control-plane.md)
- **API surface**: agent-memory API (the headline), document-first multi-model SDKs, MCP server,
  built-in assistant. → [07](07-agent-memory.md), [04](04-data-model-and-api.md),
  [06](06-mcp-and-assistant.md)
- **Deployment**: one Helm umbrella chart, multi-cloud K8s. → [05](05-deployment.md)

## Core guarantees (the contract)

1. **Per-database strong writes.** Each database (branch) has exactly one writer at a time
   (lease + epoch fencing). Transactions are serializable within a database. The corollary —
   per-database write throughput is one node's single writer — is documented with its
   mitigation ladder in [01](01-storage-engine.md#per-database-write-ceiling).
2. **Reads carry `txid`.** Primary reads are strongly consistent. Replica/cached reads are
   eventually consistent within a bounded window (~1 s in-region; `max_age` backstop) and always
   disclose their `txid`. Clients pass `min_txid` for read-your-writes. Despite the name, `txid`
   is a commit-round sequence, not one ID per request — group-committed writes share a round's
   `txid` ([01](01-storage-engine.md#per-database-write-ceiling)); the contract is ordering
   (state at `txid` N reflects every write acked with `txid` ≤ N), which shared IDs preserve.
3. **Durability modes.** *Standard*: local WAL fsync, RPO ≤ ~1 s on node loss. *Durable*: commit
   acked only after the segment ships and the manifest CAS lands in object storage, RPO 0 — node
   default via `MEMOTURN_DURABILITY=durable`, or per-request escalation with a
   `Memoturn-Durability: durable` header (escalation only; a request can never lower it).
4. **Branches are O(1) and complete.** A fork captures documents, KV, vectors, history — the
   whole database — at a transaction boundary. Rewind to any checkpoint or PITR point in window.
5. **Provisioning is instant.** Creating a database writes metadata only (no file I/O); cost of an
   idle database is object-storage cents.

## Document map

| Doc | Contents |
| --- | --- |
| [01-storage-engine](01-storage-engine.md) | engine choice, temperature tiers, LTX replication, durability |
| [02-branching](02-branching.md) | manifests, epoch fencing, checkpoints, PITR, GC |
| [03-control-plane](03-control-plane.md) | catalog, routing, leases, failover, multi-region cells |
| [04-data-model-and-api](04-data-model-and-api.md) | docs/KV/SQL/vector/memory APIs, SDK shapes, consistency |
| [05-deployment](05-deployment.md) | Kubernetes, Helm, multi-cloud, security, observability |
| [06-mcp-and-assistant](06-mcp-and-assistant.md) | MCP tools, built-in assistant |
| [07-agent-memory](07-agent-memory.md) | namespaces, profiles, typed memories, supersession, hybrid recall |
| [08-data-governance](08-data-governance.md) | per-namespace policies: retention/TTL caps, AI egress, audit, erasure |
| [09-object-native-engine](09-object-native-engine.md) | ground-up candidate engine: typed surfaces on an object-native LSM (prototype) |
| [docs/adr](../adr) | one record per locked decision |
