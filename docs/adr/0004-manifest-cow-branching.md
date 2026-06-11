# ADR-0004: Branching = manifest chains over the segment store

**Status:** accepted · 2026-06

**Decision:** a branch is a manifest in object storage referencing `parent@fork_txid` plus its own
segment chain. Fork/checkpoint/rewind/delete are each one CAS manifest write — O(1), no data
copied. Checkpoints are named txids. Burner branches carry `ttl_at` and are GC'd. Segments are
refcounted by referencing manifests; parent compaction preserves txids pinned by children; chain
depth is capped (8) with background flattening.

**Alternatives rejected:**
- *btrfs/ZFS reflinks*: ties correctness to node filesystems across three clouds; incompatible
  with disposable nodes.
- *Content-addressed page store*: strictly more powerful (cross-branch dedupe) but ~10× the
  machinery; manifest chains already deliver the product semantics. Revisit if storage-cost data
  demands dedupe.

**Out of scope for v1:** three-way merge. Agents fork-and-promote or fork-and-discard.

**Update (2026-06):** the refcount GC is implemented (`crates/replication/src/replicator.rs`):
the collector builds the referenced set across **all** branch manifests, so a copy-on-write child
sharing a parent's snapshot keeps it referenced and a leaf-branch delete never strands a parent.
A grace window (`MEMOTURN_GC_GRACE_SECS`, default 600 s) shields freshly-uploaded objects not yet
committed to a manifest. Manifest CAS conflicts retry (reload + re-fence + re-append — uploaded
segments are idempotent by txid range); objects orphaned by a lost race are reclaimed by GC.
