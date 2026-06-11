# ADR-0009: Typed agent memory — profiles as databases, hybrid recall

**Status:** accepted · 2026-06

**Decision:** agent memory becomes the headline product surface, structured as
`namespace > profile > memory` with **strict profile isolation** — no read or write ever crosses a
profile boundary. "Memory shared across all of a user's agents" means many agents are *clients of
the same profile*, never cross-database queries.

1. **Profile = one Memoturn database**, named by convention `{ns}--{profile}` (namespace and
   profile each `[a-z0-9][a-z0-9_-]*`, `--` forbidden inside either). No registry schema change:
   every existing subsystem (leases, manifests, tokens, routes) keys off the single db name, and
   the convention upgrades to a catalog column later with a one-time split on `--`. A profile
   inherits everything databases already have — branching, checkpoints, rewind, burner branches.
2. **Typed memories** in a reserved table (`__memoturn_memories`), not a user docs collection:
   `fact | event | instruction | task`. Facts and instructions carry an optional `topic_key` and
   **supersede** prior active memories with the same `(type, topic_key)` — history is preserved
   (`superseded_by`/`superseded_at`), never destroyed. Events accumulate. Tasks are session-scoped
   and expire via TTL (KV pattern); they skip the vector channel.
3. **Idempotent ingest** via content-addressed IDs: `mem_` + truncated SHA-256 over
   `(type, topic_key, canonical content)`. Re-ingesting the same memory is a no-op reported as
   `duplicate`.
4. **Hybrid recall**, entirely inside the profile database: FTS5 keyword search (BM25) + exact
   `topic_key` lookup + vector ANN over memory embeddings, merged with reciprocal-rank fusion
   (topic hits weighted highest). Returns ranked memories with channel attribution; no LLM
   synthesis in the data plane.
5. **Extraction is client-supplied (BYO)** in v1, mirroring BYO embeddings: clients POST
   already-typed memories. Raw conversation turns (`__memoturn_messages`) remain the verbatim
   transcript layer alongside.
6. **Namespace tokens**: the per-database JWT gains an optional `ns` claim; a namespace token
   authorizes every profile under its namespace. Isolation stays structural (separate database
   files) — tokens widen *authorization*, never the data plane.

**Rejected:** *shared org-level memory database* — breaks single-writer scaling and the
branch-as-a-unit thesis; profile-per-database gives sharing where it matters (all agents of one
user) with zero cross-DB machinery. *Memories as a docs collection* — supersession, dedup, and
hybrid recall need server-enforced semantics, not conventions users can violate via SQL.
*Server-side extraction in the data plane* — pulls LLM credentials/cost/latency into the write
path; belongs in the control-plane assistant service as a fast-follow.

**Control-plane scope (not data-plane fixes):** profile auto-create on first ingest has two
limitations that belong in the control plane, not the handler — (a) a still-valid write token
resurrects a deleted profile (stateless JWTs survive delete; needs revocation or a tombstone),
and (b) a concurrent first-ingest on two nodes mints divergent uuids under the per-node prototype
registry (split-brain; needs a CAS create through the shared catalog, the way leases CAS through
etcd). Single-node deployments are unaffected; the data plane reserves the `{ns}--` delimiter and
anchors namespace-token authority so neither becomes an isolation bug.

**Deferred (named):** whole-database TTL for ephemeral profiles; namespace as a real catalog
column. (Recall answer synthesis has since shipped — opt-in `/ask` endpoint, same control-plane
posture as extraction: recall first, then the LLM grounds a prose answer in the recalled
memories only; see docs/architecture/06. Raw-turn recall shipped as `include_turns` — a separate `turns`
array, not fused. Server-side extraction shipped as an opt-in `/extract` endpoint: the LLM call
runs out of the write path and feeds the ordinary ingest, honoring the rejection above; BYO
remains the default. Auto-embedding shipped the same way: opt-in per node, best-effort — a
provider failure degrades recall to keyword+topic and never fails a write.)
