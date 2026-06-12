# Working on this repo

This codebase is maintained by AI under human guidance (see CLAUDE.md) — there is no
contributor-process boilerplate, no author tags, no CODEOWNERS. This page is the practical
loop: what to install, what to run, and the two rules that keep the repo honest.

## Toolchain

- **Rust** — pinned by `rust-toolchain.toml` (rustup picks it up automatically; rustfmt and
  clippy included). MSRV is declared as `rust-version` in the workspace manifest.
- **Node 22** — MCP server, TypeScript SDK, docs site.
- **Python ≥ 3.9** — Python SDK and examples. `make venv` creates `examples/.venv` with the
  demo dependencies.
- **Docker** (optional) — `make up` runs the local multi-node cluster (etcd + MinIO + two
  memoturnd nodes).

Env configuration is `MEMOTURN_*` vars only; `.env.example` at the repo root documents every
one with its default.

## The loop

```bash
make check     # before pushing: fmt --check + clippy -D warnings + workspace tests
make node      # a local node on :8080
make demo      # curl walkthrough against it
make demos     # all examples/ as an e2e suite (spawns a temp node if none is up)
make e2e       # MCP + TS SDK + examples (TS SDK needs a node: `make node` first)
make up/down   # multi-node compose cluster on :8080/:8081
```

CI (`.github/workflows/ci.yml`) runs the same checks: rust (fmt/clippy/test), e2e against a
shared node (TS SDK, Python SDK, examples), MCP tests + docs build, helm lint.

## The two rules

1. **After changing a product surface** (env vars, CLI, HTTP API, MCP tools, SDKs, Helm), run
   `/sync-docs` — it maps changed surfaces to the published docs pages and the OpenAPI spec.
   The spec has its own drift guard: `cargo test -p memoturn-api openapi` fails if the router
   and `docs/api/openapi.yaml` disagree.
2. **Before changing core semantics**, read the relevant `docs/architecture/` chapter and the
   invariants in CLAUDE.md (object storage as source of truth, single writer + epoch fencing,
   txid on every read, reserved `__memoturn_` tables, engine access only via `SqlEngine`).

## Versioning & release

All surfaces version in lockstep at 0.x: the workspace crates (one `workspace.package.version`),
`sdk/typescript/package.json`, `sdk/python/pyproject.toml`, `mcp/package.json`, and the Helm
chart `version`/`appVersion`. A release is one commit that bumps all of them + a `v0.x.y` tag,
with notes in `CHANGELOG.md` (Keep a Changelog format — move `Unreleased` down).

`make release-check` greps the five version sources and fails if they disagree. Publish
automation (crates.io / npm / PyPI) is deliberately deferred until there's something to publish.
