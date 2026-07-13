---
title: REST API
description: Health, agents, sessions, fibers, and memory endpoints — methods, paths, permissions, and payloads.
---

The control plane is a FastAPI app. Every `/v1` route is [authenticated](/security/), authorized by
RBAC, and scoped to the caller's tenant. An interactive OpenAPI schema is served at
`/openapi.json`.

## Authentication

Present credentials as `Authorization: Bearer <token>` or `x-api-key: <key>` (see
[Security](/security/)). The optional `?tenant=` query parameter only takes effect for a
`superadmin`; everyone else operates in their own tenant.

## Health & info

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| `GET` | `/health` | none | Liveness — `{"status":"ok"}`. |
| `GET` | `/` | none | Server info — name, version, model, auth mode, live agent count. |
| `GET` | `/ui` | none | Minimal built-in chat client. |
| `GET` | `/console` | none | Admin [console](/quickstart/) (when bundled). |

## Agents & sessions

| Method | Path | Permission | Description |
| --- | --- | --- | --- |
| `GET` | `/v1/agents` | `READ_SESSIONS` | List agents in the tenant. |
| `GET` | `/v1/agents/{name}/sessions` | `READ_SESSIONS` | List an agent's sessions. |
| `GET` | `/v1/agents/{name}/sessions/{id}/messages` | `READ_SESSIONS` | Messages in a session (newest `limit`, default 200; page older with `before_seq` from `next_before_seq`). |
| `POST` | `/v1/agents/{name}/sessions/{id}/fork` | `MANAGE_SESSIONS` | Fork a session. |

Fork body: `{ "up_to_seq": null, "title": null }` → `{ "session_id", "forked_from" }`.

## Rewind & branch (turn time travel)

Every turn versions the agent's state; these endpoints move through that history.

| Method | Path | Permission | Description |
| --- | --- | --- | --- |
| `POST` | `/v1/agents/{name}/rewind` | `ADMIN` | Rewind the agent to a past turn, discarding later state (**destructive**). |
| `POST` | `/v1/agents/{name}/branch` | `ADMIN` | Fork the agent into a new agent, optionally rewound to a past turn (divergent copy). |
| `GET` | `/v1/agents/{name}/workspace/as-of/{turn_seq}` | `READ_SESSIONS` | The [workspace](/workspace/) file listing as it stood at a past turn (needs workspace versioning). |

Rewind body: `{ "turn_seq": 42 }`. Branch body: `{ "new_name": "...", "at_turn": null }` —
`409` if `new_name` already exists. The read-only memory counterpart is
[`memories/as-of`](#memory) below.

## Interrupts (human-in-the-loop)

Turns paused awaiting approval or input — see [Guardrails](/guardrails/).

| Method | Path | Permission | Description |
| --- | --- | --- | --- |
| `GET` | `/v1/agents/{name}/interrupts` | `READ_SESSIONS` | Pending interrupts. Members see only their own turns'; admins see the tenant's. |
| `POST` | `/v1/agents/{name}/interrupts/{id}/resume` | `CHAT` | Resolve an interrupt and run the paused turn to completion (non-streaming). |

Resume body: `{ "approve": true, "note": "", "payload": null }` — only the subject whose turn
raised the interrupt (or an admin) may resolve it. WebSocket clients should send a `resume` event
instead to stream the continuation.

## Fibers

| Method | Path | Permission | Description |
| --- | --- | --- | --- |
| `GET` | `/v1/agents/{name}/fibers` | `READ_FIBERS` | List [fibers](/fibers/). |
| `POST` | `/v1/agents/{name}/fibers` | `MANAGE_FIBERS` | Start a registered fiber. |
| `DELETE` | `/v1/agents/{name}/fibers/{id}` | `MANAGE_FIBERS` | Cancel a scheduled/suspended fiber — also how a cron chain is stopped. |
| `POST` | `/v1/agents/{name}/crons` | `MANAGE_FIBERS` | Schedule a prompt to run as recurring agent turns. |

Start body: `{ "name": "...", "input": {...}, "delay_seconds": 0 }`. A fiber summary returns
`id`, `name`, `status`, `result`, `error`, `attempts`, `wake_at`.

Cron body: `{ "prompt": "...", "interval_seconds": 0, "session": "fresh", "on_run_completed":
"keep", "title": "cron", "delay_seconds": 0 }` — `interval_seconds: 0` runs once; `session` is
`"fresh"` (new session per run) or `"shared"` (all runs append to one session). Returns the fiber
summary; `DELETE` the fiber to stop the chain. See [Fibers](/fibers/).

## Memory

See [Memory](/memory/).

| Method | Path | Permission | Description |
| --- | --- | --- | --- |
| `GET` | `/v1/agents/{name}/memories` | `READ_MEMORIES` | List memories (`?kind=`, `?limit=` 1–200, default 50). |
| `POST` | `/v1/agents/{name}/memories` | `MANAGE_MEMORIES` | Store a memory. |
| `POST` | `/v1/agents/{name}/memories/recall` | `READ_MEMORIES` | Hybrid recall. |
| `DELETE` | `/v1/agents/{name}/memories/{id}` | `MANAGE_MEMORIES` | Forget a memory. |
| `POST` | `/v1/agents/{name}/memories/reembed` | `MANAGE_MEMORIES` | Backfill embeddings. |
| `POST` | `/v1/agents/{name}/memories/prune` | `MANAGE_MEMORIES` | Prune history per retention policy. |
| `GET` | `/v1/agents/{name}/memories/as-of/{turn_seq}` | `READ_MEMORIES` | Memory as it stood at a past turn (`?kind=`, `?limit=` 1–500, default 200). |

Store body: `{ "content": "...", "kind": "fact", "topic_key": null, "importance": 0.5 }`.
Recall body: `{ "query": "...", "limit": 8 }`.

## Profiles (cross-agent memory)

The same memory operations on a shared [profile](/memory/#cross-agent-profiles), under
`/v1/profiles/{profile}/memories…` — list, store, `recall`, delete, `reembed`, `prune`, with the
same permissions.

## Chat

Chat is a WebSocket, not REST: `GET /v1/agents/{name}/ws` (permission `CHAT`). See the
[WebSocket API](/api-websocket/).

## Admin: webhook dead letters

Available when the [webhook](/webhooks/) dead-letter queue is enabled (otherwise `404`). Admins
see their tenant's letters; a superadmin sees all.

| Method | Path | Permission | Description |
| --- | --- | --- | --- |
| `GET` | `/v1/admin/webhooks/dead-letters` | `ADMIN` | Undeliverable webhook events (`?limit=` 1–500, default 100). |
| `POST` | `/v1/admin/webhooks/dead-letters/{id}/replay` | `ADMIN` | Re-deliver one dead letter; removed on success. |
| `DELETE` | `/v1/admin/webhooks/dead-letters/{id}` | `ADMIN` | Discard a dead letter. |

## MCP & A2A

When enabled, agents are also reachable under `/mcp/{agent}` ([MCP](/mcp/)) and `/a2a/{agent}`
([A2A](/a2a/)) — same auth, RBAC, rate limits, and owner-routing.

## Scale-out responses

Under [scale-out](/scaling/), a non-owning replica usually proxies transparently. If it cannot, it
returns **`421`** (`{ "misdirected": true, "owner", "owner_address" }`); a momentary lease
contention returns **`503`** with `Retry-After: 1`.

## Related

- [WebSocket API](/api-websocket/) · [Security](/security/) · [Configuration](/configuration/)
