---
title: Python SDK
description: memoturn — Python client for typed agent memory and the multi-model substrate, with httpx as its only dependency.
---

`memoturn` is the Python client for Memoturn. One dependency: `httpx`. Source:
[github.com/memoturn/memoturn](https://github.com/memoturn/memoturn), `sdk/python/`.

```bash
pip install -e sdk/python   # from a checkout
```

## Client construction

```python
from memoturn import Memoturn

mt = Memoturn(
    "http://127.0.0.1:8080",     # default
    token=token,                 # per-database or namespace JWT (data plane)
    platform_key=platform_key,   # platform key (control plane)
)
```

Errors raise `MemoturnError` with the HTTP `status` attached. Mutating calls include the
response's `txid` — see [consistency](/consistency/).

## Memory API

`mt.memory(ns, profile)` returns a `MemoryProfile` — the isolated store every agent serving that
user/team/persona shares. The profile auto-creates on first ingest. See [profiles](/profiles/)
and [memories](/memories/).

```python
alice = mt.memory("acme", "alice")

# Idempotent batch ingest; one batch = one transaction = one txid.
res = alice.ingest([
    {"type": "fact", "topic_key": "user.diet", "summary": "vegetarian since 2024",
     "content": {"diet": "vegetarian"}, "keywords": "food preference",
     "embedding": embedding},
    {"type": "event", "summary": "deployed v2 to prod",
     "content": {"version": "v2"}, "session_id": "s-417"},
])

# Hybrid recall: keyword + topic + vector, rank-fused. Empty means nothing relevant.
hits = alice.recall(
    query="what can this user eat?",
    embedding=embedding,        # optional: vector channel
    topic_key="user.diet",      # optional: exact-topic channel
    types=["fact"],
    k=8,
)

memory = alice.get(hits["memories"][0]["id"])  # supersession chain included; None if gone
alice.forget(hits["memories"][0]["id"])        # hard delete
```

Embeddings are bring-your-own `list[float]` values; with node-side
[auto-embedding](/embeddings/) enabled they can be omitted. Server-side
[extraction](/extraction/) distills raw turns into typed memories (503 when the node has no
extractor configured):

```python
alice.extract([{"role": "user", "content": "I'm vegan now"}],
              session_id="s-417", dry_run=True)
```

Sessions group task memories and the transcript — see [sessions](/sessions/):

```python
sessions = alice.sessions()
alice.end_session("s-417", turns=True)   # drop task memories and the transcript

s = alice.session("s-417")               # raw transcript layer
s.append_turn("user", {"text": "hello"}, embedding=embedding)
window = s.get_window(last=20)
similar = s.search_semantic(query_embedding, k=5)
```

## Checkpoint, fork, rewind

A profile is one database, so branch operations act on the whole memory atomically — see
[branching](/branching/). Checkpoint and rewind require `admin` scope.

```python
alice.checkpoint("before-autonomous-run")
alice.rewind("before-autonomous-run")              # checkpoint name or txid

burner = alice.fork("experiment", ttl=3600)        # burner branch
burner.ingest([...])                               # isolated; expires with the branch

on_branch = alice.on_branch("experiment")          # address an existing branch
```

## Database API

`mt.db(spec)` exposes the multi-model substrate of any database (`name` or `name@branch`) — see
[data model](/data-model/).

```python
db = mt.db("acme--alice")

# Documents
notes = db.collection("notes")
notes.insert([{"kind": "fact", "text": "prefers dark mode", "score": 0.9}])
docs = notes.find({"kind": "fact", "score": {"$gt": 0.5}},
                  sort={"score": -1}, limit=10)
notes.update({"kind": "fact"}, {"$set": {"score": 1.0}}, multi=True)
notes.create_index("score")

# KV with TTL
db.kv.put("scratch", "plan", "step 1", ttl=3600)
plan = db.kv.get("scratch", "plan")                # None when absent
keys = db.kv.list("scratch", prefix="step:")

# Vectors
db.vectors.upsert("notes", id, embedding)
hits = db.vectors.search("notes", query_embedding, k=8)

# SQL escape hatch
db.sql("SELECT count(*) FROM orders WHERE status = ?", ["open"])

# Branches and durability
db.branch.create("experiment", ttl=3600)
db.branch.checkpoint("main", "before-task")
db.branch.rewind("main", "before-task")
db.sync()                                          # ship state to object storage now
```

## Control plane and tokens

Control-plane calls use `platform_key`. Namespace tokens cover every profile under a namespace
(the orchestrator posture); per-database tokens cover exactly one profile (the agent posture).
See [security](/security/).

```python
mt.create_database("agent-42")
dbs = mt.list_databases()
mt.delete_database("agent-42")

agent_token = mt.create_token("acme--alice", "write", expires_in=3600)
orch_token = mt.create_namespace_token("acme", "write")

profiles = mt.profiles("acme")                     # requires a namespace token
```

## Tests

The e2e suite is `python tests/e2e.py` and needs a running node (`cargo run -p memoturnd`). The
same surface is available over the [REST API](/api-rest/), the
[TypeScript SDK](/sdk-typescript/), and the [MCP server](/mcp/).
