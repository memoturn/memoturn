---
title: Typed memories
description: The memory record schema, the four memory types, supersession, idempotent ingest, and forget.
---

Agent memory is not a vector store with extra steps. A memory is a typed record inside a
[profile](/profiles/) database, and the type determines its lifecycle: facts and instructions
supersede, events accumulate, tasks expire — the store enforces the semantics instead of your
prompt.

## The memory record

| Field | Notes |
| --- | --- |
| `id` | content-addressed: `mem_` + truncated SHA-256 of (`type`, `topic_key`, canonical `content`) |
| `type` | `fact` · `event` · `instruction` · `task` |
| `topic_key` | the supersession key; valid only on `fact` and `instruction` (e.g. `user.diet`) |
| `summary` | one-line natural-language gist; FTS-indexed |
| `content` | JSON payload — the full memory |
| `keywords` | optional space-separated terms; FTS-indexed alongside `summary` |
| `embedding` | optional `f32` vector; powers the [vector recall channel](/recall/). Bring-your-own by default; with [auto-embedding](/embeddings/) the node embeds `summary + keywords` at ingest |
| `session_id` | optional grouping; required semantics only for tasks — see [Sessions](/sessions/) |
| `superseded_by` / `superseded_at` | set when a newer memory replaces this one; history preserved |
| `expires_at` | tasks only; default 24 h TTL |

Ingest results carry a `status` per memory: `created`, `revived`, or `duplicate` (see below).

## Type semantics

| Type | Supersession | Embeddings | Lifetime |
| --- | --- | --- | --- |
| `fact` | by `(type, topic_key)` — newer replaces older, old row kept | yes | durable |
| `instruction` | same as `fact` | yes | durable |
| `event` | never — events accumulate | yes | durable |
| `task` | never | skipped (no vector channel) | TTL, session-scoped, default 24 h |

## Supersession

Supersession is a state machine, not a delete. Ingesting a fact whose `topic_key` already has an
active memory marks the previous row `superseded_by = <new id>` in the same transaction.

Running example — the user's diet changes:

```bash
# 1. initial fact
curl -X POST http://localhost:8080/v1/memory/acme/alice/memories \
  -H 'content-type: application/json' \
  -d '{"memories": [{"type": "fact", "topic_key": "user.diet",
       "summary": "vegetarian since 2024", "content": {"diet": "vegetarian"},
       "keywords": "food preference"}]}'
# → {"results": [{"id": "mem_a1…", "status": "created", "superseded": []}], "txid": 41}

# 2. the fact changes
curl -X POST http://localhost:8080/v1/memory/acme/alice/memories \
  -H 'content-type: application/json' \
  -d '{"memories": [{"type": "fact", "topic_key": "user.diet",
       "summary": "vegan since 2026", "content": {"diet": "vegan"},
       "keywords": "food preference"}]}'
# → {"results": [{"id": "mem_b2…", "status": "created", "superseded": ["mem_a1…"]}], "txid": 42}
```

[Recall](/recall/) now returns only the vegan fact. The vegetarian row is preserved:
`GET /v1/memory/acme/alice/memories/mem_a1…` returns it with `superseded_by` and `superseded_at`
set, and fetching `mem_b2…` lists `mem_a1…` under `supersedes` — the full chain in both
directions. Recall with `"include_superseded": true` exposes superseded rows in results.

Events never supersede: `{"type": "event", "summary": "ordered the vegan tasting menu"}` simply
accumulates alongside every previous event.

## Idempotent ingest

The `id` is a content hash, so ingest is idempotent by construction:

- Re-ingesting an already-active memory → `status: "duplicate"`, no write.
- Re-ingesting a memory that exists but was superseded → `status: "revived"`: the old row becomes
  active again and the supersession pointer moves. Re-asserting an old fact reinstates it.
- Anything else → `status: "created"`.

Agents can replay extraction output without flooding the store with copies.

## Batch ingest

`POST /v1/memory/{ns}/{profile}/memories` takes a batch; one batch is one transaction and returns
one `txid`. Batches cap at 1,000 memories per request. The profile [auto-creates](/profiles/) on
first ingest.

```json
{ "memories": [
  { "type": "fact", "topic_key": "user.diet", "summary": "vegan since 2026",
    "content": {"diet": "vegan"}, "keywords": "food preference" },
  { "type": "event", "summary": "deployed v2 to prod",
    "content": {"version": "v2"}, "session_id": "s-417" },
  { "type": "task", "summary": "follow up on refund #88", "content": {}, "ttl": 86400 }
] }
```

Response:

```json
{ "results": [
    {"id": "mem_b2…", "status": "duplicate", "superseded": []},
    {"id": "mem_c3…", "status": "created", "superseded": []},
    {"id": "mem_d4…", "status": "created", "superseded": []}
  ],
  "txid": 43 }
```

Typed-fact ingest with a 256-dim embedding and supersession measured **3.9 ms p50** on the
prototype.

Deciding *what* is memorable — extraction — is the client's job by default; the optional
server-side extraction endpoint distills raw transcripts into typed memories through this same
ingest path. See [Extraction](/extraction/).

## Forget

`DELETE /v1/memory/{ns}/{profile}/memories/{id}` is the only hard removal — it deletes the row,
its FTS entry, and its vector. Everything else (supersession, task expiry) preserves or merely
hides history.

```bash
curl -X DELETE http://localhost:8080/v1/memory/acme/alice/memories/mem_a1…
```

## Storage

Memories live in reserved tables inside the profile database: `__memoturn_memories` (rows and
supersession columns), `__memoturn_memories_fts` (FTS5 external-content index),
`__memoturn_memories_vec` (vectors, created lazily at the client's embedding dimension), and
`__memoturn_memory_sessions`. Reserved tables are unreachable from user SQL, and all of them
replicate, fork, and rewind with the database as one unit — see [Branching](/branching/).
