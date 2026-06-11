# Memoturn

**Memory for AI agents.** Memoturn gives every user, team, or agent persona an isolated **memory
profile** that all of their agents share: typed memories (facts, events, instructions, tasks) with
supersession — newer facts replace older ones on the same topic, history preserved — idempotent
ingest, and hybrid recall (keyword + topic + vector, rank-fused). Profiles are organized as
`namespace > profile > memory`, and no data ever crosses a profile boundary.

Underneath, each profile is its own tiny database — instantly provisioned, near-zero cost when
idle, holding every shape of agent state (memories, documents, KV, vectors, conversation
transcripts, SQL) in a single unit that replicates, branches, and rewinds together. **Memory you
can checkpoint, fork, and rewind**: snapshot an agent's mind before a risky run, rewind if it
learned garbage, burner-branch a session and discard it.

> Status: **architecture + working prototype.** All planned prototype milestones are built and
> tested (67 integration tests incl. the memory layer, request-surface hardening regressions,
> and true multi-node distribution — ownership, forwarding, failover, fencing — against a real
> etcd). See [docs/architecture](docs/architecture/00-overview.md).

## Agent memory in 30 seconds

```bash
# every agent serving acme's user "alice" shares one profile
memoturn memory ingest acme alice --type fact --topic user.diet \
  --summary "vegetarian since 2024" --keywords "food preference"

memoturn memory recall acme alice "what can this user eat?"
# → ranked memories with channel attribution; superseded facts hidden

memoturn token create-ns acme --scope write     # one token, every acme profile
```

Same surface over HTTP (`/v1/memory/{ns}/{profile}/...`), MCP tools
(`memory_ingest` / `memory_recall` / `memory_forget`), and SDKs. Extraction and embeddings are
bring-your-own by default; opt in per node to **server-side extraction**
(`MEMOTURN_EXTRACT_API_KEY` → `POST .../extract` distills raw transcripts into typed memories)
and **auto-embedding** (`MEMOTURN_EMBED_API_KEY` → bare-text ingest and recall get the vector
channel automatically; `MEMOTURN_EMBED_PROVIDER` = `voyage` or `openai`, the latter reaching any
OpenAI-compatible server including a local one) — both run outside the write path.
Full spec: [docs/architecture/07-agent-memory.md](docs/architecture/07-agent-memory.md).

## Measured (prototype, single node, in-process object store)

| metric | target | p50 |
| --- | --- | --- |
| memory ingest (typed fact, 256-dim embedding, supersession) | <10 ms | **3.9 ms** |
| hybrid recall over 10k memories (FTS5 + topic + ANN, rank-fused) | <25 ms | **11.7 ms** |
| provision database | <100 ms | **17 µs** |
| hot KV read / SQL write / doc insert | <1 ms / <5 ms / <5 ms | **3 µs / 16 µs / 15 µs** |
| segment ship (write + WAL capture + PUT) | <10 ms | **61 µs** |
| branch create (copy-on-write) | <50 ms | **47 µs** |
| cold wake (restore + open + query) | <200 ms | **0.7 ms** (+object-store RTT in prod) |
| 10k databases provisioned | — | **93 ms** (107k/s), hot pool flat |

Reproduce: `cargo run --release -p memoturn-bench` · demo: `scripts/demo.sh`

**Proven on Kubernetes** ([docs/deployment-proof.md](docs/deployment-proof.md)): Helm chart
(secure by default: non-root, read-only rootfs, NetworkPolicy; refuses multi-replica without
etcd) on kind with MinIO + auth — all HTTP benchmarks pass (provision 1.61 ms, segment ship to
MinIO 6.54 ms p50), and the chaos test holds: `kubectl delete pod` on the data plane → fresh pod with
no PersistentVolume serves the same data with the same token in ~15 s.

## Why agents need a different database

| Agent requirement | Memoturn answer |
| --- | --- |
| Memory shared across all of a user's agents | One profile per user/team/persona; agents are clients of the same profile — isolation is structural (`namespace > profile > memory`) |
| Memory that evolves without losing history | Typed memories with **supersession** by topic key; idempotent content-addressed ingest; hard-delete only on explicit forget |
| Relevant recall, not keyword grep | Hybrid recall: FTS + topic lookup + vector ANN, reciprocal-rank fused, channel-attributed — and empty when nothing matches |
| State per agent/session, not per app | DB-per-profile: provisioning is a metadata write (~ms), idle DBs hibernate to object storage at near-zero cost |
| JSON-native, schema evolves constantly | Document-first API (Mongo-style collections on JSONB) with SQL escape hatch |
| Scratchpads, caches, flags | First-class KV namespaces with TTL and edge-cached reads |
| Safe experimentation | O(1) copy-on-write **burner branches**: checkpoint/fork/rewind an agent's whole memory |
| Tool-native access | First-class MCP server; agents ingest and recall memory as tools |
| Built-in expertise | Embedded AI assistant (NL→query, schema advice, ops copilot) |
| Production operation | Fail-closed auth (Ed25519 JWTs + platform key), deleting a profile revokes its stale write tokens, SQL guard walls off reserved tables, request limits on body/concurrency/control rate, opt-in `durable` write mode |

## Architecture in one paragraph

A Rust data-plane node (`memoturnd`) embeds libSQL and hosts millions of tiny databases in three
temperature tiers (hot/warm/cold). **Object storage is the source of truth** — nodes are
disposable. Committed transactions are shipped as immutable page segments to object storage and
streamed to read replicas; branches are O(1) manifest operations with epoch fencing; a writer
lease per database (etcd) gives single-writer SQL semantics with ≤15 s failover. Writes ack on
local commit by default and ship asynchronously; `MEMOTURN_DURABILITY=durable` (or a per-request
`Memoturn-Durability: durable` header) acks only after the segment is shipped and the manifest
CAS lands. Unreferenced objects are reclaimed by a refcount GC that is safe under copy-on-write
forks. The whole stack deploys with one Helm chart — hardened by default (non-root, read-only
rootfs, NetworkPolicy egress lockdown) — to any Kubernetes (EKS/GKE/AKS/self-hosted).

Full design: [docs/architecture](docs/architecture/00-overview.md) · decisions: [docs/adr](docs/adr).

## Repository layout

```
crates/            Rust workspace: engine, replication, docstore, kv, control, api, memoturnd, cli
mcp/               MCP server (TypeScript)
sdk/typescript/    @memoturn/sdk — TypeScript client (memory + substrate)
sdk/python/        memoturn — Python client (httpx)
deploy/helm/       Helm umbrella chart (kind-deployable)
bench/             Benchmark harness (success-criteria table)
examples/           memory-agent — the product loop as a runnable chat agent
docs/site          docs.memoturn.ai (Astro Starlight; publishes only docs/site/src/content/docs)
docs/architecture  The architecture document set (internal, not published)
docs/adr           Architecture decision records (internal, not published)
```

## AI owns the code; people bring expertise

In the old days, circa 2014, we used to say that developers should not tag themselves as
authors of code in order to encourage team ownership. Now AI owns the code. This code base is
designed to be maintained by AI under human guidance, and we want the LLM to have as much
context as possible. To aid this:

- All artifacts live in the code base — including the architecture docs, ADRs, and deployment
  proofs written for humans ([docs/](docs/)), and the published documentation site
  (docs.memoturn.ai builds from [docs/site](docs/site)). [CLAUDE.md](CLAUDE.md) is the
  AI-facing guide.
- Individuals are not the owners of sections of code. There are no CODEOWNERS, no author
  tags, no per-file attribution — and there should never be.

## Development

```bash
cargo build                # build the workspace
cargo test                 # unit + integration tests (67 cross-crate)
cargo run -p memoturnd     # single node on :8080 (data ./data, objects ./data/objects)
cargo run -p memoturn-cli -- memory ingest acme alice --summary "..."   # memory/db/branch/sql/kv/sync
scripts/demo.sh            # the agent-story walkthrough against a running node
cd mcp && npm i && npm run build   # MCP server: node dist/index.js (stdio) or --http 8765 (streamable HTTP)
cd docs/site && npm i && npm run dev   # docs.memoturn.ai locally (deploy: npm run deploy)
helm lint deploy/helm/memoturn     # kind-deployable chart (memoturnd + MinIO)

# auth (off by default in dev): per-database Ed25519 JWTs + platform key.
# Fail-closed: MEMOTURN_AUTH=on requires MEMOTURN_PLATFORM_KEY and a signing-key
# source (MEMOTURN_AUTH_KEY from a secret, or MEMOTURN_PERSIST_AUTH_KEY=1).
# MEMOTURN_AUTH=on MEMOTURN_PLATFORM_KEY=... memoturnd
# memoturn --platform-key ... token create agent-1 --scope write
# memoturn --token <jwt> kv put agent-1 scratch plan "..."

# multi-node: point nodes at etcd + shared object storage. Without MEMOTURN_ETCD
# a node that looks multi-node refuses to start unless MEMOTURN_SINGLE_NODE=1.
# docker run -d -p 2379:2379 quay.io/coreos/etcd:v3.5.21 etcd \
#   --listen-client-urls http://0.0.0.0:2379 --advertise-client-urls http://0.0.0.0:2379
# MEMOTURN_ETCD=http://127.0.0.1:2379 MEMOTURN_OBJECT_STORE=s3://bucket ... memoturnd
# real-etcd integration tests are gated on the same endpoint:
# ETCD_ENDPOINTS=http://127.0.0.1:2379 cargo test -p memoturn-api --test distribution_etcd
```

## Names

**Memoturn** — the database and company (memory × conversation turns).
**Burner branches** — ephemeral copy-on-write forks that auto-expire.
