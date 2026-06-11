---
title: Sessions & transcripts
description: Session grouping inside a profile, task-memory lifecycle, and the verbatim transcript layer with semantic search over raw turns.
---

A **session** is an optional grouping inside a memory [profile](/profiles/). Sessions scope two
things: **task memories** (typed memories that expire) and the **raw transcript layer** (verbatim
conversation turns). Session IDs are scoped to the profile — different profiles may reuse the
same session ID without collision.

Sessions need no explicit creation; they exist as soon as a task memory or a transcript turn
references them.

## Sessions and task memories

Of the four memory types ([Memories](/memories/)), `task` is the session-scoped one: tasks
attach to a `session_id` and expire via TTL (default 24 h).

```json
{ "memories": [
  { "type": "task", "summary": "follow up on refund #88", "content": {},
    "session_id": "s-417", "ttl": 86400 }
] }
```

Session lifecycle endpoints, on the profile API:

```
GET    /v1/memory/{ns}/{profile}/sessions          list sessions
DELETE /v1/memory/{ns}/{profile}/sessions/{sid}    end session: delete its task memories
                                                   (?turns=true to drop the transcript too)
```

```bash
# end session s-417: its task memories are deleted; facts/events/instructions are untouched
curl -X DELETE https://api.memoturn.dev/v1/memory/acme/alice/sessions/s-417 \
  -H "Authorization: Bearer $TOKEN"

# end the session and delete its raw transcript as well
curl -X DELETE "https://api.memoturn.dev/v1/memory/acme/alice/sessions/s-417?turns=true" \
  -H "Authorization: Bearer $TOKEN"
```

Ending a session is the only bulk delete in the memory API. Durable memories (`fact`, `event`,
`instruction`) never expire with a session, even when they carry a `session_id` for provenance.

## The transcript layer

Underneath the typed memory product, every profile database carries an append-optimized reserved
table, `__memoturn_messages`:

```sql
-- reserved table; unreachable from user SQL
-- (session_id, seq, role, content JSONB, embedding F32_BLOB NULL, created_at)
```

Three primitives operate on it:

| Primitive | Mechanism |
| --- | --- |
| `appendTurn` | append a turn (role, content, optional embedding) to a session |
| `getWindow` | indexed range read of the last N turns |
| `searchSemantic` | vector search over turn embeddings |

```ts
await db.memory.appendTurn(sessionId, { role: 'user', content, embedding });
await db.memory.getWindow(sessionId, { last: 20 });
await db.memory.searchSemantic(sessionId, queryEmbedding, { k: 5 });
```

Data-plane HTTP (per database):

```
POST /v1/memory/{session}/turns           append a turn
GET  /v1/memory/{session}/turns?last=20   read the recent window
POST /v1/memory/{session}/search          {vector, k} — semantic search over turns
```

```bash
curl -X POST https://acme--alice.us-east.memoturn.dev/v1/memory/s-417/turns \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"role": "user", "content": {"text": "switch me to the annual plan"}}'

curl "https://acme--alice.us-east.memoturn.dev/v1/memory/s-417/turns?last=20" \
  -H "Authorization: Bearer $TOKEN"
```

Turn embeddings are bring-your-own by default, like memory embeddings — see
[Embeddings](/embeddings/).

## Transcripts vs typed memories

The two layers answer different questions:

| | Transcript layer | Typed memories |
| --- | --- | --- |
| Content | verbatim turns, exactly as spoken | distilled knowledge (facts, events, instructions, tasks) |
| Identity | `(session_id, seq)` | content-addressed `mem_…` IDs, idempotent ingest |
| Evolution | append-only | supersession by topic key, history preserved |
| Retrieval | window reads, semantic search per session | hybrid [recall](/recall/) (keyword + topic + vector, rank-fused) |
| Lifetime | until deleted (`?turns=true` on session end) | durable, except TTL'd tasks |

Raw turns flow through the transcript API verbatim, so nothing is lost between extractions: the
transcript is the durable record, the typed memory is the usable knowledge.

## Transcript hits in recall

[Recall](/recall/) accepts an optional `include_turns: true` flag (requires an `embedding`).
It additionally searches the verbatim transcript — brute-force cosine over `__memoturn_messages`,
optionally session-scoped — and returns matching turns in a **separate `turns` array**. Turns are
not memories, so they ride alongside the fused ranking rather than being mixed into it.

```bash
curl -X POST https://api.memoturn.dev/v1/memory/acme/alice/recall \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"query": "what did we decide about the refund?",
       "embedding": [0.12, -0.04, 0.91],
       "include_turns": true, "k": 8}'
```

## Transcripts as extraction input

Transcripts are the natural input to **server-side extraction**: an opt-in endpoint
(`POST /v1/memory/{ns}/{profile}/extract`) that distills raw turns into typed memories through
the ordinary idempotent ingest path — same supersession, same duplicate reporting. The pattern
is: append every turn verbatim, then periodically extract; the transcript guarantees nothing is
lost between extraction passes. See [Extraction](/extraction/).

## Sessions and branching

Sessions live inside the profile database, so they fork and rewind with it. To let an experiment
converse and ingest freely without touching the real profile, burner-branch the profile and point
the session at the branch — see [Branching & burner branches](/branching/).
