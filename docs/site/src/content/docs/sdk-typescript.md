---
title: TypeScript SDK
description: "@memoturn/sdk — zero-dependency TypeScript client for typed agent memory and the multi-model substrate."
---

`@memoturn/sdk` is the TypeScript client for Memoturn. Zero dependencies — it uses the global
`fetch` (Node 18+, browsers, workers). Source:
[github.com/memoturn/memoturn](https://github.com/memoturn/memoturn), `sdk/typescript/`.

```bash
npm install @memoturn/sdk
```

## Client construction

```ts
import { memoturn } from "@memoturn/sdk";

const mt = memoturn({
  url: "http://127.0.0.1:8080", // default
  token,                        // per-database or namespace JWT (data plane)
  platformKey,                  // platform key (control plane)
});
```

Errors throw `MemoturnError` with the HTTP `status` attached. Mutating calls return the
response's `txid` — see [consistency](/consistency/).

## Memory API

`mt.memory(ns, profile)` returns a `MemoryProfile` — the isolated store every agent serving that
user/team/persona shares. The profile auto-creates on first ingest. See [profiles](/profiles/)
and [memories](/memories/).

```ts
const alice = mt.memory("acme", "alice");

// Idempotent batch ingest; one batch = one transaction = one txid.
const { results, txid } = await alice.ingest([
  { type: "fact", topicKey: "user.diet", summary: "vegetarian since 2024",
    content: { diet: "vegetarian" }, keywords: "food preference", embedding },
  { type: "event", summary: "deployed v2 to prod", content: { version: "v2" },
    sessionId: "s-417" },
]);

// Hybrid recall: keyword + topic + vector, rank-fused. Empty means nothing relevant.
const { memories } = await alice.recall({
  query: "what can this user eat?",
  embedding,                 // optional: vector channel
  topicKey: "user.diet",     // optional: exact-topic channel
  types: ["fact"],
  k: 8,
});

const memory = await alice.get(memories[0].id); // includes the supersession chain; null if gone
await alice.forget(memories[0].id);             // hard delete
```

Embeddings are bring-your-own `number[]` values; with node-side
[auto-embedding](/embeddings/) enabled they can be omitted. Server-side
[extraction](/extraction/) distills raw turns into typed memories (503 when the node has no
extractor configured):

```ts
const { proposed } = await alice.extract(
  [{ role: "user", content: "I'm vegan now" }],
  { sessionId: "s-417", dryRun: true },
);
```

Sessions group task memories and the transcript — see [sessions](/sessions/):

```ts
const sessions = await alice.sessions();
await alice.endSession("s-417", { turns: true }); // drop task memories and the transcript

const s = alice.session("s-417");                 // raw transcript layer
await s.appendTurn({ role: "user", content: { text: "hello" }, embedding });
const window = await s.getWindow({ last: 20 });
const similar = await s.searchSemantic(queryEmbedding, { k: 5 });
```

## Checkpoint, fork, rewind

A profile is one database, so branch operations act on the whole memory atomically — see
[branching](/branching/). Checkpoint and rewind require `admin` scope.

```ts
await alice.checkpoint("before-autonomous-run");
await alice.rewind("before-autonomous-run");      // checkpoint name or txid

const burner = await alice.fork("experiment", { ttl: 3600 }); // burner branch
await burner.ingest([...]);                        // isolated; expires with the branch

const onBranch = alice.onBranch("experiment");     // address an existing branch
```

## Database API

`mt.db(spec)` exposes the multi-model substrate of any database (`name` or `name@branch`) — see
[data model](/data-model/).

```ts
const db = mt.db("acme--alice");

// Documents
const notes = db.collection("notes");
await notes.insert([{ kind: "fact", text: "prefers dark mode", score: 0.9 }]);
const docs = await notes.find({ kind: "fact", score: { $gt: 0.5 } },
                              { sort: { score: -1 }, limit: 10 });
await notes.update({ kind: "fact" }, { $set: { score: 1.0 } }, { multi: true });
await notes.createIndex("score");

// KV with TTL
await db.kv.put("scratch", "plan", "step 1", { ttl: 3600 });
const plan = await db.kv.get("scratch", "plan");          // null when absent
const keys = await db.kv.list("scratch", { prefix: "step:" });

// Vectors
await db.vectors.upsert("notes", id, embedding);
const hits = await db.vectors.search("notes", queryEmbedding, { k: 8 });

// SQL escape hatch
const { results } = await db.sql("SELECT count(*) FROM orders WHERE status = ?", ["open"]);

// Branches and durability
await db.branch.create("experiment", { ttl: 3600 });
await db.branch.checkpoint("main", "before-task");
await db.branch.rewind("main", "before-task");
await db.sync();                                  // ship state to object storage now
```

## Control plane and tokens

Control-plane calls use `platformKey`. Namespace tokens cover every profile under a namespace
(the orchestrator posture); per-database tokens cover exactly one profile (the agent posture).
See [security](/security/).

```ts
await mt.databases.create("agent-42");
const dbs = await mt.databases.list();
await mt.databases.delete("agent-42");

const agentToken = await mt.createToken("acme--alice", "write", { expiresIn: 3600 });
const orchToken  = await mt.createNamespaceToken("acme", "write");

const profiles = await mt.profiles("acme");       // requires a namespace token
```

## Tests

`npm i && npm run build` builds the package; `npm test` runs the e2e suite and needs a running
node (`cargo run -p memoturnd`). The same surface is available over the
[REST API](/api-rest/), the [Python SDK](/sdk-python/), and the [MCP server](/mcp/).
