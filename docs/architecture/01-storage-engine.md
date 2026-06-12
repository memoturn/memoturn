# 01 — Storage Engine

The data-plane node is a single Rust binary, **`memoturnd`**, embedding libSQL as a library and
hosting millions of tiny databases. Object storage is the source of truth; local NVMe is a cache.

## Engine choice

**libSQL (the C fork of SQLite), embedded as a library.** Rationale (full record:
[ADR-0001](../adr/0001-libsql-as-library.md)):

- Battle-tested SQLite core + the extensions we need: virtual WAL API, native vector type with
  DiskANN index, proven bottomless/embedded-replica machinery to reference.
- *Not* sqld (the libSQL server): it is in maintenance mode, and our differentiators (tiering,
  manifests, KV fast path) live around the engine — we need to own the VFS/WAL boundary.
- *Not* the Turso Rust rewrite yet: still beta (as of mid-2026), too risky for a commercial DBaaS
  foundation. It is the likely future: same file format, so we keep a swap path.

All access goes through an internal **`SqlEngine` trait** (open/execute/wal-hook/checkpoint).
No libSQL types escape `crates/engine`, so the engine can be swapped per-database later.

**Language: Rust** ([ADR-0002](../adr/0002-rust-data-plane.md)) — deterministic memory at
millions-of-objects density (no GC), first-class libSQL bindings, and the ecosystem the design
leans on: `tokio`, `tonic`, `moka`, `foyer`, `object_store` (one API over S3/GCS/Azure/MinIO).

## Database identity and layout

`db_id = {tenant}/{db_name}@{branch}`. Local layout sharded to avoid giant directories:

```
/var/lib/memoturn/dbs/{shard:2hex}/{db_uuid}/
  main.db        # materialized SQLite file (cache of object-storage truth)
  wal/           # active segments not yet shipped
  meta.json      # manifest pin: parent branch, last txid, epoch
```

## Temperature tiers

| Tier | State | Resident cost | Transition |
| --- | --- | --- | --- |
| **Hot** | open libSQL handle, pages cached | ~300–600 KB | idle >60 s → warm (close after passive checkpoint) |
| **Warm** | `main.db` on NVMe, no handle | disk only | reopen: sub-ms. idle >1 h or disk pressure → cold (after segments shipped) |
| **Cold** | object storage only | zero node cost | wake: fetch snapshot + segment tail, 50–200 ms (≤16 MB DBs) |

- Hot pool: LRU/CLOCK over open handles, capped (~50 k/node, tuned against fd limits).
- **Memory budget is deterministic**: tiny per-handle page cache (`PRAGMA cache_size` 64–256 KB);
  the real cache is a node-global hybrid (RAM+NVMe spill, `foyer`) keyed by
  `(db_uuid, page_no, txid)` with a fixed budget (~60 % of container RAM). Node memory does not
  grow with the number of hot databases — the property Kubernetes resource limits require.
- **Provisioning = metadata only.** A new database is a catalog row + an empty branch manifest.
  The file materializes lazily on first write. An idle database costs object-storage cents.
- Large DBs (>16 MB): v1 wakes by full restore; a lazy page-fault VFS (Litestream-VFS-style) is
  deferred ([ADR-0003](../adr/0003-ltx-segment-replication.md)).

## Replication: per-DB segment log (LTX format)

Each database produces an append-only log of **immutable page-transaction segments** (LTX format —
page images + `min_txid..max_txid` + checksums, zstd-compressed), captured from committed WAL
frames via the virtual-WAL hook. ([ADR-0003](../adr/0003-ltx-segment-replication.md))

**Write path (primary):**
1. Transaction commits to the local WAL (fsync — the Standard-mode commit point).
2. WAL hook appends the committed frames to the current segment.
3. Segment seals on 1 MB / 200 ms / Durable-mode commit, whichever first.
4. Sealed segment is (a) PUT to object storage and (b) streamed over multiplexed gRPC to
   subscribed replicas.

**Object layout (source of truth):**
```
{bucket}/{tenant}/{db_uuid}/
  manifest.json                     # branch metadata, epoch, segment index (CAS-updated)
  ltx/0/{min_txid}-{max_txid}-{epoch}.ltx
  ltx/1/... ltx/2/...               # level compaction (30 s / 5 min windows)
  snapshot/{txid}.db.zst            # periodic full compactions
```

Level compaction keeps restore-to-any-txid to ~a dozen GETs and yields PITR for free.

**Commit & GC.** Linking a segment into the manifest is a CAS; on a transient conflict the writer
retries — reload, re-fence at its epoch, re-append. The uploaded object is addressed by its txid
range, so the retry is idempotent; if the chain has moved past it, the object is simply left
unreferenced. Unreferenced objects (lost CAS races, deleted branches, compacted-away segments) are
reclaimed by **refcount GC**: the collector builds the referenced set across *all* branch
manifests of the database — so a copy-on-write child sharing a parent's snapshot keeps it
referenced — and deletes only objects older than a grace window (`MEMOTURN_GC_GRACE_SECS`,
default 600 s) that shields uploads not yet committed to a manifest.

**Replicas** subscribe lazily on first read of a branch they don't own; owners push sealed
segments (and compaction snapshots) to subscribers, which apply them via atomic file replacement
(never through SQL), guarded by txid-chain contiguity — any gap falls back to object-storage
restore, so push is an optimization, never a correctness dependency. Replicas catch up from object
storage before joining the live stream — history never burdens the primary. Every read response
carries `txid`; clients send `min_txid` for read-your-writes.

## KV layer

Reserved table per database, accessed via a non-SQL fast path (cached prepared statements — tens
of µs on a hot DB, no SQL-injection surface):

```sql
CREATE TABLE __memoturn_kv (
  ns TEXT NOT NULL, k TEXT NOT NULL,
  v BLOB NOT NULL, meta BLOB,
  expires_at INTEGER,              -- unix ms; NULL = no TTL
  PRIMARY KEY (ns, k)
) WITHOUT ROWID;
```

Namespaces are rows, not tables — creating one is free. TTL: lazy expiry on read + background
sweeper for hot/warm DBs only (never wake a cold DB to expire keys).

**Edge-read cache (the Cloudflare-KV-flavored part):** per-node in-memory cache keyed
`(db_uuid, ns, k)` → `(value, txid)`. Primary invalidation = the replication stream itself (a
compact CDC side-channel `db, ns, k, txid` rides the segment stream). Backstop = per-namespace
`max_age` (default 30 s) with cheap revalidation. The contract is explicitly eventual for cached
reads, with `min_txid` tokens when read-your-writes matters.

## Document layer

Collections are lazily-created reserved tables (`__memoturn_docs_{collection}`) holding JSONB;
the Mongo-style API compiles to SQL over `jsonb_extract`, and secondary indexes are generated
columns on JSON paths. Full design: [04-data-model-and-api](04-data-model-and-api.md),
[ADR-0006](../adr/0006-documents-on-jsonb.md).

## Vector search

libSQL native `F32_BLOB` columns + DiskANN index ([ADR-0007](../adr/0007-libsql-native-vectors.md)).
Vectors are ordinary indexed columns inside the database file, so they **replicate, fork, and
rewind for free** through the segment/manifest machinery — the deciding property. Agent-memory
scale (10³–10⁵ embeddings per DB) is squarely in DiskANN's comfort zone.

## Durability

| Mode | Commit point | RPO on node loss | Latency cost |
| --- | --- | --- | --- |
| **Standard** (default) | local WAL fsync; segments shipped ≤200 ms | ≤ ~1 s of writes | none |
| **Durable** (opt-in, priced) | segment PUT acked by object storage | 0 | +5–15 ms |

- Durable mode is live: `MEMOTURN_DURABILITY=durable` makes it the node default, and any single
  request escalates with a `Memoturn-Durability: durable` header (escalation only — a request can
  never lower the node default). A durable ack means the segment shipped *and* the manifest CAS
  committed before the `txid` was returned.
- RTO: warm failover ≤15 s (lease expiry dominates); cold wake 50–200 ms.
- PITR window: 24 h fine-grained, 30 d snapshot-grained.
- Continuous **restore drills**: sample databases, restore from object storage, checksum against
  primary — backups that are never restored are not backups.

## Per-database write ceiling

The single-writer invariant has a deliberate corollary: **a database's write throughput is
bounded by one libSQL writer on one node.** Reads don't share the cap — WAL readers run
alongside the writer, replicas absorb the rest — and profile-per-database granularity keeps
real per-DB write rates low. But a single high-fan-in database (e.g. a shared team-memory
profile ingested into by many concurrent agents — see
[07](07-agent-memory.md#hierarchy--isolation)) serializes on one handle, and no amount of
fleet capacity changes that: the fleet scales *across* databases, never *within* one.

The ceiling is managed in layers, cheapest first:

1. **Make saturation visible, not mysterious** *(implemented)*. Each handle counts writes,
   commit rounds, sheds, and current queue depth (`DbHandle::write_stats`); `memoturnd` logs a
   per-DB "write pressure" line every 30 s when a queue is nonempty or writes were shed. Past
   `MEMOTURN_WRITE_QUEUE_DEPTH` pending writes (default 256) the node sheds that DB's writes
   with `429` + `Retry-After` (`EngineError::Overloaded`) instead of letting latency collapse.
   (`MEMOTURN_MAX_CONCURRENCY` is node-global and protects the node, not the hot DB.)
2. **Group commit** *(implemented, node-local)*. Concurrently arriving write requests for the
   same DB coalesce into one transaction: callers queue, the caller that wins the write lock
   drains a bounded round (≤64 requests), brackets each request in a savepoint (per-request
   atomicity and error reporting preserved — a failed request rolls back alone), bumps the txid
   once, and commits once. Participants share the round's `txid`; per-commit overhead (commit
   record, meta-page write, fsync in Durable mode) amortizes across the round. Raises the
   ceiling by roughly the coalescing factor with no invariant touched — commit point, epoch
   fencing, and segment shipping are unchanged. Corollary: user SQL must never issue
   transaction control (`COMMIT`, `SAVEPOINT`, …) inside a round, so the SQL guard rejects
   statement-leading transaction-control keywords (trigger bodies excepted).
3. **Engine headroom: the Turso swap** ([ADR-0001](../adr/0001-libsql-as-library.md)). Turso's
   MVCC / concurrent-writes work lifts intra-handle serialization on the owner node. Behind the
   `SqlEngine` trait this is an upgrade, not a redesign — still one owner node, still one
   logical writer for fencing purposes.
4. **Sharded profiles** *(product-level, last resort — explicitly not v1)*. A logical profile
   backed by N physical shard DBs, each with its own lease and writer. Routing must follow the
   memory semantics: shard by hash of the supersession key (`type`, `topic_key`), falling back
   to the content-addressed id, so a topic's supersession chain and idempotent dedup stay within
   one shard; recall fans out and merges — the same shape as the existing multi-channel RRF
   merge. This is the only layer that dilutes "one profile = one database" (branch/rewind would
   have to coordinate N manifests), which is why it sits last.

**Not on the list:** multiple concurrent writer *nodes* for one database. That would break epoch
fencing and the zombie-writer story; the answer to fan-in is layers 1–4, never relaxing the
invariant.

## Data flows

- **Write:** client → gateway → owner node (lease+epoch check) → txn → WAL fsync → ack → segment
  seal → object-store PUT + replica fan-out.
- **Cached KV read:** client → nearest node → cache hit (µs) | local replica (tens of µs) |
  forward; response carries `txid`.
- **Fork:** CAS a new branch manifest referencing parent@txid. No data movement.
- **Wake:** lease acquire → GET snapshot + segment tail → materialize → open → serve (<200 ms p50).
