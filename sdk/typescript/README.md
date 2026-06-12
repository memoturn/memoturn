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

const { answer, sources } = await alice.ask("what can this user eat?");
// recall + server-side answer synthesis with cited memory ids
// (node opt-in: MEMOTURN_ASSISTANT_API_KEY; 503 when unconfigured)

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

## Runtime & errors

Works on any runtime with WHATWG `fetch` (Node ≥ 18, browsers, workers); pass
`fetch` in `memoturn({ fetch })` to polyfill older runtimes. Failures throw
`MemoturnError` with `.status` and a stable `.code`
(`branch_not_found`, `unconfigured`, `overloaded`, …) to branch on —
e.g. `unconfigured` means the node has no assistant/extractor and you should
fall back to the bring-your-own path.

Transient failures retry automatically: network errors, 502/503/504, and 429
(honoring `Retry-After`), with exponential backoff. Plain 500 and other 4xx
never retry. `memoturn({ retries: 0 })` disables this; note a network error
can fire after the request was sent, so a non-idempotent call may double-send
under retry (memory ingest is idempotent by design).

Build: `npm i && npm run build`. Tests: `npm run test:unit` (no node needed);
`npm test` adds the e2e suite — start a node first (`make node` at the repo
root, or `cargo run -p memoturnd`).
Full spec: [docs/architecture/07-agent-memory.md](../../docs/architecture/07-agent-memory.md).
