# 06 — MCP Server & Built-in Assistant

## MCP server (agents are first-class clients)

Memoturn ships an MCP server so any agent framework (Claude, LangGraph, OpenAI Agents SDK)
connects directly. The shipped server (`mcp/src/server.ts`) speaks **stdio** for local dev and
**streamable-HTTP** for remote/production (`--http [port]` or `MEMOTURN_MCP_PORT`; endpoint
`/mcp`). HTTP sessions are stateful with caller-bound credentials: the `Authorization: Bearer`
token of the initialize request becomes the session's upstream Memoturn credential and is
pinned — every later request on that session must present the same bearer, so a session id
alone never grants another caller's scope. Without a bearer the server falls back to its env
credentials (local dev). The listener binds `127.0.0.1` by default (`MEMOTURN_MCP_HOST=0.0.0.0`
behind TLS/ingress).

**Tools** (as shipped in `mcp/src/server.ts`):

| Tool | Scope required |
| --- | --- |
| `provision_database {name}` | platform |
| `list_databases` | platform |
| `query {db, stmts}` (atomic SQL batch — the escape hatch) | db:read / db:write |
| `docs_find / docs_insert / docs_update {db, collection, ...}` | db:read / db:write |
| `kv_get / kv_put {db, ns, key, value?, ttl?}` | db:read / db:write |
| `vector_upsert / vector_search {db, collection, ...}` | db:write / db:read |
| `memory_ingest / memory_recall {namespace, profile, ...}` | ns:write / ns:read (or the profile's db token) |
| `memory_extract {namespace, profile, turns, dry_run?}` (server-side distill; 503 if the node has no extractor) | ns:write |
| `memory_ask {namespace, profile, question, k?}` (recall + answer synthesis; 503 if the node has no assistant) | ns:read |
| `memory_get {namespace, profile, id}` (one memory + supersession state) | ns:read |
| `memory_forget {namespace, profile, id}` (hard delete) | ns:write |
| `memory_sessions_list {namespace, profile}` | ns:read |
| `memory_session_end {namespace, profile, session_id, drop_turns?}` | ns:write |
| `memory_profiles_list {namespace}` | ns (namespace token) |
| `memory_append / memory_window / memory_search {db, session, ...}` (transcript layer) | db:write / db:read |
| `branch_create {db, name, from?, ttl?} / branch_checkpoint / branch_rewind` | db:admin |

**Auth:** a per-database JWT (agent locked to one profile/DB — the default posture), a
**namespace token** (every profile under one namespace — the orchestrator posture, see
[07](07-agent-memory.md)), or a platform token with scopes. Destructive tools (`rewind`,
`memory_forget`, `memory_session_end`) say so in their descriptions so hosts can gate them.

**The canonical agent loop:** orchestrator provisions `agent-{id}` per session → hands the agent
its scoped JWT → agent stores turns/memories/scratch via MCP tools → forks a burner branch before
risky operations → session ends, DB hibernates; resumes next session in <200 ms.

## The built-in assistant

The Memoturn assistant is a control-plane service (calls the Claude API) embedded in the
dashboard, the CLI (`memoturn ask`), and exposed as an MCP tool (`ask_assistant`). It is a
capability of the product, not a separate brand.

**v1 scope:**
- **NL → query**: natural language to a document filter or SQL against the user's schema; returns
  the query for confirmation before execution (never auto-executes writes).
- **Schema & index advice**: inspects collections/tables and query stats; recommends
  `createIndex` paths and schema shapes.
- **Query optimization**: `EXPLAIN QUERY PLAN`-backed advice.
- **Ops copilot**: interprets cell metrics/SLOs ("why are cold wakes slow in eu-west?").

The **memory extraction** service ([07](07-agent-memory.md), ADR-0009 fast-follow) shares this
control-plane LLM infrastructure but is a core data-path feature, documented with the memory API.

**Data access posture:** the assistant receives **schema + statistics + EXPLAIN output, never row
data by default**; row-level access only with an explicit per-conversation user grant. Runs
server-side with tenant-scoped, read-only credentials; all assistant actions are audit-logged.

**Implementation note:** prototype phase ships the design; the full assistant (NL→query, schema
advice, ops copilot) is a post-prototype build (deferred list, [plan](../../README.md)).

**Shipped (2026-06): recall answer synthesis.** The first assistant capability is live as
`POST /v1/memory/{ns}/{profile}/ask` (read scope): hybrid recall over the profile, then a
control-plane Claude call turns the recalled memories into a grounded prose answer with cited
memory ids — the synthesizer sees only what recall already returned to the caller's scope, so
the data-access posture above holds. Surfaces: CLI `memoturn ask <ns> <profile> <question…>`
and the MCP `memory_ask` tool. Enabled per node by `MEMOTURN_ASSISTANT_API_KEY` (falls back to
`MEMOTURN_EXTRACT_API_KEY`; model via `MEMOTURN_ASSISTANT_MODEL`); unconfigured nodes 503 and
clients synthesize from `/recall` themselves. Like extraction, the LLM call never enters the
write path.
