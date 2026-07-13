---
title: Sessions & turns
description: The conversation model — sessions, the turn loop, streaming events, and non-destructive compaction.
---

A **session** is a persistent conversation thread inside an agent. Messages form a tree (each has a
`parent_id`); the active path is linear. Sessions, messages, and summaries are stored in the
agent's SQLite database, so a conversation survives crashes and hibernation.

## Turns

A **turn** is one user message and the agent's full response to it — including any tool calls and
intermediate model steps. Turns are executed by the **turn loop** under the agent's single-writer
lock, so only one runs at a time per agent.

### The turn loop

1. **Resolve the session** (explicit id, the current session, or a new one) and append the user
   message.
2. **Auto-compact** if the active thread exceeds the token threshold (see below).
3. **Auto-recall** — when [`MEMOTURN_MEMORY_AUTO_RECALL`](/configuration/#context--memory) is on,
   query [long-term memory](/memory/) and inject results into the system prompt.
4. **Model ↔ tool loop** (up to `max_steps`):
   - Stream the model response, emitting `text_delta` events.
   - Persist the assistant message; if it requested tools, execute them and persist results.
   - Repeat until the model stops calling tools.
5. **Complete** — emit `turn_completed` with a stop reason and token usage.

Each step persists to SQLite **before** the next model call, so a crash mid-turn leaves a
consistent, replayable history.

### Streaming events

The turn loop streams [WebSocket events](/api-websocket/): `turn_started`, `text_delta`,
`tool_call`, `tool_result`, `context_updated`, and `turn_completed` (or `error`). This is the same
protocol the [console](/quickstart/) chat and the bundled [CLI](/cli/) consume.

## Sessions API

| Operation | How |
| --- | --- |
| List sessions | `GET /v1/agents/{name}/sessions` |
| Read messages | `GET /v1/agents/{name}/sessions/{id}/messages` |
| Fork a session | `POST /v1/agents/{name}/sessions/{id}/fork` |
| Continue a session | pass `session_id` on the WebSocket `message` event |

See the [REST API](/api-rest/) and [WebSocket API](/api-websocket/) for full details.

### Forking

`fork_session` branches a new session from an existing one, copying history up to an optional
`up_to_seq`. The new session records its `parent_session_id`, so you can explore alternate
continuations without mutating the original thread.

## Compaction

Long threads are kept within the model's context window by **non-destructive compaction**. When the
active thread exceeds [`MEMOTURN_COMPACTION_THRESHOLD_TOKENS`](/configuration/#context--memory)
(default `12000`):

- The oldest complete turns (keeping the most recent
  `MEMOTURN_COMPACTION_KEEP_RECENT_TURNS`, default `4`) are summarized.
- Those messages are marked `compacted` — **not deleted**. They remain queryable by full-text
  search, and the summary is injected at the front of the thread on the next load.
- If [memory auto-ingest](/memory/) is on, durable memories are extracted from the compacted slice
  before it leaves the active window.

Set `MEMOTURN_COMPACTION_THRESHOLD_TOKENS=0` to disable compaction.

## Related

- [Memory](/memory/) — what gets extracted from compacted turns, and how recall works.
- [Agents & actors](/agents/) — where sessions live and how turns are serialized.
- [Guardrails & approvals](/guardrails/) — middleware, human approvals, cancellation, double-texting.
- [WebSocket API](/api-websocket/) — the full streaming event reference, including stream resumption.
