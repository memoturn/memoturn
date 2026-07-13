---
title: Guardrails & approvals
description: Turn middleware, human-in-the-loop approvals, cancellation, and double-texting — deterministic control around every model and tool call.
---

Production agents need policies that hold on every turn, no matter how it was started — WebSocket
chat, REST, [MCP](/mcp/), [A2A](/a2a/), a [subagent](/tools/), or a [scheduled run](/fibers/#scheduled-turns-cron).
Memoturn enforces them in the runtime: a **middleware chain** wraps every model call and every
tool call inside the [turn loop](/sessions/#the-turn-loop), and **interrupts** let a turn pause
for a human decision without holding any process open.

## Turn middleware

A middleware implements any of four hooks; the chain runs them deterministically on each step
(first middleware = outermost):

| Hook | Wraps | Typical use |
| --- | --- | --- |
| `before_model` | The outbound model request | Rewrite messages (redaction), adjust the system prompt |
| `wrap_model_call` | The streaming model call | Retries, model fallback |
| `wrap_tool_call` | One tool execution | Call limits, approval gates |
| `after_model` | The assembled step response | Inspection, custom accounting |

Built-ins are switched on by configuration:

| Middleware | Setting | Behavior |
| --- | --- | --- |
| Model retry | `MEMOTURN_MODEL_RETRY_ATTEMPTS` | Retries a model call that fails before any output has streamed (exponential backoff). Mid-stream failures are never retried — clients would see duplicated text. |
| Model fallback | `MEMOTURN_MODEL_FALLBACK` | Falls back to a secondary model (same provider backend) after the primary's retries are exhausted. |
| Tool call limit | `MEMOTURN_TOOL_CALL_LIMIT_PER_TURN` | Caps how often each tool may run within one turn; over-limit calls return an error result to the model instead of executing. |
| PII redaction | `MEMOTURN_PII_REDACTION_ENABLED` | Redacts well-formatted PII (emails, card/SSN/phone numbers) from model *input*. The persisted history is untouched — only what the model sees changes. |
| Human approval | `MEMOTURN_HITL_TOOLS` | Pauses the named tools for approval (below). |

Custom middlewares subclass `memoturn.agent.middleware.Middleware` and are installed by
overriding `Agent.get_middlewares()` — a public extension point, like `get_system_prompt` and
`get_tools`.

## Human-in-the-loop approvals

Tools listed in `MEMOTURN_HITL_TOOLS` don't run until a human says so. When the model calls one,
the runtime persists everything needed to continue — the gated call, the step's remaining calls,
results already produced — and ends the turn:

```
tool_call → interrupt (interrupt_id, tool_name, tool_input) → turn_completed (stop_reason: "interrupted")
```

The pending interrupt is durable: the agent can [hibernate](/agents/), the process can restart,
and the approval still resolves. No worker is held open while a human decides — pausing is free.

Resolve it three ways:

- **Approve** — the tool runs and the turn continues to completion.
- **Approve with edits** — a JSON `payload` replaces the tool's input ("fix the recipient, then
  send").
- **Deny with a note** — the model receives an error result carrying your note and continues
  (it can apologize, or try another approach).

Surfaces: the `resume` [WebSocket event](/api-websocket/#client--server) (streams the
continuation), `GET /v1/agents/{name}/interrupts` and
`POST /v1/agents/{name}/interrupts/{id}/resume` for non-streaming callers, the console's
**Approvals** tab, and approval cards in `/ui`. Interrupts are resolved *before* the tool
executes, so an approved side-effectful tool (a payment, a deploy) runs at most once even if a
resume crashes mid-flight. An `interrupt` [webhook](/webhooks/) makes "approval needed"
notifications one config line.

## Cancellation & double-texting

The `cancel` WebSocket event stops the in-flight turn. Because the loop persists state per step,
whatever the turn already wrote stays consistent.

When a *new message* arrives while a turn is running, the strategy is configurable —
`MEMOTURN_DOUBLE_TEXTING_DEFAULT` server-wide, or per message via `if_busy`:

| Strategy | Behavior |
| --- | --- |
| `enqueue` (default) | The new message waits; the actor's lock preserves arrival order. |
| `reject` | Immediate `error` (`code: "busy"`); the in-flight turn is untouched. |
| `interrupt` | Cancel the in-flight turn, keep its persisted progress, run the new message. |
| `rollback` | Cancel *and* discard everything the cancelled turn wrote — messages, memory, files — via the [turn clock](/sessions/), as if it never ran. Then run the new message. |

## Related

- [Sessions & turns](/sessions/) — the turn loop these hooks wrap.
- [WebSocket API](/api-websocket/) — the `resume`, `cancel`, and `if_busy` wire protocol.
- [Webhooks](/webhooks/) — notify external systems when a turn completes or pauses.
- [Configuration](/configuration/) — every setting named above.
