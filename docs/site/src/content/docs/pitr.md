---
title: Point-in-time recovery
description: Two retention tiers, checkpoints and rewind, and burner-branch recovery — how to get any earlier state of a memory back.
---

A profile is one database, so "undo what the agent just learned" is a database operation, not a
data cleanup. Memoturn gives you three instruments, from cheapest to most general: checkpoints
you place yourself, burner branches for what-ifs, and PITR retention for everything you didn't
think to checkpoint.

## Checkpoints and rewind

Tag a known-good state before anything risky, and rewind to it by name:

```bash
memoturn branch checkpoint acme--alice main before-autonomous-run
# ... the agent runs, learns something wrong ...
memoturn branch rewind acme--alice main before-autonomous-run
```

Both SDKs expose this on the profile (`alice.checkpoint(...)` / `alice.rewind(...)`); rewind
also accepts a raw txid. Rewinding is atomic across the whole memory — typed memories,
transcript, KV, documents — because they share the database. Requires admin scope.

## Burner branches for speculation

When you want to *try* something rather than protect against it, fork instead of checkpointing:

```bash
memoturn branch create acme--alice experiment --ttl 3600
```

The fork is O(1) copy-on-write; with `--ttl` it's a burner branch that expires on its own.
Main never sees the experiment unless you decide it should. See
[branching](/branching/).

## The PITR window

For everything you didn't anticipate, the node retains history in two tiers:

| tier | env var | default | granularity |
| --- | --- | --- | --- |
| Fine-grained | `MEMOTURN_PITR_RETENTION_SECS` | 86400 (24 h) | every txid in the window |
| Snapshot-grained | `MEMOTURN_PITR_SNAPSHOT_RETENTION_SECS` | 2592000 (30 d) | periodic snapshots |

Within the fine-grained window you can rewind to any txid; beyond it, to the nearest retained
snapshot. Setting `MEMOTURN_PITR_RETENTION_SECS=0` disables the fine-grained tier.

Because object storage is the source of truth, retention is a property of the storage layer —
nodes are disposable and a pod restart never costs history. Verifiable erasure is the one
deliberate exception: it rewrites history below the forget txid so the erased data is gone from
the past too (see [security](/security/)).

## A recovery decision tree

1. **You checkpointed** → `rewind` to the checkpoint name. Done.
2. **You know roughly when it went wrong** → read the txid from an earlier response (every
   response carries `Memoturn-Txid`) or from the audit stream, and `rewind` to it.
3. **You want to inspect before committing** → fork a branch *from* the good point, look
   around on the branch, then rewind main only once you're sure.
4. **It's older than the fine-grained window** → rewind to the nearest snapshot within the
   30-day tier.

Related: `MEMOTURN_GC_GRACE_SECS` (default 600) is the refcount grace window for object GC —
it protects in-flight readers, not history; the PITR vars are what determine how far back you
can go.
