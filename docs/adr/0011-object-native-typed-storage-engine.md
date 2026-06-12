# ADR-0011: Object-native typed storage engine (ground-up candidate)

**Status:** accepted · 2026-06

**Decision:** design and prototype a ground-up, object-storage-native, log-structured storage
engine — `memoturn-strata` — that serves the **typed surfaces only** (agent memory, documents,
KV, vectors, transcripts) over a single ordered keyspace per database, with **no general SQL
dialect**. The engine's immutable sorted segments in object storage *are* the database: the
commit log and the replication stream are the same bytes, and the branch manifest is the
engine's native catalog. The prototype is a standalone crate, not wired into `memoturnd`; if
adopted, it becomes a second engine selectable per-database alongside libSQL — the same hedge
posture ADR-0001 reserved for the Turso rewrite. `/v1/sql` remains a libSQL-engine feature.

**Context:** libSQL gives us a battle-tested SQL core, but everything distinctive about Memoturn
(object storage as truth, O(1) branching, disposable nodes, tiering) is built *around* it, partly
against its grain: ADR-0003's capture/ship layer exists to turn a page-based WAL into shippable
immutable segments, and its hard-won layout-faithfulness constraint exists because replicas
replay pages onto a base image. Meanwhile the manifest/CAS/fork/rewind/PITR/GC/erasure machinery
in `crates/replication` is already format-agnostic. Inverting the design — a per-database LSM
whose flush output goes straight to object storage — deletes the capture/ship layer by
construction and makes branching, PITR-to-any-txid, and provable erasure native properties of
the storage format rather than subsystems beside it.

**Shape (full design: [09-object-native-engine](../architecture/09-object-native-engine.md)):**

- Per-database logical LSM: own manifest, own memtable while hot, immutable MVCC runs under the
  database's object prefix. Fork stays one manifest write; isolation stays structural; erasure
  stays provable by listing txid-named keys.
- Typed operations (a closed enum) expand during group-commit staging into puts/deletes on one
  ordered keyspace; **every index is rows in that keyspace** — FTS postings, vector entries,
  supersession heads, TTL indexes, doc dot-path indexes — so indexes flush, fork, rewind, and
  erase with the data, always.
- Durable mode is one conditional PUT of a sequence-named WAL chunk (create-if-absent is the
  fence — SlateDB-style fencing as the reference design; the sequence is monotone across
  rewinds, with the first txid embedded in the name for the erasure-listing proof); the catalog
  becomes *manifest + bounded seq-ordered WAL tail*, a deliberate relaxation of "manifest-only"
  that this ADR makes explicit.
- Erasure is a forced filtered compaction: history below the forget txid is rewritten into new
  objects and the originals deleted — no byte-residue question, no `secure_delete` machinery.

**Alternatives rejected:**
- *Shared multi-database segments in object storage*: better PUT economics, but destroys
  erasure-by-listing and makes scrubbing one tenant a cross-tenant rewrite. A shared node-local
  recovery log (never shipped) captures most of the fsync win without contaminating the proof.
- *Sidecar / per-segment auxiliary FTS index*: an index outside the keyspace needs its own fork,
  rewind, and erasure machinery — the three things the design exists to unify. Postings-as-keys
  costs more bytes and wins every semantic; per-segment posting blocks remain a named
  optimization above ~250k memories per profile.
- *Journaled-authoritative HNSW*: couples a stochastic graph to replay determinism and makes
  erasing one vector a graph-surgery problem. Vectors are flat-scanned at profile scale
  (correct, not a stopgap — ~1–2 ms at 10k×256d); a *derived* HNSW with a compaction-time
  snapshot is the designed escalation, never authoritative.
- *Embedded SQL frontend over the new core*: an OLTP-grade planner is a multi-year project and
  the typed surfaces don't need it. SQL stays a libSQL-engine feature, per-database.

**Consequences:** we give up SQLite's decades of storage-engine testedness for the surfaces this
engine hosts — mitigated by the closed op set (a far smaller correctness surface than SQL), by
running side-by-side per-database rather than replacing, and by porting the existing
manifest/GC/erasure logic and its tests nearly verbatim. FTS (BM25) and vector recall must be
re-derived and the recall benchmarks are the acceptance gate. Group-commit atomicity moves from
SQL savepoints to validate-then-stage, which must be implemented exactly right. In exchange:
the WAL cursor, snapshot-fallback, and layout-faithfulness constraints of ADR-0003 are retired
on this engine; rewind/PITR work at any txid in the fine window (the boundary-only restriction
falls away); cold wake needs no full-file restore (the ≤16 MB practical limit and the deferred
lazy-VFS item dissolve); an idle database holds no node state at all; and the immutable-segment
block cache never invalidates.

**Update (2026-06, graduation):** the per-database engine seam landed.
`MEMOTURN_STRATA_NAMESPACES` (`*` or a namespace list) routes the selected `{ns}--{profile}`
databases' typed surfaces — memory, KV, docs, transcripts, branching, `/sync` — through strata
end-to-end on the real HTTP API, sharing the registry/lease/forwarding plumbing with libSQL
databases on the same node (disjoint object-store roots: `v1` vs `v2-strata`). `/sql` and
standalone vector collections reject with a clear error on strata databases. The flag is
experimental and intentionally absent from the published docs until the deferred gaps close.

**Update (2026-06, maintenance parity):** verifiable-erasure coupons now ride this engine —
the same coupon/grace/receipt flow, with the history rewrite as `erase_below` filtered
compaction and the absence proof listing the strata root (no `secure_delete` step exists
because erased history is rewritten into new objects by construction). The node maintenance
tick sweeps strata profiles (task/KV TTL + policy aging) and a background flusher ships
Standard-mode tails every ≤200 ms, replacing the per-write fire-and-forget ship.
