---
title: Branching & burner branches
description: O(1) copy-on-write branching, checkpoints, rewind, and auto-expiring burner branches for fork-test-discard agent workflows.
---

Every Memoturn database — and therefore every memory [profile](/profiles/) — can be forked,
checkpointed, and rewound as a single unit. Branching is implemented as manifest operations over
the immutable segment log in object storage: **no pages are copied, no filesystem snapshots are
taken**. A fork is one compare-and-swap (CAS) manifest write. Measured branch create:
**47 µs p50** (prototype, single node, in-process object store).

## Branch manifests

Each branch of each database is described by a small JSON manifest in object storage:

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

Because the segment log is immutable and append-only, a child branch is just a manifest that
references `parent@fork_txid`. Reads resolve pages from the child's own segment chain first, then
the parent chain up to `fork_txid`. A fork captures everything in the database — documents, KV,
vectors, transcripts, typed memories, history — at a transaction boundary.

## Operations

| Operation | Mechanism | Cost |
| --- | --- | --- |
| branch create | write child manifest referencing `parent@fork_txid` | one CAS PUT |
| checkpoint | tag the current `txid` by name in the manifest | one CAS PUT |
| rewind | reset the branch head to a tagged checkpoint or raw `txid` (PITR restore on next read) | one CAS PUT |
| branch delete | tombstone the manifest; segments GC'd by refcount | one CAS PUT |
| burner branch | manifest carries `ttl_at`; GC incinerates on expiry | one CAS PUT |

Branches are addressed as `db@branch` everywhere — connection strings, SDKs, MCP, CLI, and the
`Memoturn-Branch` HTTP header. `@main` is implicit.

Rewind and point-in-time restore are the same machinery: checkpoints are named txids, and level
compaction of the segment log retains restore-to-any-txid within the retention window (default
24 h fine-grained, 30 d snapshot-grained).

## Burner branches

A **burner branch** is a branch created with a TTL. The manifest carries `ttl_at`; when it
expires, GC tombstones the manifest and deletes the branch's scratch segments. Nothing on the
parent branch is touched. Burner branches are the unit of safe experimentation: an agent forks,
writes freely, and the fork disappears on its own.

```ts
const burner = await db.branch.create('try-migration', { ttl: 3600 });  // burner branch
```

## Epoch fencing

Single-writer semantics are enforced by writer leases (see [Consistency & txid](/consistency/)),
but leases only make split-brain unlikely. Fencing makes zombie writers harmless:

- Every manifest update is a CAS (S3 conditional writes / `If-Match`; supported on S3, GCS,
  Azure, MinIO) carrying the writer's epoch.
- Every segment object name embeds its epoch.
- A new owner increments the epoch in its first manifest CAS. A zombie old primary can still PUT
  segment objects, but it can never link them into the manifest — they remain unreferenced
  orphans, removed by GC.

## Agentic semantics

- **fork-test-discard.** Create a burner branch, run the risky migration or tool-call sequence
  against `db@burner`, inspect the result, let the branch expire (or delete it). The main branch
  never saw the experiment.
- **fork-test-promote.** If the experiment succeeds, switch the application's connection string
  to the new branch. Promotion is a catalog pointer update — no data movement. Merge semantics
  are deliberately out of scope: agents promote or discard, they don't three-way-merge.
- **checkpoint-rewind.** Checkpoint before each multi-step task; rewind on failure. This gives
  agent frameworks transactional semantics at task granularity, above SQL transactions.

Because a [profile](/profiles/) is one database, branching a profile branches an agent's whole
memory: snapshot an agent's mind before a risky autonomous run, rewind if it learned garbage,
burner-branch a session and discard it, or fork a persona's entire memory as the starting point
for a new agent. See [Memories](/memories/) and [Sessions & transcripts](/sessions/).

## HTTP

Branch operations are control-plane calls:

```
POST /v1/databases/{db}/branches                       {name, from?, checkpoint?, ttl?}
POST /v1/databases/{db}/branches/{branch}/checkpoint   {name}
POST /v1/databases/{db}/branches/{branch}/rewind       {to}
```

```bash
# burner branch from main, expires in one hour
curl -X POST https://api.memoturn.dev/v1/databases/agent-42/branches \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"name": "try-migration", "ttl": 3600}'

# checkpoint, then rewind
curl -X POST https://api.memoturn.dev/v1/databases/agent-42/branches/main/checkpoint \
  -H "Authorization: Bearer $TOKEN" -d '{"name": "before-task"}'

curl -X POST https://api.memoturn.dev/v1/databases/agent-42/branches/main/rewind \
  -H "Authorization: Bearer $TOKEN" -d '{"to": "before-task"}'
```

Data-plane requests address a branch with the `Memoturn-Branch` header or the `{db}@{branch}`
URL form — see [REST API](/api-rest/).

## CLI

```bash
memoturn branch create agent-42 try-migration --ttl 3600   # burner branch
memoturn branch checkpoint agent-42 before-task
memoturn branch rewind agent-42 before-task
memoturn branch list agent-42
```

See [CLI](/cli/) for the full command reference.

## SDK

```ts
const db = mt.db('agent-42@main', { token });

const burner = await db.branch.create('try-migration', { ttl: 3600 });
await db.branch.checkpoint('before-task');
await db.branch.rewind('before-task');
```

The Python SDK mirrors this 1:1 — see [TypeScript SDK](/sdk-typescript/) and
[Python SDK](/sdk-python/).

## GC and parent chains

- Segments are refcounted by the manifests that reference them, directly or via parent chains.
  Unreferenced objects — deleted branches, expired burners, zombie-writer orphans — are
  reclaimed after a grace window (`MEMOTURN_GC_GRACE_SECS`, default 600 s), so copy-on-write
  sharing is never broken by GC.
- Parent compaction preserves any txid boundary pinned by a child fork.
- Deep parent chains are capped (default 8); beyond that, a background materializer flattens the
  branch into its own snapshot.

For the underlying segment-log design, see [Architecture](/architecture/).
