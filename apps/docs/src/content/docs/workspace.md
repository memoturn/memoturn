---
title: Workspace
description: The durable per-agent virtual filesystem — inline + blob storage, materialization for shell/sandbox, and encryption at rest.
---

Every agent has a **workspace**: a durable virtual filesystem that is the agent's working memory on
disk. It is the foundation of the [execution ladder](/execution-ladder/) — useful at Tier 0 with
nothing but a filesystem and chat.

## Storage model

File **metadata** lives in the agent's SQLite database (`workspace_files`); file **contents** are
stored one of two ways:

- **Inline** — files at or below
  [`MEMOTURN_WORKSPACE_INLINE_MAX_BYTES`](/configuration/#sandbox--execution) (default `65536`,
  i.e. 64 KB) are stored directly in SQLite.
- **Blob** — larger files go to a **blob store**, keyed by a generated id, with the key recorded in
  metadata.

Paths are normalized (e.g. `/notes/todo.txt`); there is no path traversal.

### Blob stores

| Backend | When | Notes |
| --- | --- | --- |
| **Local** | default | Files under the data directory; zero dependencies. |
| **S3 / MinIO** | `MEMOTURN_S3_ENDPOINT` set | Any S3-compatible object store; the `storage` extra. |
| **Encrypted** | `MEMOTURN_BLOB_ENCRYPTION_KEY` set | Wraps either backend; encrypts blob contents at rest. |

## Operations

Agents read and write the workspace through [built-in tools](/tools/) — `write_file`, `read_file`,
`list_files` — and sandboxed code can access it through granted [capabilities](/sandboxing/)
(`workspace.read`, `workspace.write`, `workspace.list`, `workspace.delete`, `workspace.exists`).

## Materialization

For the shell and code tiers, the workspace is **materialized** to a real temporary directory
before a command runs, then changes are **imported back** (detected by content hash) when it
finishes. This lets full-OS tools — `git`, compilers, test runners — operate on real files while
the durable source of truth stays in the workspace. See [sandboxing](/sandboxing/).

## Durability

The workspace is part of the agent's SQLite database, so it is snapshotted and restored with the
agent on [hibernation and rehydration](/agents/#lifecycle). Blob contents persist in the blob store
independently and are addressed by the metadata.

## Related

- [Execution ladder](/execution-ladder/) — how the workspace underpins Tiers 0–4.
- [Sandboxing](/sandboxing/) — granting workspace access to sandboxed code.
- [Tools](/tools/) — the file tools agents call.
