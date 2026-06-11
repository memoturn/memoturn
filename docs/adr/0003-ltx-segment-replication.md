# ADR-0003: LTX-format segment log per database; object storage as source of truth

**Status:** accepted · 2026-06

**Decision:** each database replicates as an append-only log of immutable page-transaction
segments (LTX format: page images + txid range + checksums, zstd), captured from committed WAL
frames, sealed at 1 MB/200 ms, PUT to object storage and streamed to replicas. Object storage is
the source of truth; nodes are disposable. Level compaction provides PITR.

**Alternatives rejected:**
- *Litestream the tool*: right format, wrong process model (sidecar-per-DB doesn't fit a
  multi-tenant node). We adopt the format, not the tool.
- *LiteFS*: FUSE on multi-cloud K8s is operational pain; project effectively unsupported.
- *Page-server/shared storage (Neon-style)*: right for few-large-DBs; for millions of tiny DBs it
  centralizes every read on the network and ruins cold-DB economics.
- *FoundationDB-backed pages (mvSQLite)*: drags in a second distributed system; project dormant.

**Implemented (prototype):** page-level segments are live as the **MLTX** format (LTX-inspired,
not byte-compatible): committed frames are captured straight from the `-wal` file under the write
lock (`wal_autocheckpoint=0`; we own checkpointing), deduplicated to latest-page-per-segment,
lz4-compressed, and chained in the manifest after a base snapshot. A compaction snapshot ships
every 16 segments to bound restore cost; first-ship-of-a-branch is always a snapshot; a lost
capture cursor (unexpected WAL reset) falls back to a snapshot — correctness never depends on the
cursor.

**Hard-won constraint:** chain base snapshots must be **layout-faithful** images of the live file
(checkpoint-and-copy, or WAL-overlay in memory when a reader blocks truncation) — never
`VACUUM INTO`, which rewrites page numbers and would corrupt segment replay.

**Also implemented:** the live replica push stream — owners fan sealed segments (and compaction
snapshots) out to subscribed replica nodes over HTTP; replicas subscribe lazily on first read of a
branch they don't own and apply pushes via atomic file replacement, guarded by txid-chain
contiguity. Push is strictly an optimization: any gap, lost cursor, fresh local file, or dropped
subscription falls back to object-storage restore, and a node that currently owns the branch
refuses ingest.

**Still deferred:** PITR retention/GC of superseded objects, lazy page-fault VFS for >16 MB DBs,
gRPC transport for the node mesh (HTTP suffices at prototype scale).

**Update (2026-06):** GC of superseded objects has since landed — refcount GC over the union of
all branch manifests, grace-windowed via `MEMOTURN_GC_GRACE_SECS` (default 600 s; see the
ADR-0004 update). Manifest commits now CAS-retry on transient conflict (reload + re-fence +
re-append; orphaned uploads fall to GC), segments verify their checksums on decode, and a Durable
commit mode (`MEMOTURN_DURABILITY=durable`, or per-request `Memoturn-Durability: durable`) acks a
write only after segment ship + manifest CAS. PITR retention windows, the lazy page-fault VFS,
and gRPC mesh transport remain deferred.
