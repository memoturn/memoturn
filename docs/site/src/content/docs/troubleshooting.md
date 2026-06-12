---
title: Troubleshooting
description: The errors people actually hit — node startup refusals, auth failures, backpressure, and the AI opt-in 503s — and how to fix each.
---

A field guide to the failures you're most likely to meet, in the order you'd meet them. Error
responses carry a machine-readable `code` — the [errors reference](/errors/) lists them all.

## The node refuses to start

Startup is fail-closed by design: a misconfigured node stops with an explanation instead of
running insecurely.

**"MEMOTURN_AUTH=on requires MEMOTURN_PLATFORM_KEY to be set"** — auth without a platform key
can't mint or verify anything. Set `MEMOTURN_PLATFORM_KEY`, and give the node a signing-key
source: `MEMOTURN_AUTH_KEY` from a mounted secret (preferred for fleets — every replica must
verify the same tokens), or `MEMOTURN_PERSIST_AUTH_KEY=1` to persist a generated key to object
storage.

**"no MEMOTURN_ETCD configured but this looks like a multi-node deployment"** — the node saw
auth on or a non-loopback `MEMOTURN_ADVERTISE` and refused to rely on in-process writer leases,
which can't enforce single-writer across nodes. Set `MEMOTURN_ETCD` (e.g.
`http://etcd:2379`), or `MEMOTURN_SINGLE_NODE=1` if this genuinely is one node.

**"MEMOTURN_CLUSTER_KEY must differ from MEMOTURN_PLATFORM_KEY"** — the node-internal
credential must not be the customer-facing one. Unset it (it derives from the signing key,
fleet-consistent) or pick a different value.

**"unsupported MEMOTURN_OBJECT_STORE"** — only `file://`, `s3://`, and `mem://` URLs are
supported. For MinIO or any non-AWS S3 endpoint, use `s3://bucket` plus `AWS_ENDPOINT`,
`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, and `AWS_ALLOW_HTTP=true` for plain-HTTP
in-cluster endpoints.

## 401 vs 403

| you see | it means | fix |
| --- | --- | --- |
| 401 `unauthorized` | No credential, expired token, bad signature | Set `MEMOTURN_TOKEN` (`memoturn token create <db> --scope write`) or `MEMOTURN_PLATFORM_KEY`; `memoturn init` shows what's set |
| 403 `forbidden` | Valid credential, wrong coverage | Token is for a different database, a lower scope (read < write < admin), or was revoked by a database deletion tombstone — mint a fresh one |

Control-plane calls (`db`, `token`, namespace `policy`, `audit`) need the platform key;
data-plane calls take a per-database or namespace token. The CLI picks the right credential per
command and falls back to the other.

## 429: writes are being shed

A burst of concurrent writes to one database past `MEMOTURN_WRITE_QUEUE_DEPTH` (default 256)
sheds the excess with 429 + `Retry-After` rather than queueing unboundedly. Concurrent writes
group-commit into shared-txid rounds, so sustained load mostly clears the queue — if you see
429s steadily, you're writing faster than one writer can commit: batch your writes (memory
ingest is a batch op), or split across databases/profiles. See [scaling](/scaling/).

## 503 `unconfigured`: the AI opt-ins

Extraction (`/extract`), answer synthesis (`/ask`), and auto-embedding are **per-node opt-ins**
that live off the write path. A node without them is healthy — the endpoints just return 503
with code `unconfigured`, which means *fall back to bring-your-own*:

- `/ask` 503 → call `/recall` and synthesize the answer with your own model.
- `/extract` 503 → extract memories client-side and `/memories` ingest them.
- No embedder → ingest/recall simply skip the vector channel for items without BYO embeddings.

To opt a node in: `MEMOTURN_EXTRACT_API_KEY` (extraction), `MEMOTURN_ASSISTANT_API_KEY`
(falls back to the extract key; answer synthesis), `MEMOTURN_EMBED_PROVIDER` +
`MEMOTURN_EMBED_API_KEY` (embedding). See [extraction](/extraction/), [ask](/ask/), and
[auto-embedding](/embeddings/).

## Reads look stale

Replica reads are eventually consistent by design. Every write response carries a
`Memoturn-Txid` header — send it back as `Memoturn-Min-Txid` on the read for
read-your-writes. See [consistency](/consistency/).

## Still stuck?

`memoturn init` checks node reachability and credentials in one shot. The
[configuration reference](/configuration/) documents every env var with its default, and
`.env.example` at the repo root is a paste-ready template.
