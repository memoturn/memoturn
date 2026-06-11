# 04 — Data Model & API

This is the **substrate** under the agent-memory product ([07](07-agent-memory.md)): one tiny
database per memory profile holding documents, KV, vectors, conversation memory, and relational
tables — all replicated, branched, and rewound as a unit. The general-purpose developer surface
is a Mongo-style document API
([ADR-0006](../adr/0006-documents-on-jsonb.md)); SQL is the escape hatch. There is **no Mongo
wire-protocol compatibility in v1** — our own HTTP API and SDKs ([ADR-0007 note in
0006](../adr/0006-documents-on-jsonb.md)).

## Wire protocol

- **HTTP/JSON** is the primary protocol — stateless, serverless-friendly, trivially callable from
  agent tools. One base URL per database: `https://{db}.{region}.memoturn.dev`, branch addressed
  as `{db}@{branch}` (header `Memoturn-Branch` or URL form).
- WebSocket upgrade for interactive transactions and change streams.
- gRPC is internal-only (node↔node forwarding, segment streams).
- Every response carries `Memoturn-Txid`. Requests may carry `Memoturn-Min-Txid` (read-your-writes),
  `Memoturn-Consistency: primary|cached`, and `Memoturn-Durability: durable` (escalate this one
  write to Durable mode — segment ship + manifest CAS before the txid is returned; escalation
  only, never lowering the node default — [01](01-storage-engine.md#durability)).

## Unified SDK shape (TypeScript)

```ts
const mt = memoturn({ token });                       // platform client
const db = await mt.databases.create('agent-42');     // ~ms, metadata-only
// or: const db = mt.db('agent-42@main', { token });

// Documents (headline API)
const memories = db.docs.collection('memories');
await memories.insertOne({ kind: 'fact', text: 'prefers dark mode', score: 0.9 });
await memories.find({ kind: 'fact', score: { $gt: 0.5 } }, { sort: { score: -1 }, limit: 10 });
await memories.updateOne({ _id }, { $set: { score: 1.0 }, $inc: { hits: 1 } });
await memories.createIndex('score');                  // generated column + B-tree index

// KV with TTL (scratchpad)
await db.kv.put('scratch', 'plan', bytes, { ttl: 3600 });
await db.kv.get('scratch', 'plan', { consistency: 'cached' });
await db.kv.list('scratch', { prefix: 'step:' });

// Vectors (semantic memory)
await db.vectors.upsert('memories', id, embedding);
await db.vectors.search('memories', queryEmbedding, { k: 8 });

// Conversation memory primitives
await db.memory.appendTurn(sessionId, { role: 'user', content, embedding });
await db.memory.getWindow(sessionId, { last: 20 });
await db.memory.searchSemantic(sessionId, queryEmbedding, { k: 5 });

// SQL escape hatch
await db.sql('SELECT count(*) FROM orders WHERE status = ?', ['open']);

// Branching
const burner = await db.branch.create('try-migration', { ttl: 3600 });  // burner branch
await db.branch.checkpoint('before-task');
await db.branch.rewind('before-task');
```

The Python SDK mirrors this 1:1 (`db.docs.collection(...).find_one(...)`, `db.kv.put(...)`, …).

## Document layer semantics

- Collections are created lazily; documents get `_id` (ULID) if absent.
- Filter subset (v1): equality, `$gt/$gte/$lt/$lte/$ne/$in/$nin`, `$exists`, `$and/$or/$not`,
  dot-path field access. Update operators: `$set/$unset/$inc/$push`. `sort/limit/skip` on find.
- Compiled to SQL over JSONB (`jsonb_extract`); `createIndex(path)` adds a generated column +
  index, making indexed document queries ordinary B-tree lookups.
- Aggregation pipelines are out of scope for v1 — that's what the SQL escape hatch is for.

## Guardrails on the open surface

Every data-plane route assumes hostile input:

- **SQL guard** (`crates/engine/src/sqlguard.rs`): user SQL on the escape hatch passes a lexical
  tokenizer before execution. Reserved `__memoturn_*` tables cannot be referenced as identifiers
  however quoted (`"…"`, `` `…` ``, `[…]`) — while the same name inside a string literal is *not*
  a false positive, because the check keys off identifier tokens. Read-scoped tokens are held to
  read-only statements by conservative keyword classification: a mutating keyword anywhere in the
  statement — including inside a CTE body — fails closed. `ATTACH`, `VACUUM INTO`, and
  `PRAGMA writable_schema` escapes are forbidden; benign PRAGMAs (`integrity_check`,
  `table_info`, …) pass.
- **Query caps:** document filters are depth-capped (32) and `$in`/`$nin` arrays size-capped
  (1000 items); any client-requested result count (`limit`, recall/search `k`) is clamped to
  1000; memory ingest accepts at most 1000 memories per batch (one batch = one transaction, so an
  unbounded batch is an unbounded lock hold).
- **Request surface:** control/query bodies cap at 1 MiB and data-bearing writes at 32 MiB
  (`MEMOTURN_MAX_BODY_BYTES`; oversize → 413 before allocation); per-request wall clock
  `MEMOTURN_REQUEST_TIMEOUT` (default 30 s); a global in-flight cap `MEMOTURN_MAX_CONCURRENCY`
  (default 1024); and a shared token bucket over the credential/control endpoints,
  `MEMOTURN_CONTROL_RATE` (default 10 req/s, 429 on excess). CORS is deny-by-default.

## Memory

Typed memories, supersession, idempotent ingest, and hybrid recall are the headline product —
specified in [07-agent-memory](07-agent-memory.md) ([ADR-0009](../adr/0009-typed-agent-memory.md)).
The transcript layer lives here as a primitive:

- `__memoturn_messages` append-optimized table: `(session_id, seq, role, content JSONB,
  embedding F32_BLOB NULL, created_at)`; `appendTurn`/`getWindow` are indexed range reads;
  `searchSemantic` = vector search over turn embeddings.
- Embeddings: **bring-your-own** in v1 (client passes vectors), for typed memories and turns
  alike. Server-side auto-embedding (provider keys per tenant) is a fast-follow.
- Ephemeral session databases: create with `{ ttl }` → whole-DB TTL, hibernates then expires.

## KV consistency contract (Cloudflare-KV-style, made explicit)

| Read mode | Guarantee | Typical latency |
| --- | --- | --- |
| `primary` | strongly consistent (owner read) | in-region RTT + ~100 µs |
| `cached` (default for `kv.get`) | eventually consistent; staleness ≤ replication lag (~1 s) or namespace `max_age` (default 30 s) backstop; response discloses `txid` | µs (node cache) |
| `cached` + `min_txid` | read-your-writes floor | µs–ms (revalidates if behind) |

## Control-plane REST (platform API)

```
POST   /v1/databases                  {name, region, ttl?, durability?}
GET    /v1/databases?cursor=...
DELETE /v1/databases/{db}
POST   /v1/databases/{db}/branches    {name, from?, checkpoint?, ttl?}
POST   /v1/databases/{db}/branches/{branch}/checkpoint   {name}
POST   /v1/databases/{db}/branches/{branch}/rewind       {to}
POST   /v1/databases/{db}/tokens      {scope, expires_in}
GET    /v1/databases/{db}/usage
```

## Data-plane HTTP (per database)

```
POST /v1/sql                          {stmts: [{q, params}], txn?: true}
GET|PUT|DELETE /v1/kv/{ns}/{key}      (?ttl=, ?consistency=, list: GET /v1/kv/{ns}?prefix=)
POST /v1/docs/{collection}/find|insert|update|delete|indexes
POST /v1/vectors/{collection}/search  {vector, k}
POST /v1/memory/{session}/turns | GET /v1/memory/{session}/turns?last=20
POST /v1/memory/{session}/search      {vector, k}
```

## Agent-memory HTTP (per profile — see [07](07-agent-memory.md))

```
POST   /v1/memory/{ns}/{profile}/memories          ingest batch (idempotent)
POST   /v1/memory/{ns}/{profile}/recall            hybrid keyword+topic+vector query
POST   /v1/memory/{ns}/{profile}/extract           server-side LLM distill → ingest (opt-in)
GET    /v1/memory/{ns}/{profile}/memories/{id}     one memory + supersession chain
DELETE /v1/memory/{ns}/{profile}/memories/{id}     forget
GET    /v1/memory/{ns}/{profile}/sessions | DELETE /v1/memory/{ns}/{profile}/sessions/{sid}
GET    /v1/memory/{ns}                             list profiles
```

## CLI

`memoturn dev` (local node + MinIO via docker) · `db create|list|delete` ·
`branch create|checkpoint|rewind|list` · `shell` (SQL + doc REPL) · `token create` · `ask`
(the built-in assistant) — see [06](06-mcp-and-assistant.md).
