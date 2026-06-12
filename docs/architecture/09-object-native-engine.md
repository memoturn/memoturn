# 09 — Object-Native Engine (strata)

A ground-up candidate engine ([ADR-0011](../adr/0011-object-native-typed-storage-engine.md)),
prototyped in `crates/strata` as a standalone crate. It serves the **typed surfaces only** —
agent memory, documents, KV, vectors, transcripts — with no general SQL dialect; `/v1/sql`
remains a libSQL-engine feature. If adopted it runs side-by-side with libSQL, selectable
per-database.

**Thesis.** Today the engine writes SQLite pages locally and a parallel capture/ship layer
re-derives an object-storage truth ([01](01-storage-engine.md),
[ADR-0003](../adr/0003-ltx-segment-replication.md)). This engine inverts that: the commit log
and the replication stream are the same bytes, and the branch manifest is the engine's catalog,
not a replica of it. Durability, replication, cold wake, fork, rewind, PITR, and erasure are all
operations on one set of immutable objects.

The second governing idea: **every index is rows in the same keyspace.** FTS postings, vector
entries, supersession heads, TTL indexes, doc dot-path indexes are ordinary keys that flush,
compact, replicate, fork, rewind, and erase with the data — because they *are* the data. (This
preserves the property that made libSQL's "vectors are ordinary indexed columns" decisive in
[01](01-storage-engine.md#vector-search), by construction rather than by engine feature.)

## Core structure

Each database (each branch, really) is its own **logical LSM tree**: its own manifest, its own
memtable while hot, its own immutable sorted runs under its own object prefix. Per-database
object isolation is non-negotiable — three invariants hang off it:

- **O(1) fork** = manifest copy (ADR-0004 survives untouched).
- **Structural isolation** — profile = one database means one prefix, one keyspace, one writer.
- **Erasure provable by listing** — every data object's key leads with txids, so absence below a
  forget txid is a listing, never an audit of shared files.

Density (the one-write-a-day profile, millions of idle databases) is handled by making idle cost
zero, not by sharing data objects: a cold database is a manifest plus N segment objects and
*nothing else* — no file descriptor, no sidecar files, no memtable, no compaction state, no
local main.db. In production the node additionally runs **one shared node-local recovery log**
on NVMe multiplexing all hot databases (one fsync stream amortizes group commit across
databases; replayed on same-node restart; bounded by the ship interval on node loss — exactly
the Standard-mode RPO). The shared log never reaches object storage, so it cannot contaminate
the erasure proof. *The shared log is specified here but deferred in the prototype, which uses a
per-database local log; the object-side semantics are identical either way.*

## Object layout

```
{root}/{db_uuid}/
  branches/{branch}/manifest.json                  # CAS-updated, carries epoch (as today)
  wal/{branch}/{seq:020}-{first_txid:020}.mwal     # deterministic name → conditional-create fencing
  seg/{min_txid:020}-{max_txid:020}-L{level}-{nonce}.mseg
```

- `wal/` chunk names are **deterministic** (no epoch, no nonce): create-if-absent at a
  deterministic key is what makes the fence work (§ Fencing). The leading component is a
  **chunk sequence number that is monotone across rewinds** — txids restart after a rewind, so
  a txid-only name could collide with rewound-away history; the sequence never does. The first
  txid rides second in the name so the erasure proof can still read txids off a listing. Epoch
  lives in the chunk header.
- `seg/` objects keep a nonce: a zombie's segment PUT becomes an unreferenced orphan and falls
  to refcount GC, as today.
- The `snapshots/` prefix disappears. A "snapshot" is just a full-coverage Lmax run; ADR-0003's
  layout-faithfulness constraint (never `VACUUM INTO`) dissolves because nothing replays pages
  onto a base image anymore.

### Manifest v2

An evolution of today's manifest (`crates/replication/src/manifest.rs`), not a rewrite:

```rust
struct Manifest {
    format: u32,                        // NEW: 2
    branch: String,
    parent: Option<ParentRef>,          // (branch, fork_txid), unchanged
    epoch: u64,                         // unchanged
    head_txid: u64,                     // unchanged
    wal_floor_seq: u64,                 // NEW: wal chunks with seq above this are the live tail
    segments: Vec<SegmentRef>,
    checkpoints: BTreeMap<String, u64>, // unchanged
    ttl_at: Option<i64>,                // unchanged (burner branches)
}

struct SegmentRef {
    min_txid: u64, max_txid: u64, key: String,    // as today
    level: u8,                                     // NEW: 0 = flush output, higher = compacted
    key_min: Vec<u8>, key_max: Vec<u8>,            // NEW: keyspace range, read pruning
    entry_count: u64, bytes: u64,                  // NEW: compaction heuristics
}
```

Gone: `snapshots[]`, `db_size_pages`. Changed semantics: today's "segments txid-contiguous above
the latest snapshot" becomes "the union of runs covers all live versions; runs may overlap in
keyspace; *entry txids* decide visibility." Entries are MVCC — multiple `(key, txid)` versions
coexist, tombstones are explicit — which is what makes rewind/PITR-to-any-txid and fork-clamped
reads native. The boundary-only rewind restriction is gone.

**Catalog relaxation (explicit):** the catalog is *manifest + the bounded seq-ordered wal
tail above `wal_floor_seq`*, not manifest alone. Recovery and replicas list the (≤8-chunk)
tail; the manifest absorbs chunks lazily at flush, and absorbed chunks fall to GC.

## Write path

Typed operations form a **closed enum** (`KvPut/KvDel`, `DocPut/DocDel`, `MemIngest`,
`TurnAppend`, …) that expands deterministically into puts/deletes on the keyspace during commit
staging. Expansion replaces SQL triggers and constraints.

1. Requests queue on the single writer; the lock winner drains a bounded round (≤64 requests —
   the group-commit shape of `crates/engine/src/node.rs` ports directly).
2. Each request is **staged sequentially** against a view = segments + memtable + the round-local
   overlay of earlier requests' staged ops. Staging performs the read-modify-write (e.g. memory
   ingest reads the supersession head, emits the repoint + superseded_by update) and produces an
   op vector; nothing applies yet. A request that fails staging is discarded whole — **staging
   replaces savepoints**: rollback of a thing never applied is free and exact, and the
   sequential overlay reproduces today's savepoint visibility (request *i+1* sees request *i*).
3. The round writes **one MLOG1 record** — `{epoch, txid, per-request op boundaries, CRC}` — to
   the local log and fsyncs (the Standard-mode commit point), applies ops to the memtable, and
   answers every participant with the shared `txid`. One txid bump per round, exactly today's
   contract ([00](00-overview.md) guarantee 2).

### Durability

- **Standard:** ack at local fsync; a background flusher (the `shipper.rs` dirty-tracking shape)
  PUTs pending records as an `mwal` chunk every ≤200 ms.
- **Durable** (node default or per-request escalation, escalation-only, as today): the round's
  record is PUT as a chunk **synchronously before ack** — one conditional PUT
  (create-if-absent at the next sequence-deterministic key), with **no per-commit manifest CAS**
  (vs today's PUT + CAS). The conditional create *is* the fence: a zombie's next durable ack
  targets an occupied key and fails before it acks. Latency = one small PUT (5–15 ms on
  S3-class stores; the bench "ship" target becomes encode + PUT-initiation < 1 ms with
  end-to-end subject to the backend).

### Flush (and the tiny-database answer)

Flush = memtable + absorbed wal chunks → one sorted L0 segment + one manifest CAS that advances
`wal_floor_txid`. Triggers, whichever first: memtable ≥ 256 KB; ≥ 8 unabsorbed wal chunks
(bounds cold-wake replay and listing); **hot→warm demotion** (idle > 60 s); branch ops
(fork/checkpoint flush first, so fork stays a pure manifest copy); (production) shared-log
retirement. The one-write-a-day profile: its write rides an mwal chunk within 200 ms, demotion
folds it into a run a minute later, and it costs nothing until touched again — no timers, no
compaction debt.

## Read path

Read at txid T: memtable → wal-tail overlay → segments newest-level-first, pruned by
`key_min/key_max`, bloom filter, and txid range; first version with `entry.txid ≤ T` wins; a
tombstone terminates. Segments are immutable, so the node-global block cache (RAM + NVMe spill)
**never invalidates** — strictly simpler than page-cache keying by `(db, page, txid)`.

Temperature tiers ([01](01-storage-engine.md#temperature-tiers)) become cache policy:

- **Hot** = memtable + manifest + index/bloom blocks resident (tens of KB per DB, no fd).
- **Warm** = blocks on NVMe; first read decodes, sub-ms.
- **Cold first-touch** = GET manifest + GET segment footer + GET one block — 2–3 small GETs, no
  file materialization. The ≤16 MB restore economics and the deferred lazy-VFS item disappear.
- **Provision** = one manifest create-if-absent.

**Replica = stateless reader** over manifest + wal tail. No subscription state is needed for
correctness: load the (cached, ETag-revalidated) manifest, list and replay the short wal tail,
serve reads tagged with the achieved txid. `min_txid` wait = bounded poll of the wal tail, then
redirect to the owner. The owner→replica push stream of ADR-0003 remains a latency optimization
layered on top — never a correctness dependency — and is deferred.

## Compaction

Lazy **size-tiered**, three effective levels: L0 (flush outputs, overlapping), L1 (merged),
Lmax (one full-coverage run — the snapshot analog, and what the 30 d snapshot-grained PITR tier
retains). Small databases (< 16 MB live) full-merge to a single Lmax run — one streaming read of
a few small objects plus one PUT; a quiet profile reaches steady state of one Lmax run plus an
occasional L0 and may go weeks between compactions. Scheduling is a node-global queue fed by
manifest stats at flush/wake — no per-database background task. Compaction is decoupled from the
writer (reads from object storage, PUTs output, CAS-commits; safe from any node — the GC trust
model).

**Version-retention floor.** Compaction may drop version v of key k only if a newer version of k
exists with `txid ≤ F`, where `F = min(PITR fine-window floor, oldest named-checkpoint txid,
oldest child fork_txid)`. Tombstones drop only below F when no older level can resurrect the
key. Child branches keep shared segments referenced; the existing refcount GC (union across all
branch manifests, grace window) applies with zero logic changes.

## Branching, rewind, PITR

- **Fork:** flush-if-dirty, then one manifest create copying the parent's refs with
  `max_txid ≤ fork_txid`; a run straddling the fork point is included and the child's reads
  **clamp inherited refs to `fork_txid`**. Child epoch starts at 1, own wal prefix.
- **Checkpoint:** name → txid in the manifest, unchanged.
- **Rewind to T:** flush-if-dirty, then one CAS — `head_txid := T`, drop refs to runs entirely
  above T (objects fall to GC); straddling runs stay (entries > T masked by the read clamp,
  physically removed by the next compaction). Works at **any** txid in the fine window. The
  owner discards its memtable and local-log tail — the memtable is reconstructible, never
  authoritative. Post-rewind txids restart from T, but wal chunk **sequence numbers do not
  rewind**, so new chunks never collide with rewound-away history (which sits below
  `wal_floor_seq` and falls to GC).
- **Burner branches:** `ttl_at` + GC, unchanged.

## Fencing and recovery

The manifest CAS with epoch stays the single fencing point; everything else is made harmless,
not prevented. One addition — the **fence-chunk loop** on owner takeover:

1. Acquire lease ([03](03-control-plane.md)); CAS manifest with `epoch := old + 1`.
2. List `wal/{branch}/` above `wal_floor_seq`; replay chunks in sequence order (header epoch ≤
   ours, CRC, txid chain contiguous from `head_txid`) into the memtable.
3. Conditionally create a fence record at the next sequence key. The fence chunk **carries any
   surviving local-log records ahead of the fence**, upgrading the node's Standard-mode tail to
   object-durable at takeover — the object-storage chain stays contiguous even if this node's
   disk dies next (a same-node restart therefore loses nothing; node loss loses only writes
   since the last open or ship). On already-exists, a zombie's chunk landed between our list
   and our create — replay it (its durable acks must survive; object storage wins any txid
   conflict with the local tail) and retry at the new next sequence. Each iteration consumes
   one zombie chunk; once our fence lands, no zombie can extend the chain — its next
   conditional create fails *before it acks*. (SlateDB-style fencing, as a reference design.)

Zombie analysis: manifest CAS → epoch regression, rejected (as today); durable wal create →
key taken, ack fails; Standard-mode acks were local-only and lost within the documented RPO
(identical to today); segment PUTs → nonce-named orphans → GC (identical to today).

## Erasure = forced filtered compaction

For forget-txid X on a branch ([08](08-data-governance.md) semantics preserved):

1. Flush and absorb the wal tail (no pre-X data may remain in `wal/` or memory);
   checkpoint/child-fork pin checks exactly as today's `prune_before` (Blocked outcome kept).
2. Rewrite every segment with `min_txid < X` through a filter: surviving keys collapse to their
   newest version ≤ X (re-tagged at X) plus all versions > X; erased keys are simply not
   written. Output runs start at `{X:020}-…`.
3. CAS-swap refs; originals dereference → refcount GC deletes them after grace.
4. Verification ports as-is: manifests reference nothing below X and no `wal/` or `seg/` key
   leads with a txid < X. Values were rewritten into new objects and the old objects deleted —
   there is no byte-residue question, and the `secure_delete` machinery is unnecessary by
   construction.

Because FTS postings and vectors are keys in the same segments, **one compaction erases the row,
its keyword index, and its vector together** — no out-of-band index to chase. The erasure coupon
must capture the **derived key set** (FTS terms, vector key, topic/session memberships) at
forget time, since it cannot be recomputed once the record is gone. The layer-wide rule: any
artifact embedding row data is either a keyed value rewritten on erasure (e.g. a derived ANN
snapshot: dropped, rebuilt) or forbidden.

## The typed keyspace

One ordered binary keyspace per database. Keys are tuple-encoded (order-preserving: escaped
NUL-terminated strings, big-endian u64, sign-flipped f64, 16-byte memory ids) behind single-byte
table tags; a debug formatter renders them as `/mem/…` paths.

| Tag | Table | Key | Value |
| --- | --- | --- | --- |
| 0x01 | META | (name) | vector dim, codec floor, FTS stats pointer |
| 0x10 | MEM | (id16) | versioned MemoryRecord |
| 0x11 | MEM_ACTIVE | (type, topic_key) | id16 — O(1) supersession head |
| 0x12 | MEM_TOPIC | (type, topic_key, id16) | () — chain membership |
| 0x13 | MEM_SESSION | (session, id16) | () |
| 0x14 | MEM_EXPIRES | (expires_at, id16) | () — task-TTL sweep without scan |
| 0x15 | SESSIONS | (session) | created_at, last_active_at |
| 0x20 | FTS_TERM | (term, id16) | tf_summary, tf_keywords |
| 0x21 | FTS_STATS | () | doc_count, total field lengths |
| 0x30 | VEC | (id16) | packed [f32] LE |
| 0x31 | VEC_GRAPH | (built_txid) | derived ANN snapshot (phase 2 only) |
| 0x40 | KV | (ns, key) | value + expires_at |
| 0x41 | KV_EXPIRES | (expires_at, ns, key) | () |
| 0x50 | DOC | (collection, doc_id) | canonical JSON + envelope |
| 0x51 | DOC_META | (collection) | indexed_paths |
| 0x52 | DOC_IDX | (collection, path, typed_value, doc_id) | () |
| 0x60 | MSG | (session, seq) | role, content, embedding?, created_at |

**Record encoding:** postcard with versioned enums (`enum MemoryRecord { V1(…) }`). Readers keep
decoders for every historical version forever — which *is* the stateless-migration requirement
of [07](07-agent-memory.md#storage-reserved-tables-inside-the-profile-db): branch rewind can
resurrect old data at any time, and an old record simply decodes through its version arm; there
is no schema object to migrate. Memory `content` stays **raw canonical JSON bytes** so
content-addressed ids are byte-stable with the libSQL engine.

### Memory

Ingest stages against MEM_ACTIVE inside the single-writer round (the round overlay makes earlier
requests in the round visible — replacing the savepoint-era pre-read choreography). Idempotency
is one MEM point-read: absent → `created`; active → `duplicate`; superseded → `revived`.
Supersession writes the new row, repoints MEM_ACTIVE, and sets `superseded_by` on the old row in
one staged batch — one record, one txid.

Recall keeps the three channels and weights of [07](07-agent-memory.md#recall) — topic probe
(2.0), keyword BM25 (1.0), vector cosine (1.0) — fused by the same RRF (the fusion code is
engine-agnostic Rust and ports verbatim). Filters push down with continue-until-k semantics, so
filtered rows are never starved out of a fixed candidate window.

**FTS = postings-as-keys.** Ingest tokenizes summary + keywords (the same tokenizer as today's
`fts_query`) into FTS_TERM rows; a query range-scans each term through the ordinary merged
iterator and scores BM25 (k1 = 1.2, b = 0.75) in Rust. At 10k memories the worst common term is
≤10k postings of ~30 bytes — 1–3 ms of iteration. Forks, rewinds, and erasure cover the index
for free because it is rows. Per-segment posting blocks with skip lists are the named escape
hatch above ~250k memories per profile — an optimization, not v1.

**Vectors = flat scan, phase 1 — and that is the correct engine at profile scale, not a
stopgap.** Crossover arithmetic (RAM-resident, SIMD cosine):

| Vectors | 256-dim bytes | flat scan | verdict |
| --- | --- | --- | --- |
| 10k | 10 MB | ~1–2 ms | flat scan, well inside the 25 ms recall budget |
| 100k | 102 MB | ~10–15 ms | the practical crossover line |
| 1M | 1 GB | ~100+ ms | needs ANN |

Phase 2 (designed, crossover-gated, not built): a **derived** in-memory HNSW — built lazily on
wake, incrementally inserted, dead ids filtered at query, ground truth always the VEC keys —
persisted as a VEC_GRAPH snapshot at compaction time so wake = load + catch up from
`built_txid`. Never authoritative; erasure drops the snapshot. Dim policy ports: first embedding
fixes the dimension; mismatched ingest skips vectors (keyword + topic still work); query-dim
mismatch degrades the channel to empty.

### Documents

The Mongo-subset filter grammar, validation, and caps (depth ≤ 32, `$in` ≤ 1000) port unchanged;
SQL emission is replaced by a planner — `PointGet | IndexRange | IndexUnion | FullScan` plus a
residual `matches(doc, filter)` interpreter. Sargable conjuncts over indexed dot-paths become
access paths (fixed heuristic: eq > `$in` > range); everything else is residual. Typed-value key
encoding means an operator matches within a type class (numbers numeric across int/float,
strings binary) — a documented divergence from SQLite `->>` affinity, closer to document-store
convention. `create_index` writes DOC_META and backfills in bounded writer passes; updates apply
`$set/$unset/$inc/$push` to the decoded document during staging.

### KV and transcripts

KV is the same contract as [01](01-storage-engine.md#kv-layer): point get/put/delete, prefix
list as a range scan, TTL via lazy expiry-on-read plus a KV_EXPIRES sweep. Hot reads are a
memtable probe or one cached block — the fast path needs no SQL bypass because there is no SQL.
Transcripts: append assigns `seq` by reading the session's last key (single writer, race-free);
windows are reverse range scans; semantic search brute-forces cosine over the session range.
Session erasure uses a range-delete tombstone — O(1) in the log regardless of turn count.

### Retention sweeps

Policy sweeps ([08](08-data-governance.md)) become bounded range scans over purpose-built index
keys: task TTL over MEM_EXPIRES, KV TTL over KV_EXPIRES, superseded-count via MEM_TOPIC chains —
≤500 deletes per pass on the writer, deletes are ordinary writes that flush and ship, exactly
today's contract.

## Bench-target mapping

| Target ([crates/bench](../../crates/bench)) | This engine |
| --- | --- |
| hot write < 5 ms p50 | memtable insert + amortized fsync — yes |
| KV read < 1 ms p50 | memtable/block-cache probe — yes |
| branch create < 50 ms p50 | flush + manifest create + CAS — yes |
| segment ship < 10 ms p50 | encode + PUT initiation < 1 ms; end-to-end backend-bound (restate) |
| memory ingest < 10 ms p50 | staged expansion + round commit — yes |
| hybrid recall < 25 ms p50 @10k | topic probe + postings merge + flat vector scan — yes |
| cold first-touch < 100 ms p50 | 2–3 small GETs, no restore — yes |

## Prototype scope (crates/strata)

Standalone crate; depends on `object_store` (tests run on the local-FS backend so CAS, fencing,
durability, fork, GC, and erasure tests are real), no dependency on
`memoturn-engine`/`memoturn-replication` — proven logic (manifest CAS/fence loops, branch ops,
GC/retention/prune/verify, group-commit queue shape, RRF fusion, filter grammar) is **ported
in** with its tests, not linked. Public API mirrors today's typed call shapes so a future
backend trait can swap engines per-database.

**Deferred, by name:** shared node-log multiplexing; owner→replica push streams; per-segment
posting blocks and the phase-2 HNSW snapshot; gRPC; governance policy wiring and audit (they
live above the engine and are unaffected); auto-embedding and `/extract` (run before any write,
unaffected); `memoturnd` integration.
