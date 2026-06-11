---
title: Consistency & txid
description: Per-database strong writes, txid-disclosed reads, read-your-writes with min_txid, and the two durability modes.
---

Memoturn's consistency contract is small and explicit. It applies identically across every
surface — SQL, documents, KV, vectors, transcripts, and typed memories — because all of them live
in the same database file under the same write path. See [Documents, KV, SQL & vectors](/data-model/).

## The contract

1. **Per-database strong writes.** Each database (branch) has exactly one writer at a time,
   enforced by a writer lease plus epoch fencing. Transactions are serializable within a
   database.
2. **Every read carries `txid`.** Primary reads are strongly consistent. Replica and cached
   reads are eventually consistent within a bounded window (~1 s in-region; per-namespace
   `max_age` backstop, default 30 s) and always disclose the `txid` they were served at.
3. **Clients pass `min_txid` for read-your-writes.** A read carrying a `min_txid` floor is never
   served from state older than that transaction; a stale replica revalidates first.

There is no cross-database transaction. A memory [profile](/profiles/) is one database, so
"strong within a profile" is the operative guarantee for agent memory.

## Single writer, fenced

A per-database writer lease (etcd) gives one node ownership of the write path; all other nodes
forward writes to the owner. Leases make split-brain unlikely; **epoch fencing makes it
harmless**: every manifest update is a compare-and-swap carrying the writer's epoch, and a
deposed primary can never link its segments into the manifest. Details in
[Branching & burner branches](/branching/#epoch-fencing). Warm failover completes in ≤15 s
(lease expiry dominates).

## txid on the wire

- Every response carries `Memoturn-Txid` — the transaction the response reflects.
- Requests may carry `Memoturn-Min-Txid` (read-your-writes floor) and
  `Memoturn-Consistency: primary|cached`.
- Write responses (SQL, doc, KV, memory ingest) return the committed `txid`; feed it back as
  `min_txid` on subsequent reads.

```bash
# write, capture txid
curl -si -X POST https://agent-42.us-east.memoturn.dev/v1/sql \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"stmts": [{"q": "UPDATE plans SET status = ?", "params": ["done"]}]}' \
  | grep -i memoturn-txid
# Memoturn-Txid: 4813

# read-your-writes from any replica
curl https://agent-42.us-east.memoturn.dev/v1/kv/scratch/plan \
  -H "Authorization: Bearer $TOKEN" \
  -H "Memoturn-Min-Txid: 4813"
```

## Read modes

| Read mode | Guarantee | Typical latency |
| --- | --- | --- |
| `primary` | strongly consistent (owner read) | in-region RTT + ~100 µs |
| `cached` (default for `kv.get`) | eventually consistent; staleness ≤ replication lag (~1 s) or namespace `max_age` (default 30 s) backstop; response discloses `txid` | µs (node cache) |
| `cached` + `min_txid` | read-your-writes floor | µs–ms (revalidates if behind) |

Replicas subscribe to a database's segment stream lazily on first read and catch up from object
storage before joining the live stream. Cache invalidation rides the replication stream itself;
`max_age` is the backstop when the stream is quiet.

## KV consistency parameter

The KV surface exposes the read mode per request via `?consistency=`:

```bash
# strongly consistent owner read
curl "https://agent-42.us-east.memoturn.dev/v1/kv/scratch/plan?consistency=primary" \
  -H "Authorization: Bearer $TOKEN"

# default: cached, µs-latency, txid disclosed
curl "https://agent-42.us-east.memoturn.dev/v1/kv/scratch/plan" \
  -H "Authorization: Bearer $TOKEN"
```

```ts
await db.kv.get('scratch', 'plan', { consistency: 'cached' });
await db.kv.get('scratch', 'plan', { consistency: 'primary' });
```

`cached` is the default for KV reads only; SQL, document, vector, and memory reads default to
the primary. See [Documents, KV, SQL & vectors](/data-model/#kv-namespaces).

## Durability modes

| Mode | Commit point | RPO on node loss | Latency cost |
| --- | --- | --- | --- |
| **Standard** (default) | local WAL fsync; segments shipped by the sub-second background loop | ≤ ~1 s of writes | none |
| **Durable** (opt-in) | txid returned only after the segment ships **and** the manifest CAS lands in object storage | 0 | one object-store round trip |

Durable mode is set per node (`MEMOTURN_DURABILITY=durable`) or escalated per request with the
`Memoturn-Durability: durable` header — the header can raise durability above the node default,
never lower it. In Standard mode, `POST /v1/sync` remains the explicit on-demand durability
point.

In both modes object storage is the source of truth and nodes are disposable: a node loss never
loses acknowledged Durable-mode commits, and loses at most ~1 s of Standard-mode commits.
Restore-to-any-txid is retained within the PITR window (24 h fine-grained, 30 d
snapshot-grained) — see [Branching & burner branches](/branching/).

## What this means for agents

- An agent that writes a memory and immediately recalls it should pass the ingest `txid` as
  `min_txid` — or read from the primary. See [Recall](/recall/).
- Scratchpad KV reads tolerate ~1 s staleness by default in exchange for µs latency; opt into
  `primary` per read when it matters.
- Checkpoints and rewinds are transaction-boundary operations: a checkpoint names the current
  `txid`, so rewinding restores a state that actually existed.

For multi-node deployment topology, see [Deployment](/deployment/) and [Scaling](/scaling/).
