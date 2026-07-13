---
title: Memory
description: Long-term agent memory — facts, hybrid recall, embeddings, context blocks, cross-agent profiles, and retention.
---

Memoturn gives agents two complementary kinds of memory:

- **Context blocks** — named sections always present in the system prompt (working memory).
- **Long-term memory** — a durable, searchable store retrieved on demand (recall).

Both are per-agent and durable; long-term memory can also be **shared across agents** via
[profiles](#cross-agent-profiles).

## Long-term memory

A memory is an atomic, content-addressed record. Four kinds:

| Kind | Use |
| --- | --- |
| `fact` | Stable knowledge about the world or the user. |
| `event` | Something that happened, with time context. |
| `instruction` | A standing preference or directive. |
| `task` | Something to be done. |

Each memory has a `topic_key` (for supersession), an `importance` (0–1), a `status`
(`active` / `superseded` / `forgotten`), and an optional embedding. Ingest is **idempotent** —
the id is a hash of normalized content — and writing a new memory with an existing `topic_key`
**supersedes** the old one, keeping the old version for history.

### Recall

`recall` is **hybrid retrieval**: it fuses up to five channels with Reciprocal Rank Fusion (RRF),
then applies per-kind weighting (facts boosted by
[`MEMOTURN_MEMORY_FACT_WEIGHT`](/configuration/#context--memory), default `1.3`):

1. **Full-text search** (FTS) over content.
2. **Topic-key** overlap.
3. **Raw message** search over conversation history.
4. **Vector** similarity (when an [embedder](#embeddings) is configured).
5. **HyDE** — embed a hypothetical answer and search with it.

Recall can optionally **synthesize** an answer from the retrieved memories using the model. It
degrades gracefully: with no embedder, it runs on FTS + topic-key + raw-message channels.

### How memories get created

- **Explicitly** — the `remember` tool, or `POST /v1/agents/{name}/memories`.
- **Automatically** — when [`MEMOTURN_MEMORY_AUTO_INGEST`](/configuration/#context--memory) is on,
  a multi-pass extractor pulls facts/events/instructions/tasks from turns as they are
  [compacted](/sessions/#compaction), with an optional verification pass to filter hallucinations.

### Tools and API

| Operation | Tool | REST |
| --- | --- | --- |
| Store | `remember` | `POST /v1/agents/{name}/memories` |
| Search | `recall` | `POST /v1/agents/{name}/memories/recall` |
| Forget | `forget` | `DELETE /v1/agents/{name}/memories/{id}` |
| List | `list_memories` | `GET /v1/agents/{name}/memories` |
| Re-embed | — | `POST /v1/agents/{name}/memories/reembed` |
| Prune history | — | `POST /v1/agents/{name}/memories/prune` |

## Context blocks

Context blocks are named, persistent sections (e.g. `MEMORY`, `SCRATCHPAD`) injected into the
system prompt every turn. The model reads and updates them with the `set_context` tool
(`replace` / `append` / `clear`), and a per-block token budget is reported back so the model can
self-manage. A `context_updated` event is emitted whenever a block changes.

## Embeddings

Vector recall is optional and provider-neutral. Set
[`MEMOTURN_MEMORY_EMBEDDER`](/configuration/#context--memory):

| Backend | Notes |
| --- | --- |
| `none` (default) | FTS-only; zero dependencies. |
| `openai` | OpenAI embeddings API. |
| `ollama` | Local embeddings via Ollama's OpenAI-compatible API. |
| `sentence_transformers` | Fully local models (`embeddings` extra). |
| `bedrock` | In-region embeddings on AWS Bedrock (data residency). |
| `vertex` | In-region embeddings on Google Vertex AI (data residency). |

Set the model with `MEMOTURN_MEMORY_EMBEDDING_MODEL`. After enabling or changing an embedder,
backfill existing rows with the `reembed` endpoint (resumable).

### Vector index

`MEMOTURN_MEMORY_VECTOR_INDEX` selects `brute_force` (default, exact, zero deps) or `sqlite_vec`
(accelerated via the `sqlite-vec` extension; falls back to brute force if unavailable). Embeddings
are stored as little-endian float32 blobs; rows whose dimension doesn't match the query are skipped.

## Cross-agent profiles

A **profile** is a shared memory pool multiple agents read and write — e.g. team knowledge or a
per-user profile spanning agents. The memory operations above all accept a `profile` argument, and
there are matching `/v1/profiles/{profile}/memories` endpoints.

Two backends ([`MEMOTURN_PROFILE_BACKEND`](/configuration/#context--memory)):

- **`sqlite`** (default) — a per-profile database with a single-writer actor. Under
  [scale-out](/scaling/), each profile is owned by one replica (consistent-hash routed); other
  replicas proxy to the owner.
- **`postgres`** — one shared Postgres + `pgvector` table. The database is the shared store, so no
  owner-routing or leases are needed. Set `MEMOTURN_PROFILE_POSTGRES_DSN` and
  `MEMOTURN_PROFILE_EMBEDDING_DIM` (match your embedder).

## Retention

By default memories are kept forever. Bound growth with:

| Setting | Effect |
| --- | --- |
| `MEMOTURN_MEMORY_MAX_ACTIVE` | Cap active memories per store; evicts the lowest-importance, least-recently-used (`0` = unlimited). |
| `MEMOTURN_MEMORY_HISTORY_RETENTION_DAYS` | Hard-delete superseded/forgotten versions older than N days (`0` = forever). |
| `MEMOTURN_MEMORY_HISTORY_MAX_PER_TOPIC` | Keep at most N superseded/forgotten versions per topic (`0` = unlimited). |

Active memories are never auto-pruned; only superseded/forgotten history is bounded.

## Related

- [Sessions & turns](/sessions/) — where auto-ingest happens (at compaction).
- [Configuration](/configuration/#context--memory) — every memory setting.
- [Scaling out](/scaling/) — how profiles are owned and routed.
