---
title: WebSocket API
description: The streaming chat protocol — connecting, sending messages, and the server event stream.
---

Real-time chat with an agent runs over a WebSocket. It's the protocol the
[console](/quickstart/), the bundled [CLI](/cli/), and the minimal `/ui` client all speak.

## Connecting

```
GET /v1/agents/{name}/ws
```

Authenticate with an `Authorization: Bearer <token>` / `x-api-key` header, or — since browsers
can't set WebSocket headers — a `?token=<key>` query parameter. The `CHAT` permission is required.
An optional `?tenant=` only applies to a `superadmin`.

```
wss://host/v1/agents/demo/ws?token=YOUR_KEY
```

## Client → server

| Event | Fields | Purpose |
| --- | --- | --- |
| `message` | `content`, `session_id?`, `parent_id?`, `if_busy?` | Send a user message. Omit `session_id` to start/continue the current session; set it to target a specific session; `parent_id` forks from a message. `if_busy` picks the [double-texting strategy](/guardrails/#cancellation--double-texting) (`enqueue`/`reject`/`interrupt`/`rollback`) when a turn is already running. |
| `resume` | `interrupt_id`, `approve?`, `note?`, `payload?` | Resolve a [pending approval](/guardrails/#human-in-the-loop-approvals): approve, deny with a note, or approve with a `payload` that replaces the tool's input. The continuation streams on this socket. |
| `cancel` | — | Cancel the in-flight turn (persisted progress is kept). |

```json
{ "type": "message", "content": "summarize today's incidents", "session_id": "sess_..." }
```

## Server → client

A turn streams as a sequence of events. Every event carries `seq`, the agent's monotonic stream
position (see [stream resumption](#stream-resumption)).

| Event | Fields | Meaning |
| --- | --- | --- |
| `turn_started` | `turn_id`, `session_id` | The turn began. |
| `text_delta` | `text` | An incremental chunk of the assistant's reply. |
| `tool_call` | `id`, `name`, `input` | The agent invoked a [tool](/tools/). |
| `tool_result` | `id`, `name`, `output`, `is_error` | The tool returned. |
| `context_updated` | `name`, `used_tokens`, `budget_tokens` | A [context block](/memory/#context-blocks) changed. |
| `interrupt` | `interrupt_id`, `turn_id`, `session_id`, `tool_name`, `tool_input`, `reason` | The turn paused for [human approval](/guardrails/#human-in-the-loop-approvals); resolve with a `resume` event. |
| `turn_completed` | `turn_id`, `stop_reason`, `usage` | The turn finished. `stop_reason` includes `end_turn`, `max_steps`, and `interrupted`. `usage` carries `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_write_tokens`. |
| `error` | `message`, `code` | An error (e.g. `bad_request`, `rate_limited`, `busy`, `cancelled`, `not_found`, `misdirected`, `internal_error`). |

Typical order: `turn_started` → (`text_delta` … | `tool_call` → `tool_result`)\* → `turn_completed`.

## Stream resumption

Turns run detached from the socket: if the connection drops mid-turn, **the turn keeps running**.
Track the highest `seq` you've received and reconnect with it —

```
wss://host/v1/agents/demo/ws?last_event_id=42
```

— and the runtime replays every event after that position (within the journal window,
[`MEMOTURN_EVENT_JOURNAL_SIZE`](/configuration/), default 1024 events), then follows live.
Connecting *without* sending anything joins the agent's stream — useful for observing background,
cron, or REST-resumed turns. The console and `/ui` clients reconnect this way automatically.

## Minimal client

```js
const ws = new WebSocket(`wss://host/v1/agents/demo/ws?token=${KEY}`);
ws.onmessage = (e) => {
  const ev = JSON.parse(e.data);
  if (ev.type === "text_delta") process.stdout.write(ev.text);
  if (ev.type === "turn_completed") console.log("\n[done]", ev.stop_reason);
};
ws.onopen = () => ws.send(JSON.stringify({ type: "message", content: "hello" }));
```

## Scale-out

Under [scale-out](/scaling/), a non-owning replica transparently bridges the socket to the owner.
If it can't (loop guard tripped, or no owner), it emits an `error` event and closes with code
`1013` (try again later).

## Related

- [Sessions & turns](/sessions/) — the turn lifecycle behind these events.
- [CLI](/cli/) — a reference client. · [REST API](/api-rest/) — everything non-streaming.
