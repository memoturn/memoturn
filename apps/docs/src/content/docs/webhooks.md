---
title: Webhooks
description: Signed POSTs when a run completes or pauses for approval — drive downstream systems without polling.
---

Webhooks notify external systems about run lifecycle events. Every entry point emits them
uniformly — WebSocket, REST, [MCP](/mcp/), [A2A](/a2a/), subagents, and
[scheduled turns](/fibers/#scheduled-turns-cron) — and delivery is asynchronous with bounded
retries, so a slow receiver never blocks a turn.

## Events

| Event | Fires when | Payload (plus `event`, `timestamp`) |
| --- | --- | --- |
| `turn_completed` | Any turn finishes | `tenant`, `agent`, `turn_id`, `stop_reason`, `usage` |
| `interrupt` | A turn pauses for [human approval](/guardrails/#human-in-the-loop-approvals) | `tenant`, `agent`, `interrupt_id`, `turn_id`, `session_id`, `tool_name`, `reason` |

The `interrupt` event is how "approval needed" reaches Slack, a pager, or a ticketing system —
the payload carries the `interrupt_id` to resolve via the
[interrupts API](/guardrails/#human-in-the-loop-approvals).

## Configuration

```bash
MEMOTURN_WEBHOOKS='[{"url":"https://hooks.example.com/memoturn","secret":"whsec_...","events":["turn_completed","interrupt"]}]'
```

Each receiver takes `url`, an optional `secret`, optional extra `headers`, and an `events`
filter (default: `turn_completed` only). Delivery knobs:
[`MEMOTURN_WEBHOOK_MAX_ATTEMPTS`](/configuration/) (default 3, exponential backoff; only 5xx and
network errors retry — 4xx never does), `MEMOTURN_WEBHOOK_TIMEOUT_SECONDS` (default 10).

## Verifying signatures

With a `secret` configured, every delivery carries:

```
X-Memoturn-Event: turn_completed
X-Memoturn-Signature: sha256=<hex HMAC-SHA256 of the raw body>
```

Verify by recomputing the HMAC over the exact request body with your secret and comparing
constant-time. Reject anything unsigned or mismatched.

## Dead letters

Events that exhaust the retry budget land in a bounded dead-letter queue (a small SQLite under
`data_dir`; oldest evicted beyond `MEMOTURN_WEBHOOK_DLQ_MAX_ENTRIES`, default 1000) instead of
being dropped. 4xx rejections are *not* dead-lettered — they're receiver contract errors that a
replay wouldn't fix.

| Operation | How |
| --- | --- |
| Inspect | `GET /v1/admin/webhooks/dead-letters` (admins see their tenant's; superadmin all) |
| Replay | `POST /v1/admin/webhooks/dead-letters/{id}/replay` — removed on success; signature recomputed from the current secret, so rotation applies |
| Discard | `DELETE /v1/admin/webhooks/dead-letters/{id}` |

Disable with `MEMOTURN_WEBHOOK_DLQ_ENABLED=false`. Under [scale-out](/scaling/) the queue is
replica-local, like delivery itself.

## Transport rules

Webhook URLs are operator-trusted, startup-fixed configuration. HTTPS is enforced for
non-loopback receivers; `MEMOTURN_WEBHOOK_ALLOW_HTTP=true` overrides for development only.

## Related

- [Guardrails & approvals](/guardrails/) — the interrupt flow these notify about.
- [Observability](/observability/) — traces and metrics for everything else.
