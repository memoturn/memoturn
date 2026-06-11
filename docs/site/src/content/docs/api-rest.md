---
title: REST API
description: The HTTP/JSON surface — agent-memory routes per profile, data-plane routes per database, and the control-plane platform API.
---

HTTP/JSON is Memoturn's primary protocol: stateless, serverless-friendly, and trivially callable
from agent tools. The surface has three groups: the agent-memory API (per
[profile](/profiles/)), the data-plane API (per database), and the control-plane platform API.

Addressing: one base URL per database (`https://{db}.{region}.memoturn.dev`). Against a single
node — the prototype default — the same data-plane routes are addressed as `/v1/db/{db}/...`,
where `{db}` may be `name` or `name@branch`. A branch can also be selected with the
`Memoturn-Branch` header.

Every response carries a `Memoturn-Txid` header. Requests may carry `Memoturn-Min-Txid` for a
read-your-writes floor and `Memoturn-Consistency: primary|cached` to pick a read mode. A write
may carry `Memoturn-Durability: durable` to be acked only after it ships to object storage. See
[consistency](/consistency/).

Authentication is a bearer token: a per-database or namespace JWT for memory and data-plane
routes, the platform key for control-plane routes. See [security](/security/).

## Agent-memory API

Per-profile routes. A profile is one database named `{ns}--{profile}`; isolation between
profiles is structural — no operation touches two profiles. Full semantics:
[memories](/memories/) and [recall](/recall/).

| Method | Path | Description |
| --- | --- | --- |
| POST | `/v1/memory/{ns}/{profile}/memories` | Batch ingest (idempotent; auto-creates the profile) |
| POST | `/v1/memory/{ns}/{profile}/recall` | Hybrid keyword + topic + vector query |
| POST | `/v1/memory/{ns}/{profile}/extract` | Server-side LLM distill then ingest (503 if the node has no extractor) |
| GET | `/v1/memory/{ns}/{profile}/memories/{id}` | One memory with its supersession chain |
| DELETE | `/v1/memory/{ns}/{profile}/memories/{id}` | Forget (hard delete) |
| GET | `/v1/memory/{ns}/{profile}/sessions` | List sessions |
| DELETE | `/v1/memory/{ns}/{profile}/sessions/{sid}` | End session: delete its task memories (`?turns=true` drops the transcript too) |
| GET | `/v1/memory/{ns}` | List profiles in the namespace (namespace token) |

### Ingest

One batch is one transaction and one `txid`. Memory IDs are content-addressed, so re-ingesting
the same memory is a no-op reported as `duplicate`. Embeddings are bring-your-own by default;
with node-side [auto-embedding](/embeddings/) enabled, omitted embeddings are filled in outside
the write path.

```json
POST /v1/memory/acme/alice/memories
{ "memories": [
  { "type": "fact", "topic_key": "user.editor-theme", "summary": "prefers dark mode",
    "content": {"preference": "dark"}, "keywords": "theme ui", "embedding": [0.1, 0.2] },
  { "type": "event", "summary": "deployed v2 to prod",
    "content": {"version": "v2"}, "session_id": "s-417" },
  { "type": "task", "summary": "follow up on refund #88", "content": {}, "ttl": 86400 }
] }
```

```json
201
{ "results": [
    { "id": "mem_9f2c...", "status": "created", "superseded": ["mem_31ab..."] },
    { "id": "mem_77d0...", "status": "created", "superseded": [] },
    { "id": "mem_c4e1...", "status": "created", "superseded": [] }
  ],
  "txid": 42 }
```

`status` is `created`, `revived` (an old superseded memory re-asserted and active again), or
`duplicate` (already active). Ingesting a `fact` or `instruction` whose `topic_key` has an active
memory supersedes the old row in the same transaction — history is preserved, not deleted.

### Recall

At least one of `query` (keyword channel), `embedding` (vector channel), or `topic_key` (exact
topic channel) is required. Channels are merged by reciprocal-rank fusion; superseded and expired
rows are dropped; each hit reports the channels that found it. An empty result is a valid answer.

```json
POST /v1/memory/acme/alice/recall
{ "query": "what theme does the user like?", "embedding": [0.1, 0.2],
  "topic_key": "user.editor-theme", "types": ["fact"], "k": 8 }
```

```json
200
{ "memories": [
    { "id": "mem_9f2c...", "type": "fact", "topic_key": "user.editor-theme",
      "summary": "prefers dark mode", "content": {"preference": "dark"},
      "keywords": "theme ui", "session_id": null, "created_at": 1765000000,
      "superseded_by": null, "score": 0.064, "channels": ["topic", "keyword", "vector"] }
  ],
  "txid": 42 }
```

`include_superseded: true` exposes superseded rows; `include_turns: true` (requires `embedding`)
additionally searches the verbatim transcript and returns matching turns in a separate `turns`
array, never mixed into the fused ranking. See [sessions](/sessions/).

### Extract

Opt-in per node (`MEMOTURN_EXTRACT_API_KEY`); unconfigured nodes return `503`. The LLM call runs
before any database write and is structured-output-constrained; proposals then flow through the
ordinary idempotent ingest. `dry_run: true` returns proposals without writing. See
[extraction](/extraction/).

```json
POST /v1/memory/acme/alice/extract
{ "turns": [ {"role": "user", "content": "I'm vegan now"} ],
  "session_id": "s-417", "dry_run": false }
```

## Data-plane API

Per-database routes — the multi-model substrate under every profile. See
[data model](/data-model/).

| Method | Path | Description |
| --- | --- | --- |
| POST | `/v1/sql` | Atomic statement batch |
| GET / PUT / DELETE | `/v1/kv/{ns}/{key}` | KV read / write (`?ttl=`) / delete; reads accept `?consistency=` |
| GET | `/v1/kv/{ns}?prefix=` | List keys by prefix |
| POST | `/v1/docs/{collection}/find` | Query documents (filter, sort, limit, skip) |
| POST | `/v1/docs/{collection}/insert` | Insert documents |
| POST | `/v1/docs/{collection}/update` | Update by filter (`$set/$unset/$inc/$push`) |
| POST | `/v1/docs/{collection}/delete` | Delete by filter |
| POST | `/v1/docs/{collection}/indexes` | Index a document path (generated column + B-tree) |
| POST | `/v1/vectors/{collection}` | Upsert an embedding |
| POST | `/v1/vectors/{collection}/search` | ANN search |
| POST | `/v1/memory/{session}/turns` | Append a transcript turn |
| GET | `/v1/memory/{session}/turns?last=20` | Read the recent window |
| POST | `/v1/memory/{session}/search` | Semantic search over turn embeddings |
| POST | `/v1/sync` | Ship this branch's state to object storage now |

### SQL

```json
POST /v1/db/agent-42/sql
{ "stmts": [ { "q": "SELECT count(*) FROM orders WHERE status = ?", "params": ["open"] } ] }
```

```json
200
{ "results": [ [ { "count(*)": 3 } ] ], "txid": 17 }
```

User SQL cannot reference reserved `__memoturn_` tables (KV, docs, memories, transcripts),
however the name is quoted. Sandbox escapes — `ATTACH`, `VACUUM INTO`, `PRAGMA writable_schema` —
are rejected; benign read-only PRAGMAs (`integrity_check`, `table_info`) pass. Mutating
statements need `write` scope; a read token gets `403`.

### KV

The value is the raw request/response body. `PUT /v1/kv/scratch/plan?ttl=3600` writes with a
TTL; `GET /v1/kv/scratch/plan?consistency=primary` forces a strongly consistent owner read
(default is `cached` — eventually consistent, `txid` disclosed). Prefix listing returns:

```json
GET /v1/kv/scratch?prefix=step:
{ "keys": ["step:1", "step:2"] }
```

### Documents

```json
POST /v1/db/agent-42/docs/notes/find
{ "filter": { "kind": "fact", "score": { "$gt": 0.5 } },
  "sort": { "score": -1 }, "limit": 10 }
```

```json
200
{ "docs": [ { "_id": "01J...", "kind": "fact", "score": 0.9 } ] }
```

`insert` takes `{ "docs": [...] }` and returns `{ "ids": [...] }`; `update` takes
`{ "filter", "update", "multi" }` and returns `{ "modified": n }`; `delete` returns
`{ "deleted": n }`; `indexes` takes `{ "path": "score" }`.

### Vectors and transcript turns

```json
POST /v1/db/agent-42/vectors/notes/search
{ "vector": [0.1, 0.2], "k": 8 }
```

```json
200
{ "hits": [ { "id": "01J...", "distance": 0.13 } ] }
```

Turns: `POST /v1/memory/{session}/turns` with `{ "role": "user", "content": {...},
"embedding": [...] }` returns `{ "seq": n }`; `GET .../turns?last=20` and
`POST .../search` with `{ "vector", "k" }` both return `{ "turns": [...] }`.

## Control-plane API

Platform routes, authenticated with the platform key.

| Method | Path | Description |
| --- | --- | --- |
| POST | `/v1/databases` | Create a database (`{name}`) |
| GET | `/v1/databases?cursor=` | List databases |
| DELETE | `/v1/databases/{db}` | Delete a database — write tokens minted before the deletion are revoked (`403`); see [security](/security/#token-revocation) |
| POST | `/v1/databases/{db}/branches` | Fork a branch (`{name, from?, checkpoint?, ttl?}`; `ttl` makes a burner branch) |
| POST | `/v1/databases/{db}/branches/{branch}/checkpoint` | Tag the current state (`{name}`) |
| POST | `/v1/databases/{db}/branches/{branch}/rewind` | Rewind to a checkpoint or txid (`{to}`) |
| POST | `/v1/databases/{db}/tokens` | Mint a per-database token (`{scope, expires_in}`) |
| POST | `/v1/namespaces/{ns}/tokens` | Mint a namespace token covering every profile under it |
| GET | `/v1/databases/{db}/usage` | Usage counters |

```json
POST /v1/databases/agent-42/tokens
{ "scope": "write", "expires_in": 3600 }
```

```json
200
{ "token": "eyJ..." }
```

Token scopes are `read` (recall, get), `write` (ingest, forget, session end), and `admin`
(checkpoint, rewind). Branch operations are O(1) manifest writes — see
[branching](/branching/).

## Limits

The request surface is bounded by default — every knob is per node, tunable via
[configuration](/configuration/#request-limits--durability):

- Bodies over 32 MiB return `413`; requests have a 30 s wall-clock budget and a global
  in-flight cap (1024).
- Control endpoints (provision, branches, tokens) are rate-limited (10 req/s sustained);
  overruns return `429`.
- Memory ingest batches cap at 1,000 memories per request; recall `k` and result limits clamp
  to 1,000.
- Document filters reject nesting deeper than 32 levels and `$in`/`$nin` arrays over
  1,000 items.

The same surface is available through the [CLI](/cli/), the
[TypeScript SDK](/sdk-typescript/), the [Python SDK](/sdk-python/), and the
[MCP server](/mcp/).
