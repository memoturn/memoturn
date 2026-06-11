---
title: Documents, KV, SQL & vectors
description: The multi-model substrate inside every profile database — document collections, KV namespaces, full SQL, and native vectors under one consistency model.
---

Every Memoturn database — including every memory [profile](/profiles/) — is a complete
multi-model store. Documents, KV, vectors, conversation transcripts, and relational tables all
live in one database file, so they replicate, [branch](/branching/), and rewind together, and
they share one consistency model: every response carries `txid`
(see [Consistency & txid](/consistency/)).

The document API is the headline developer surface; SQL is the escape hatch. The typed
agent-memory layer ([Memories](/memories/), [Recall](/recall/)) is built on this substrate.

## Wire protocol

HTTP/JSON is the primary protocol. One base URL per database:
`https://{db}.{region}.memoturn.dev`, with branches addressed as `{db}@{branch}` (URL form or
`Memoturn-Branch` header). Every response carries `Memoturn-Txid`; requests may carry
`Memoturn-Min-Txid` and `Memoturn-Consistency: primary|cached`.

```
POST /v1/sql                          {stmts: [{q, params}], txn?: true}
GET|PUT|DELETE /v1/kv/{ns}/{key}      (?ttl=, ?consistency=, list: GET /v1/kv/{ns}?prefix=)
POST /v1/docs/{collection}/find|insert|update|delete|indexes
POST /v1/vectors/{collection}/search  {vector, k}
POST /v1/memory/{session}/turns | GET /v1/memory/{session}/turns?last=20
POST /v1/memory/{session}/search      {vector, k}
```

The transcript routes are covered in [Sessions & transcripts](/sessions/); the full route
reference is in [REST API](/api-rest/).

## Document collections

JSON document collections stored as JSONB in reserved tables (`__memoturn_docs_{collection}`),
queried with a familiar operator-based filter syntax. Filters compile to SQL over
`jsonb_extract`. Collections are created lazily; documents get a ULID
`_id` if absent.

```ts
const notes = db.docs.collection('notes');
await notes.insertOne({ kind: 'fact', text: 'prefers dark mode', score: 0.9 });
await notes.find({ kind: 'fact', score: { $gt: 0.5 } }, { sort: { score: -1 }, limit: 10 });
await notes.updateOne({ _id }, { $set: { score: 1.0 }, $inc: { hits: 1 } });
await notes.createIndex('score');     // generated column + B-tree index
```

```bash
curl -X POST https://agent-42.us-east.memoturn.dev/v1/docs/notes/find \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"filter": {"kind": "fact", "score": {"$gt": 0.5}}, "sort": {"score": -1}, "limit": 10}'
```

| Capability | v1 support |
| --- | --- |
| Filter operators | equality, `$gt/$gte/$lt/$lte/$ne/$in/$nin`, `$exists`, `$and/$or/$not`, dot-path fields |
| Update operators | `$set/$unset/$inc/$push` |
| Query options | `sort`, `limit`, `skip` |
| Indexes | `createIndex(path)` → generated column + B-tree; indexed queries are ordinary B-tree lookups |
| Aggregation pipelines | out of scope — use the SQL escape hatch |

There is no foreign wire-protocol compatibility; the API is Memoturn's own HTTP surface and SDKs.

## KV namespaces

A reserved table per database (`__memoturn_kv`) accessed through a non-SQL fast path with cached
prepared statements — no SQL-injection surface, hot reads measured at **3 µs p50** (prototype).
Namespaces are rows, not tables: creating one is free.

```ts
await db.kv.put('scratch', 'plan', bytes, { ttl: 3600 });
await db.kv.get('scratch', 'plan', { consistency: 'cached' });
await db.kv.list('scratch', { prefix: 'step:' });
```

```bash
curl -X PUT "https://agent-42.us-east.memoturn.dev/v1/kv/scratch/plan?ttl=3600" \
  -H "Authorization: Bearer $TOKEN" --data-binary @plan.json
curl "https://agent-42.us-east.memoturn.dev/v1/kv/scratch?prefix=step:" \
  -H "Authorization: Bearer $TOKEN"
```

- **TTL:** lazy expiry on read plus a background sweeper for hot/warm databases; a cold database
  is never woken just to expire keys.
- **Cached reads:** a per-node in-memory cache serves `cached` reads in microseconds.
  Invalidation rides the replication stream; a per-namespace `max_age` (default 30 s) is the
  backstop. The contract is explicitly eventual for cached reads, with `min_txid` when
  read-your-writes matters — see [Consistency & txid](/consistency/#read-modes).

## SQL escape hatch

Full SQL against the same database, for everything the document filter subset doesn't cover.

```ts
await db.sql('SELECT count(*) FROM orders WHERE status = ?', ['open']);
```

```bash
curl -X POST https://agent-42.us-east.memoturn.dev/v1/sql \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"stmts": [{"q": "SELECT count(*) FROM orders WHERE status = ?", "params": ["open"]}]}'
```

```sql
-- multi-statement transaction: {"stmts": [...], "txn": true}
INSERT INTO orders (id, status) VALUES (?, 'open');
UPDATE counters SET n = n + 1 WHERE k = 'orders';
```

Reserved tables are prefixed `__memoturn_` (`__memoturn_kv`, `__memoturn_docs_{collection}`,
`__memoturn_messages`, `__memoturn_memories*`). User SQL cannot reference them, however the name
is quoted — the typed surfaces (KV, docs, memory) are the only paths to them. Sandbox escapes
(`ATTACH`, `VACUUM INTO`, `PRAGMA writable_schema`) are rejected, mutating statements need
`write` scope, and benign read-only PRAGMAs pass. See [Security](/security/#the-sql-guard).

## Vectors

Vectors are native `F32_BLOB` columns with a DiskANN index, inside the database file. Because
they are ordinary indexed columns, vectors **replicate, fork, and rewind with the database** —
a branch or rewind of a profile carries its embeddings with it, exactly in sync with the rows
they describe. Agent-memory scale (10³–10⁵ embeddings per database) is squarely in DiskANN's
comfort zone.

```ts
await db.vectors.upsert('notes', id, embedding);
await db.vectors.search('notes', queryEmbedding, { k: 8 });
```

```bash
curl -X POST https://agent-42.us-east.memoturn.dev/v1/vectors/notes/search \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"vector": [0.12, -0.04, 0.91], "k": 8}'
```

Embeddings are bring-your-own by default; per-node auto-embedding is an opt-in — see
[Embeddings](/embeddings/).

## One unit of state

| Property | Consequence |
| --- | --- |
| One database file per profile | documents, KV, vectors, transcripts, memories share transactions and `txid` |
| Object storage is the source of truth | nodes are disposable; idle databases cost object-storage cents |
| Branching at the manifest layer | a fork captures every model at one transaction boundary — see [Branching & burner branches](/branching/) |
| Instant provisioning | creating a database is a metadata write (**17 µs p50**, prototype) |

Measured prototype p50s (single node, in-process object store): SQL write 16 µs, doc insert
15 µs, hot KV read 3 µs. Reproduce with `cargo run --release -p memoturn-bench` —
[github.com/memoturn/memoturn](https://github.com/memoturn/memoturn).

SDK setup and full client shapes: [TypeScript SDK](/sdk-typescript/),
[Python SDK](/sdk-python/), [Quickstart](/quickstart/).
