# CLAUDE.md

Memoturn is a distributed agent-memory database. The headline surface is typed agent memory —
`namespace > profile > memory`, profile = one database, supersession + hybrid recall (see
docs/architecture/07-agent-memory.md) — on a substrate of Rust data plane embedding libSQL,
object storage as source of truth, document-first multi-model API (docs/KV/SQL/vector/memory),
O(1) manifest branching, etcd writer leases, Helm/K8s multi-cloud deployment. There is one brand:
**Memoturn** (the built-in assistant is unbranded). Ephemeral branches are marketed as
**burner branches**.

**AI owns the code; people bring expertise.** This code base is designed to be maintained by
AI under human guidance — keep all artifacts (including human-facing docs) in the repo, and
never add author tags, CODEOWNERS, or per-file attribution.

## Commands

```bash
cargo build                            # build workspace
cargo test                             # all tests
cargo test -p memoturn-engine         # one crate
cargo test -p memoturn-docstore <name> # single test by name substring
cargo run -p memoturnd                # run node locally (HTTP on :8080, data under ./data)
cargo run -p memoturn-cli -- memory ingest acme alice --summary "..."  # CLI: memory/db/branch/sql/kv/sync/token
cargo run --release -p memoturn-bench # reproduce the README performance numbers
helm lint deploy/helm/memoturn        # chart lint
scripts/demo.sh                       # end-to-end demo against a local node
```

The Makefile at the repo root wraps the common tasks: `make node|test|bench|demo|demos` (see
`make help`). Run `make check` (fmt + clippy -D warnings + tests) before finishing any change;
`make up|down` runs the local multi-node compose cluster; `make release-check` guards the
lockstep version policy (docs/development.md). The docs site (docs.memoturn.ai) lives in `docs/site` — Astro Starlight, deployed
as Cloudflare Workers static assets (`cd docs/site && npm run dev|build|deploy`). Only
`docs/site/src/content/docs/` is published; `docs/architecture/` and `docs/adr/` are internal
design docs. After changing product surfaces (env vars, CLI, API, MCP, SDKs, Helm), run
`/sync-docs` to update the published pages. The memoturn.ai marketing site lives in the separate
private `memoturn/web` repository.

`memoturnd` is configured entirely via `MEMOTURN_*` env vars (see `crates/memoturnd/src/main.rs`):
`MEMOTURN_OBJECT_STORE` (s3:// URL; defaults to local-FS store), `MEMOTURN_ETCD` (real leases vs
in-process), `MEMOTURN_AUTH`, `MEMOTURN_DATA_DIR`/`MEMOTURN_LISTEN`. Server-side extraction
(`MEMOTURN_EXTRACT_API_KEY`), recall answer synthesis (`MEMOTURN_ASSISTANT_API_KEY`, falls back
to the extract key; `MEMOTURN_ASSISTANT_MODEL`) and auto-embedding (`MEMOTURN_EMBED_PROVIDER` =
`voyage`|`openai`, `MEMOTURN_EMBED_API_KEY`, `MEMOTURN_EMBED_BASE_URL` for OpenAI-compatible/local
servers) are per-node opt-ins that must stay outside the write path.

Production posture is fail-closed: `MEMOTURN_AUTH=on` requires `MEMOTURN_PLATFORM_KEY` (and a
key source — `MEMOTURN_AUTH_KEY` from a mounted secret, or `MEMOTURN_PERSIST_AUTH_KEY=1` to
persist a generated key to object storage). The node-internal `MEMOTURN_CLUSTER_KEY` must differ
from the platform key; if unset it is derived from the signing key (fleet-consistent). Without
`MEMOTURN_ETCD` the node refuses to start when it looks multi-node (auth on or a non-loopback
`MEMOTURN_ADVERTISE`) unless `MEMOTURN_SINGLE_NODE=1`. Request-surface and durability knobs:
`MEMOTURN_REQUEST_TIMEOUT` (s, 30), `MEMOTURN_MAX_BODY_BYTES` (32 MiB), `MEMOTURN_MAX_CONCURRENCY`
(1024), `MEMOTURN_CONTROL_RATE` (control-endpoint req/s, 10), `MEMOTURN_WRITE_QUEUE_DEPTH`
(per-database write-queue cap, 256 — writes past it are shed with 429 + Retry-After; concurrent
writes to one DB group-commit into shared-txid rounds), `MEMOTURN_DURABILITY` (`durable`
ships+CAS before acking the txid; per-request `Memoturn-Durability: durable` header escalates),
`MEMOTURN_GC_GRACE_SECS` (refcount object GC grace window, 600), `MEMOTURN_PITR_RETENTION_SECS`
(fine-grained PITR window, 86400; 0 disables) and `MEMOTURN_PITR_SNAPSHOT_RETENTION_SECS`
(snapshot-grained tier, 2592000). Data governance (ADR-0010): per-namespace policies (retention/
TTL caps, AI egress rules, audit; tighten-only profile overrides) live in object storage and are
read through a cache (`MEMOTURN_POLICY_CACHE_SECS`, 30); `MEMOTURN_EMBED_SELF_HOSTED_HOSTS`
allowlists embedder hosts for the `embed: self_hosted_only` rule; per-namespace audit streams
(JSONL in object storage, `MEMOTURN_AUDIT_FLUSH_MS` flush window, 2000) record mutations and AI
egress metadata when `audit.enabled`; verifiable erasure (`POST .../erasures`) hard-forgets with
secure_delete, rewrites object-storage history below the forget txid after `erasure.grace_secs`,
and proves it with a signed Ed25519 receipt; `memoturn policy get|set|clear`,
`memoturn audit export`, and `memoturn memory erase|erasures` on the CLI.

## Architecture

Authoritative design lives in `docs/architecture/` (00-overview through 08-data-governance; 06 is
mcp-and-assistant) and
`docs/adr/`. Read those before changing core semantics. Key invariants:

- **Object storage is the source of truth**; local disk is cache. Nodes must stay disposable —
  never make correctness depend on local state surviving a pod restart.
- **Single writer per database**, enforced by lease + epoch fencing. Every segment/manifest write
  carries an epoch; manifest updates are CAS. Zombie writers must be harmless, not just unlikely.
- **Every read response carries `txid`**; replicas serve eventually-consistent reads, clients use
  `min_txid` for read-your-writes.
- Reserved table names are prefixed `__memoturn_` (KV: `__memoturn_kv`; docs:
  `__memoturn_docs_{collection}`; agent memory: `__memoturn_memories*`). User SQL must not be
  able to mutate reserved tables directly.
- The engine is accessed only through the `SqlEngine` trait (crates/engine) — keep libSQL types
  out of other crates so the engine can be swapped for the Turso rewrite later.

## Crate map

- `crates/engine` — `SqlEngine` trait, libSQL adapter, handle pool, hot/warm/cold tiering
- `crates/replication` — snapshot/segment shipping (`object_store`), branch manifests, restore
- `crates/docstore` — Mongo-style filter subset → SQL-over-JSONB compiler, indexes; typed agent
  memory (`memories.rs`: ingest/supersession/hybrid recall)
- `crates/kv` — `__memoturn_kv` fast path, TTL, read cache
- `crates/control` — leases, placement, write forwarding (M4)
- `crates/governance` — per-namespace policy model + object-storage policy store (ADR-0010)
- `crates/strata` — the ground-up object-native typed engine (ADR-0011, docs/architecture/09);
  runs behind the experimental `MEMOTURN_STRATA_NAMESPACES` flag (`*` or a namespace list:
  selected `{ns}--{profile}` databases serve memory/KV/docs/transcripts/branching/erasure from
  strata, with sweeps + background flushing on the node tick; `/sql` + vector collections
  reject there). Bench smoke: `cargo test -p memoturn-strata --release -- --ignored bench_`.
  Keep the flag out of the published docs until the deferred gaps in 09 close.
- `crates/api` — axum HTTP/JSON server, auth, txid plumbing
- `crates/memoturnd` — node binary; `crates/cli` — `memoturn` CLI; `crates/bench` — perf harness
- `mcp/` — MCP server (TypeScript; stdio + streamable HTTP via `--http`/`MEMOTURN_MCP_PORT`,
  tests: `npm test`); `sdk/typescript/` — `@memoturn/sdk` (e2e: `npm test`);
  `sdk/python/` — `memoturn` (e2e: `python tests/e2e.py`) — both need a running node
- `examples/` — runnable use-case demos that double as e2e checks (`make demos` runs them all,
  spawning a temp node if none is up): `memory-agent` (the product loop as a chat agent, scriptable
  via `agent.py ... < script.txt`), `support-agent`, `multi-agent`, `what-if`, `governance`;
  `deploy/helm/` — umbrella chart (kind-deployable, see docs/deployment-proof.md)

## Conventions

- Rust 2021, `cargo fmt` defaults; errors via `thiserror` in libraries, `anyhow` at binary edges.
- Tests colocated `#[cfg(test)]` for units; cross-crate flows in `crates/*/tests/`.
- Never name competitors in docs (reference designs in ADRs are fine).
