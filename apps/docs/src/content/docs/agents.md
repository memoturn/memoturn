---
title: Agents & actors
description: The agent actor — durable per-agent state, single-writer turns, hibernation, and rehydration.
---

An **agent** is a durable, named entity (`tenant/name`) with its own state, memory, and
conversation history. At runtime each agent is hosted by an **actor** — Memoturn's analogue of a
Durable Object. The actor is the unit of durability, concurrency, and hibernation.

## The actor model

Every agent maps to at most one live actor across the fleet. The actor:

- **Owns per-agent state** — a dedicated SQLite database under `data/agents/<tenant>/<name>.db`
  holding sessions, messages, summaries, context blocks, fibers, extensions, long-term memories,
  and workspace metadata.
- **Serializes turns** through a single-writer lock — only one turn runs at a time per agent, so
  state never races.
- **Hibernates when idle** — flushes its database, drops the in-memory agent, and costs nothing
  until the next request.
- **Rehydrates on demand** — restores from disk (or a durable snapshot) on the next request,
  transparently.

Actors are created lazily: the first request for `tenant/name` constructs the actor and registers
the agent in the control plane. Agents are created on first contact — there is no "create agent"
call.

## Lifecycle

| State | Meaning |
| --- | --- |
| **live** | Resident in memory; its SQLite DB is open. `live == true`. |
| **busy** | A turn (or fiber) holds the single-writer lock. |
| **idle** | Live but no activity for `seconds_idle()`. |
| **hibernated** | Evicted from memory; state on disk (and snapshot, if configured). |

### Hibernation

A background **reaper** sweeps every `max(1, hibernate_after_seconds / 3)` seconds and hibernates
any actor that is live, not busy, and idle for at least
[`MEMOTURN_HIBERNATE_AFTER_SECONDS`](/configuration/) (default `30`). Hibernation:

1. Refuses if the actor is busy (a turn is mid-flight).
2. Closes the SQLite connection (flushing the WAL).
3. Snapshots the DB to durable storage when a [snapshot backend](/configuration/#storage--persistence)
   is configured (`file` or `s3`).
4. Optionally deletes the local DB (`MEMOTURN_SNAPSHOT_EVICT_LOCAL`, default on) so the next wake
   restores the durable copy.
5. Releases the ownership lease (under [scale-out](/scaling/)).

### Rehydration

On the next request, the actor:

1. Acquires the cross-replica ownership lease (if scale-out is enabled).
2. Restores the durable snapshot to local disk if the local DB is absent.
3. Opens the SQLite DB and reconstructs the agent harness.
4. Re-registers persisted [extensions](/extensions/) (self-authored tools).

Because all durable state lives in SQLite and (optionally) a snapshot store, an agent survives
process crashes, restarts, and — under scale-out — moving between replicas.

## The agent harness

Inside the actor, the **Agent** is the opinionated harness that runs the
[turn loop](/sessions/): it owns the [session store](/sessions/), [long-term memory](/memory/),
[context blocks](/memory/#context-blocks), the [fiber registry](/fibers/), the
[tool registry](/tools/), the [sandbox](/sandboxing/), and the [workspace](/workspace/). It is
designed to be subclassed — override `get_system_prompt()`, `get_tools()`, `max_steps`, and
`max_tokens` to shape behavior.

## Sub-agents

An agent can delegate to **sub-agents** with the `call_subagent` tool. A child agent is namespaced
under its parent (`parent.child`) and is itself a full actor with its own durable state. Nesting is
bounded to a depth of 3 to prevent runaway fan-out.

## Talking to an agent

- **WebSocket** — `GET /v1/agents/{name}/ws` for streaming chat (see the
  [WebSocket API](/api-websocket/)).
- **REST** — list/inspect sessions, fibers, and memories (see the [REST API](/api-rest/)).
- **MCP / A2A** — when enabled, each agent is also reachable as an [MCP server](/mcp/) and an
  [A2A agent](/a2a/).

## Related

- [Sessions & turns](/sessions/) — the conversation model and the turn loop.
- [Durable execution](/fibers/) — background tasks that survive crashes.
- [Architecture](/architecture/) — how actors fit the whole system.
- [Scaling out](/scaling/) — ownership, leases, and migration across replicas.
