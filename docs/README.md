# docs/

Three kinds of documentation live here. **Only `site/src/content/docs/` is published**
(docs.memoturn.ai); everything else is internal design material.

- [`development.md`](development.md) — working on this repo: toolchain, `make check`, e2e
  suites, the `/sync-docs` rule, versioning policy.
- [`deployment-proof.md`](deployment-proof.md) — the Helm chart proven on kind (MinIO, auth,
  chaos pod-kill).
- [`api/openapi.yaml`](api/openapi.yaml) — the OpenAPI spec (published to
  docs.memoturn.ai/openapi.yaml at docs build; drift-guarded by
  `cargo test -p memoturn-api openapi`).

## architecture/ — the design, numbered

| | |
| --- | --- |
| [00-overview](architecture/00-overview.md) | Vision, hybrid design, system diagram |
| [01-storage-engine](architecture/01-storage-engine.md) | Temperature tiers; object storage as source of truth |
| [02-branching](architecture/02-branching.md) | O(1) CoW manifests, epoch fencing |
| [03-control-plane](architecture/03-control-plane.md) | Leases, placement, write forwarding |
| [04-data-model-and-api](architecture/04-data-model-and-api.md) | Document-first multi-model API |
| [05-deployment](architecture/05-deployment.md) | Helm/K8s, multi-cloud |
| [06-mcp-and-assistant](architecture/06-mcp-and-assistant.md) | MCP server; the unbranded assistant |
| [07-agent-memory](architecture/07-agent-memory.md) | **The headline surface**: typed memory, supersession, hybrid recall |
| [08-data-governance](architecture/08-data-governance.md) | Policies, audit, verifiable erasure |

## adr/ — decisions

| | |
| --- | --- |
| [0001](adr/0001-libsql-as-library.md) | Embed libSQL as a library (not sqld, not the Turso rewrite) |
| [0002](adr/0002-rust-data-plane.md) | Rust for the data plane |
| [0003](adr/0003-ltx-segment-replication.md) | LTX-format segment log per database; object storage as source of truth |
| [0004](adr/0004-manifest-cow-branching.md) | Branching = manifest chains over the segment store |
| [0005](adr/0005-etcd-leases-postgres-catalog.md) | etcd for writer leases; Postgres for the catalog |
| [0006](adr/0006-documents-on-jsonb.md) | Document-first API on SQLite JSONB |
| [0007](adr/0007-libsql-native-vectors.md) | libSQL native vectors (F32_BLOB + DiskANN) |
| [0008](adr/0008-deployment-not-statefulset.md) | Data plane as Deployment with ephemeral NVMe; cells per region |
| [0009](adr/0009-typed-agent-memory.md) | Typed agent memory — profiles as databases, hybrid recall |
| [0010](adr/0010-data-governance.md) | Per-namespace data-governance policies in object storage |

Read the relevant architecture doc before changing core semantics — CLAUDE.md lists the
invariants that must hold.
