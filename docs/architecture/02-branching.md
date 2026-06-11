# 02 — Branching, Checkpoints, PITR

Branching is Memoturn's flagship agentic feature: **fork-test-rewind-or-discard** for an agent's
entire state. It is implemented as manifest operations over the immutable segment store — no page
copying, no filesystem snapshots. ([ADR-0004](../adr/0004-manifest-cow-branching.md))

## Branch manifests

Every branch of every database is described by a small JSON object in object storage:

```json
{
  "branch_id": "experiment-1",
  "parent": { "db_uuid": "d_19c2", "branch_id": "main", "fork_txid": 4812 },
  "epoch": 7,
  "checkpoints": { "before-migration": 4812 },
  "ttl_at": null,
  "segments": [ "ltx/0/4813-4900-7.ltx", "..." ]
}
```

Because the segment log is immutable and append-only, a **fork is one CAS manifest write** —
O(1), milliseconds, zero data copied. The child resolves pages from its own chain first, then the
parent chain up to `fork_txid`. Hot same-node forks may hard-link the materialized file as a
shortcut, but correctness never depends on local state.

## Operations

| Operation | Mechanism | Cost |
| --- | --- | --- |
| `branch create db@main → db@x` | write child manifest referencing `parent@txid` | one CAS PUT |
| `checkpoint name` | tag current txid in the manifest | one CAS PUT |
| `rewind to name\|txid` | reset branch head to tagged txid (PITR restore on next read) | one CAS PUT |
| `branch delete` | tombstone manifest; segments GC'd by refcount | one CAS PUT |
| burner branch | manifest with `ttl_at`; GC incinerates on expiry | one CAS PUT |

Addressing: `db@branch` everywhere (connection strings, SDK, MCP, CLI). `@main` is implicit.

## Epoch fencing (why zombies are harmless)

Single-writer is enforced by leases ([03](03-control-plane.md)), but leases only make split-brain
*unlikely*. Fencing makes it *harmless*:

- Every manifest update is a **compare-and-swap** (S3 conditional writes / `If-Match`; supported
  on S3, GCS, Azure, MinIO) carrying the writer's epoch.
- Every segment object name embeds its epoch.
- A new owner increments the epoch in its first manifest CAS. A zombie old primary can still PUT
  segment objects, but it can never link them into the manifest — they are unreferenced orphans,
  removed by GC.
- Benign CAS conflicts (two ships racing on the same branch) are retried: reload the manifest,
  re-fence at the writer's epoch, re-append. The uploaded segment is idempotent by txid range; if
  the chain already moved past it, the orphaned object falls to GC and the WAL cursor stays put,
  so nothing is lost.

## PITR

Level compaction of the segment log retains restore-to-any-txid within the retention window
(default 24 h fine-grained, 30 d snapshot-grained). Checkpoints are just named txids, so
"rewind the agent to before the migration" and "restore to 14:32 yesterday" are the same machinery.

As shipped (ADR-0003 update), the retention window is enforced by snapshot-floor pruning:
`MEMOTURN_PITR_RETENTION_SECS` (default 86400; 0 disables) bounds restore-to-any-boundary,
`MEMOTURN_PITR_SNAPSHOT_RETENTION_SECS` (default 2592000) keeps older snapshots as coarse
restore points. Named checkpoints pin their history regardless of age; the floor snapshot is
never pruned. Level compaction (ltx/1, ltx/2) remains the planned optimization for restore cost.
Per-namespace governance policies may tighten (never widen) these windows per profile database —
effective = `min(env, policy)` ([08](08-data-governance.md), ADR-0010).

## GC

- Segments and snapshots are refcounted by the manifests that reference them: the collector
  builds the referenced set across **all** branch manifests of the database, so a copy-on-write
  child sharing a parent's snapshot keeps it referenced — a leaf-branch delete never strands a
  parent, and vice versa.
- A grace window (`MEMOTURN_GC_GRACE_SECS`, default 600 s) shields objects uploaded but not yet
  linked into a manifest; once aged, unreferenced objects (failed CAS races, deleted branches,
  superseded segments) are deleted. The pass is idempotent and safe to run from any node.
- Parent compaction must preserve any txid boundary pinned by a child fork — the compactor
  consults the branch index in the control plane before collapsing levels.
- Deep parent chains are capped (default 8); beyond that, a background materializer flattens the
  branch into its own snapshot.
- Burner branches: on `ttl_at` expiry, manifest tombstoned, scratch-prefix segments deleted.

## Agentic semantics

- **fork-test-discard:** `branch create --burner --ttl 1h` → run the risky migration/tool-call
  sequence against `db@burner` → inspect → branch expires or is deleted. The main branch never saw it.
- **fork-test-promote:** if the experiment succeeds, the app switches its connection string to the
  new branch (branch promotion = catalog pointer update; no data movement). Merge semantics are
  deliberately out of scope for v1 — agents promote or discard, they don't three-way-merge.
- **checkpoint-rewind:** checkpoint before each multi-step task; rewind on failure. This gives
  agent frameworks transactional semantics at task granularity, above SQL transactions.
