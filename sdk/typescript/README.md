# @memoturn/sdk

TypeScript client for Memoturn — memory for AI agents. Zero dependencies (global `fetch`).

```ts
import { memoturn } from "@memoturn/sdk";

const mt = memoturn({ url: "https://...", token });

// One profile per user/team/persona; every agent serving them shares it.
const alice = mt.memory("acme", "alice");

await alice.ingest([
  { type: "fact", topicKey: "user.diet", summary: "vegetarian since 2024",
    content: { diet: "vegetarian" }, embedding },        // BYO embeddings in v1
]);

const { memories } = await alice.recall({ query: "what can this user eat?" });
// hybrid keyword + topic + vector recall; superseded facts hidden; empty ≠ error

// Memory you can operate on (profile = one database):
await alice.checkpoint("before-autonomous-run");
await alice.rewind("before-autonomous-run");
const burner = await alice.fork("experiment", { ttl: 3600 });

// Transcript layer + multi-model substrate:
await alice.session("s-1").appendTurn({ role: "user", content });
const db = mt.db("acme--alice");                          // docs/kv/vectors/sql/branches
```

Tokens: `mt.createNamespaceToken("acme", "write")` (orchestrator — all `acme` profiles) or
`mt.createToken("acme--alice", "write")` (agent — one profile). Both need the platform key.

Build: `npm i && npm run build`. E2E (needs a running node): `npm test`.
Full spec: [docs/architecture/07-agent-memory.md](../../docs/architecture/07-agent-memory.md).
