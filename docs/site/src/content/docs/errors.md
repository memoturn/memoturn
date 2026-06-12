---
title: Errors
description: The error envelope, the stable machine-readable codes, and what a client should do for each one.
---

Every error response uses one envelope:

```json
{ "error": "branch not found: staging", "code": "branch_not_found" }
```

`error` is the human-readable message; `code` is the stable machine-readable identifier your
client branches on. The set of codes is small and deliberately stable — a new one is added only
when a client can act differently on it, so it's safe to `switch` on.

Both SDKs surface the code directly: `MemoturnError.code` in
[TypeScript](/sdk-typescript/) and [Python](/sdk-python/). The CLI prints an actionable hint on
stderr keyed on the same codes.

## The codes

| code | status | meaning — and what to do |
| --- | --- | --- |
| `unauthorized` | 401 | No or invalid credential. Set `MEMOTURN_TOKEN` (mint one with `memoturn token create`) or `MEMOTURN_PLATFORM_KEY`. |
| `forbidden` | 403 | The credential is valid but doesn't cover this database, profile, or scope — check which token you're holding. |
| `not_found` | 404 | Generic lookup miss (memory id, KV key, erasure id). |
| `database_not_found` | 404 | The database doesn't exist. `memoturn db list` / `memoturn db create <name>`. |
| `branch_not_found` | 404 | The branch doesn't exist on this database. `memoturn branch list <db>`. |
| `already_exists` | 409 | Create of a database/branch that already exists. Treat as success or pick another name. |
| `conflict` | 409 | A concurrent change won (manifest CAS, rewind target, tighten-only policy violation). Re-read, then retry. |
| `invalid_request` | 400 | Malformed body, bad SQL, unsupported filter. Fix the request; don't retry as-is. |
| `payload_too_large` | 413 | Body exceeds the limit (default 32 MiB for writes). Split the batch. |
| `request_timeout` | 408 | The request exceeded `MEMOTURN_REQUEST_TIMEOUT` (default 30 s). |
| `overloaded` | 429 | Backpressure: the per-database write queue or control rate limit shed the request. Honor `Retry-After`. |
| `unconfigured` | 503 | An AI opt-in (assistant, extraction, embedding) is not configured on this node. Fall back to the bring-your-own path — e.g. use `/recall` and synthesize the answer yourself. |
| `unavailable` | 503 | The control plane (writer leases, policy store) is unreachable. Retry with backoff. |
| `internal` | 500/502 | Unexpected failure, or an error forwarding to the owner node. |

## Two envelope-less responses

408 (request timeout) and 413 (payload too large) are emitted by middleware before the handler
runs, with empty or plain-text bodies — no envelope. Both SDKs derive the code from the status
for these, so `MemoturnError.code` is still `request_timeout` / `payload_too_large`; if you're
calling the API raw, fall back to the status code.

## Backpressure: 429 and `Retry-After`

When concurrent writes to one database exceed `MEMOTURN_WRITE_QUEUE_DEPTH` (default 256), or a
control endpoint exceeds its rate budget, the node sheds the request with 429 and a
`Retry-After` header (seconds). The TypeScript SDK retries these automatically with backoff;
elsewhere, wait the indicated interval before retrying. See
[scaling](/scaling/) for how group commit absorbs write bursts before shedding starts.

The full envelope schema, including the code enum, is part of the
[OpenAPI spec](/openapi.yaml).
