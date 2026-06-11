# 07 — Agent Memory

The headline product surface ([ADR-0009](../adr/0009-typed-agent-memory.md)): durable, typed,
searchable memory that every agent serving a user shares — without any cross-database machinery.
Documents, KV, SQL, and vectors ([04](04-data-model-and-api.md)) are the substrate this is built
on; this layer adds the semantics agents actually need: typed memories, supersession,
idempotent ingest, and hybrid recall.

## Hierarchy & isolation

```
namespace                e.g. an application, environment, or tenant
  └── profile            one memory store: a user, a team, an org, an agent persona
        └── memory       a typed record (fact / event / instruction / task)
```

- **A profile is one Memoturn database**, named `{ns}--{profile}`. Strict isolation is therefore
  *structural*: recall on `acme--alice` can never surface `acme--bob`'s memories, because they are
  different database files with different manifests and leases.
- "Memory across all agents" = every agent acting for Alice reads and writes `acme--alice`.
  Concurrency is already solved: single writer *node* per database, write forwarding from every
  other node, `txid`/`min_txid` for read-your-writes. Per-agent attribution rides the `source`
  field: agents won't reliably self-report, so the surfaces apply it ambiently — the MCP server
  defaults it from `MEMOTURN_SOURCE` (each coding agent's MCP config sets its own), and the SDKs
  take a client-level `source` used as the ingest default.
- The flip side of structural isolation: a profile's *write* throughput is one node's single
  writer ([01](01-storage-engine.md#per-database-write-ceiling)). Per-user profiles never
  notice; a high-fan-in shared profile (hundreds of agents ingesting into one team memory
  concurrently) eventually will. Prefer modeling heavy independent writers as separate
  profiles; the mitigation ladder in 01 covers the rest.
- **Sessions** are optional groupings scoped to a profile (different profiles may reuse session
  IDs). Task memories attach to sessions and expire; sessions also index the raw transcript layer.
- Profiles are auto-created on first ingest (metadata-only, instant). Recall against a profile
  that doesn't exist returns an empty result — reads never mutate the catalog.

## Memory record

| Field | Notes |
| --- | --- |
| `id` | content-addressed: `mem_` + SHA-256(`type`, `topic_key`, canonical `content`) truncated — re-ingest is an idempotent no-op (`duplicate`) |
| `type` | `fact` · `event` · `instruction` · `task` |
| `topic_key` | optional; the supersession key for facts/instructions (`"user.dietary-preference"`) |
| `summary` | one-line natural-language gist; FTS-indexed |
| `content` | JSONB payload (the full memory) |
| `keywords` | optional space-separated terms; FTS-indexed alongside `summary` |
| `embedding` | optional, bring-your-own by default; powers the vector channel. With **auto-embedding** enabled (`MEMOTURN_EMBED_API_KEY`), the node embeds `summary + keywords` at ingest and bare `query` strings at recall — best-effort: a provider failure degrades to keyword+topic, never failing the write. Provider is `MEMOTURN_EMBED_PROVIDER` (`voyage` default, `voyage-3.5`; or `openai`, `text-embedding-3-small`); `openai` + `MEMOTURN_EMBED_BASE_URL` reaches any OpenAI-compatible server (Ollama, vLLM, …) for a self-hosted, zero-egress embedder |
| `session_id` | optional grouping; required semantics only for tasks |
| `source` | optional provenance: which agent wrote this (`"claude-code"`, `"cursor"`, …). Free-form, returned everywhere a memory is serialized, filterable at recall. Provenance, not identity — excluded from the content-addressed id, so the same memory from two agents dedupes and the first writer's attribution sticks (`duplicate`/`revived` never overwrite it); supersession likewise stays profile-wide regardless of source, because cross-agent sharing is the point |
| `superseded_by` / `superseded_at` | set when a newer memory replaces this one; history preserved |
| `expires_at` | tasks only (default 24 h TTL) |

### Type semantics

| Type | Supersession | Embeddings | Lifetime |
| --- | --- | --- | --- |
| `fact` | by `(type, topic_key)` — newer replaces older, old row kept | yes | durable |
| `instruction` | same as fact | yes | durable |
| `event` | never — events accumulate | yes | durable |
| `task` | never | skipped | TTL (session-scoped) |

Supersession is a state machine, not a delete: ingesting a fact with an existing active
`topic_key` marks the previous row `superseded_by = <new id>` in the same transaction. Recall
filters superseded rows by default; `include_superseded: true` (or fetching a memory by id)
exposes the full chain. `DELETE` (forget) is the only hard removal. By default history is kept
indefinitely; a namespace governance policy can cap superseded-history age/count, event age,
and task TTLs ([08](08-data-governance.md), ADR-0010).

## Ingest

`POST /v1/memory/{ns}/{profile}/memories` with a batch:

```json
{ "memories": [
  { "type": "fact", "topic_key": "user.editor-theme", "summary": "prefers dark mode",
    "content": {"preference": "dark"}, "keywords": "theme ui", "embedding": [/* f32… */] },
  { "type": "event", "summary": "deployed v2 to prod",
    "content": {"version": "v2"}, "session_id": "s-417" },
  { "type": "task", "summary": "follow up on refund #88", "content": {}, "ttl": 86400 }
] }
```

→ `201 { "results": [{"id", "status": "created"|"revived"|"duplicate", "superseded": [ids]}], "txid" }`.
`revived` means the exact memory existed but was superseded and is now active again (re-asserting
an old fact reinstates it); `duplicate` is reserved for re-ingesting an already-active memory.

One batch = one transaction = one `txid`, so batches cap at 1000 memories (an unbounded batch
would be an unbounded lock hold — chunk larger loads); extraction (deciding *what* is memorable)
is the client's job by default — the same BYO posture as embeddings. Raw turns still flow through the
transcript API (`/v1/db/{db}/memory/{session}/turns`) verbatim, so nothing is lost between
extractions.

### Server-side extraction (optional)

`POST /v1/memory/{ns}/{profile}/extract` with `{ "turns": [{role, content}], "session_id"?,
"source"?, "dry_run"? }` distills a transcript into typed memories with a control-plane LLM call, then feeds
the proposals through the ordinary idempotent ingest (same supersession, same `duplicate`
reporting; `dry_run` returns proposals without writing). The LLM call happens **before** any
database write — credentials, cost, and latency never enter the write path — and the call is
structured-output-constrained, so the model can only produce schema-valid typed memories. Nodes
opt in via `MEMOTURN_EXTRACT_API_KEY` (+ optional `MEMOTURN_EXTRACT_MODEL`); unconfigured nodes
return 503 and extraction stays BYO.

## Recall

`POST /v1/memory/{ns}/{profile}/recall`:

```json
{ "query": "what theme does the user like?", "embedding": [/* f32… */],
  "topic_key": "user.editor-theme", "types": ["fact"], "k": 8 }
```

At least one of `query` / `embedding` / `topic_key`. Optional filters: `types`, `session_id`,
`source` (only memories one agent ingested), `include_superseded`. Filters are pushed into each
channel's SQL — not just post-applied — so wanted rows aren't starved out of the candidate
window by higher-ranked rows that the filter would discard. Three channels run inside the
profile DB:

| Channel | Mechanism | RRF weight |
| --- | --- | --- |
| topic | exact `topic_key` lookup over active memories | 2.0 |
| keyword | FTS5 (BM25) over `summary` + `keywords` | 1.0 |
| vector | DiskANN over memory embeddings ([ADR-0007](../adr/0007-libsql-native-vectors.md)) | 1.0 |

Results merge by **reciprocal-rank fusion** (`score = Σ w/(60 + rank)`), drop superseded/expired
rows, tiebreak on recency, truncate to `k` (clamped to 1000, like every client-requested result
count — [04](04-data-model-and-api.md#guardrails-on-the-open-surface)). Each hit reports which
channels found it. Empty is a valid answer — recall never pads.

**Raw-turn channel:** `include_turns: true` (requires `embedding`) additionally searches the
verbatim transcript (`__memoturn_messages`, brute-force cosine, optionally session-scoped) and
returns matching turns in a separate `turns` array — turns aren't memories, so they are reported
alongside the fused ranking, not mixed into it.

## API surface

```
POST   /v1/memory/{ns}/{profile}/memories          ingest batch (idempotent; auto-creates profile)
POST   /v1/memory/{ns}/{profile}/recall            hybrid query
POST   /v1/memory/{ns}/{profile}/extract           LLM distill → ingest (503 if unconfigured)
GET    /v1/memory/{ns}/{profile}/memories/{id}     one memory + supersession chain
DELETE /v1/memory/{ns}/{profile}/memories/{id}     forget (hard delete)
GET    /v1/memory/{ns}/{profile}/sessions          list sessions
DELETE /v1/memory/{ns}/{profile}/sessions/{sid}    end session: delete its task memories (?turns=true to drop transcript too)
GET    /v1/memory/{ns}                             list profiles in namespace
```

All routes ride the standard plumbing: lease-routed writes with epoch fencing, write forwarding,
`Memoturn-Txid` on every response, `Memoturn-Branch` header to address a branch.

## Auth: namespace tokens

Per-database JWTs ([03](03-control-plane.md)) gain an optional `ns` claim:

- **Namespace token** (`ns: "acme"`): every profile under `acme`, including `/v1/db/acme--…`
  control routes — the orchestrator posture (mint per-profile tokens, checkpoint memories).
- **Per-database token** (`db: "acme--alice"`): exactly one profile — the agent posture.
- Scopes unchanged: recall/get = `read`; ingest/forget/session-end = `write`.

Tokens widen *authorization* only; there is no data-plane operation that touches two profiles.

## Branching = memory you can operate on

Because a profile is a database, [02-branching](02-branching.md) applies verbatim to memory:

- **Checkpoint an agent's mind** before a risky autonomous run; rewind if it learned garbage.
- **Burner-branch a session**: fork the profile, let an experiment ingest freely, discard.
- **Fork a persona**: O(1) copy of a profile's entire memory as a starting point for a new agent.

## Storage (reserved tables, inside the profile DB)

`__memoturn_memories` (rows + supersession columns), `__memoturn_memories_fts` (FTS5
external-content index), `__memoturn_memories_vec` (F32_BLOB + DiskANN, created lazily at the
client's embedding dimension), `__memoturn_memory_sessions`. All carry the reserved prefix —
unreachable from user SQL — and all replicate, fork, and rewind with the database as one unit.

Schema evolution is **migrate-on-write, stateless**: the `source` column was added after launch,
so a pre-`source` database migrates via failed-batch retry — the first ingest's atomic batch
rolls back at the unknown column, an `ALTER TABLE ADD COLUMN` runs, the batch retries once.
Reads never migrate: recall and get retry a column-less SELECT (serializing `source` as null),
and a source-filtered channel on an un-migrated DB is correctly empty. Statelessness is load-
bearing — branch rewind can resurrect the old schema at any time, so migration keys off the
SQLite error, never off cached state; replicas inherit the migration as physical pages.
