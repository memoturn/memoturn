---
title: MCP server
description: A first-class MCP server that exposes memory, documents, KV, vectors, SQL, and branching as tools for any agent framework.
---

Memoturn ships an MCP server (TypeScript, in `mcp/`) so that any MCP-capable agent framework
connects directly — agents ingest and recall memory as tools, with no SDK integration. The
prototype server uses the stdio transport for local development; the v1 design also specifies
a streamable-HTTP transport for production and a `schema_inspect` tool.

## Tools

### Typed agent memory

| Tool | Purpose | Scope |
| --- | --- | --- |
| `memory_ingest {namespace, profile, memories}` | Store typed memories — idempotent batch; `fact`/`instruction` supersede older entries sharing `topic_key` | ns:write or the profile's db token |
| `memory_recall {namespace, profile, query?, embedding?, topic_key?, types?, k?, include_superseded?, include_turns?}` | Hybrid recall: keyword + topic + vector channels, rank-fused; empty result means nothing relevant | ns:read or the profile's db token |
| `memory_extract {namespace, profile, turns, session_id?, dry_run?}` | Distill raw turns into typed memories with the node's server-side extractor, then ingest; errors with 503 when the node has no extractor (see [Server-side extraction](/extraction/)) | ns:write |
| `memory_forget {namespace, profile, id}` | Permanently delete one memory (hard delete; supersession preserves history without it) | ns:write |
| `memory_get {namespace, profile, id}` | Fetch one memory by id with its supersession state; reports not-found rather than erroring | ns:read or the profile's db token |
| `memory_profiles_list {namespace}` | List the profiles under a namespace — each is one isolated store | namespace token |

### Sessions

| Tool | Purpose | Scope |
| --- | --- | --- |
| `memory_sessions_list {namespace, profile, limit?}` | List recent sessions, most recent first | ns:read |
| `memory_session_end {namespace, profile, session_id, drop_turns?}` | End a session: its task memories expire immediately, durable memories survive; `drop_turns` also deletes the verbatim transcript | ns:write |

### Transcript layer

| Tool | Purpose | Scope |
| --- | --- | --- |
| `memory_append {db, session, role, content, embedding?}` | Append a verbatim conversation turn to a session | db:write |
| `memory_window {db, session, last?}` | Fetch the last N turns in order | db:read |
| `memory_search {db, session, vector, k?}` | Semantic search over a session's embedded turns | db:read |

### Substrate: documents, KV, vectors, SQL

| Tool | Purpose | Scope |
| --- | --- | --- |
| `query {db, stmts}` | SQL statements as an atomic batch — the escape hatch | db:read / db:write |
| `docs_insert / docs_find / docs_update {db, collection, ...}` | JSON documents with document-style filters and update operators | db:read / db:write |
| `kv_put / kv_get {db, ns, key, value?, ttl?}` | Scratchpads, flags, caches; optional TTL | db:read / db:write |
| `vector_upsert / vector_search {db, collection, ...}` | ANN-indexed embeddings outside the memory layer | db:read / db:write |

### Control and branching

| Tool | Purpose | Scope |
| --- | --- | --- |
| `provision_database {name}` | Create a database — instant, metadata-only | platform |
| `list_databases` | List databases on the node | platform |
| `branch_create {db, name, from?, ttl?}` | Copy-on-write fork; `ttl` makes it a burner branch | db:admin |
| `branch_checkpoint {db, branch, name}` | Tag the current state with a name | db:admin |
| `branch_rewind {db, branch, to}` | Rewind to a checkpoint — destructive for state after it | db:admin |

`db` accepts a spec of `name` or `name@branch` (`@main` implicit). Every tool result carries
the `txid` of the operation. Destructive tools — `branch_rewind`, `memory_forget`,
`memory_session_end`, `provision_database` — are the ones an MCP host should gate behind
confirmation.

## Auth postures

The server forwards one of three credentials to the node, depending on who the agent is:

- **Per-database JWT** — the agent posture, and the default. The agent is locked to exactly
  one profile or database; it cannot name any other.
- **Namespace token** — the orchestrator posture. One token covers every profile under a
  namespace (for example, all of `acme`), including the control routes of those profiles'
  databases — mint per-profile tokens, checkpoint memories. Tokens widen authorization only;
  no data-plane operation touches two profiles.
- **Platform token with scopes** — control-plane operations such as `provision_database` and
  `list_databases`.

Scopes follow the API: recall and reads need `read`, ingest and forget need `write`, branch
operations need `admin`. See [Security](/security/) for token minting.

## The canonical agent loop

Per turn: call `memory_recall` at turn start to load what the profile already knows, act, then
call `memory_ingest` at turn end with anything worth keeping (and `memory_append` for the
verbatim turn, so nothing is lost between extractions). When a session wraps, `memory_session_end`
expires its task memories.

Per session, the orchestrator pattern from the architecture: provision a database per
session, hand the agent its scoped JWT, let the agent store turns, memories, and scratch state
via the tools above, fork a burner branch before risky operations, and let the database
hibernate when the session ends. It resumes on the next session without explicit restore.

## Running the server

The server speaks stdio and targets a running node:

```bash
cd mcp && npm i && npm run build
node dist/index.js
```

Configuration is by environment variable:

| Variable | Purpose |
| --- | --- |
| `MEMOTURN_URL` | Node or gateway base URL (default `http://127.0.0.1:8080`) |
| `MEMOTURN_TOKEN` | Per-database or namespace JWT for data-plane tools |
| `MEMOTURN_PLATFORM_KEY` | Platform credential for `provision_database` / `list_databases` |

A typical MCP client registration:

```json
{
  "mcpServers": {
    "memoturn": {
      "command": "node",
      "args": ["/path/to/db/mcp/dist/index.js"],
      "env": {
        "MEMOTURN_URL": "http://127.0.0.1:8080",
        "MEMOTURN_TOKEN": "<jwt>"
      }
    }
  }
}
```

## The built-in assistant

The design also includes a built-in assistant — natural language to query, schema and index
advice, query optimization, ops copilot — as a control-plane service surfaced in the CLI
(`memoturn ask`) and as an MCP tool. It receives schema, statistics, and query plans, never
row data by default. It ships post-prototype; `memoturn ask` is currently a stub. See the
[roadmap](/roadmap/).

## Related pages

- [Memories](/memories/) — the typed record behind `memory_ingest`.
- [Recall](/recall/) — channel fusion behind `memory_recall`.
- [Branching](/branching/) — semantics of `branch_create`, checkpoint, and rewind.
- [API reference](/api-rest/) — the HTTP routes each tool wraps.
