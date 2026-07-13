---
title: Tools
description: The built-in tools agents call, the tool registry, and how tool calls are executed.
---

Tools are the actions an agent can take during a [turn](/sessions/). Each tool has a name, a
JSON-Schema for its input, and an async handler. The model calls tools; the [turn loop](/sessions/)
executes them and feeds results back. Handlers never raise to the model — an error becomes a result
the model can read and react to.

## Built-in tools

| Tool | Tier | Purpose |
| --- | --- | --- |
| `current_time` | 0 | Current UTC time. |
| `set_context` | 0 | Update a [context block](/memory/#context-blocks) (`replace` / `append` / `clear`). |
| `search_context` | 0 | Full-text search the conversation history. |
| `remember` | 0 | Store a [long-term memory](/memory/) (`fact` / `event` / `instruction` / `task`). |
| `recall` | 0 | Hybrid search of long-term memory, optionally synthesizing an answer. |
| `forget` | 0 | Mark a memory forgotten. |
| `list_memories` | 0 | List stored memories. |
| `write_file` / `read_file` / `list_files` | 0 | [Workspace](/workspace/) file access. |
| `exec_code` | 1 | Run Python in a [sandbox](/sandboxing/) (workspace granted by default; may declare dependencies). |
| `browse` | 3 | Fetch a rendered page or screenshot. |
| `run_shell` | 4 | Run a shell command against the materialized workspace. |
| `create_extension` / `delete_extension` / `list_extensions` | — | [Self-authored tools](/extensions/). |
| `call_subagent` | — | Delegate to a [sub-agent](/agents/#sub-agents). |
| `mcp_list_resources` / `mcp_read_resource` / `mcp_list_prompts` / `mcp_get_prompt` | — | Discover [MCP](/mcp/) resources and prompts (mounted only when an MCP server is connected). |

Higher-tier tools appear only when their tier is enabled (see the
[execution ladder](/execution-ladder/) and [configuration](/configuration/)).

## The registry

Tools live in a per-agent **registry** that is mutable within a session — which is what lets agents
create and remove their own [extensions](/extensions/) at runtime. The registry serializes tool
specs for the model and routes calls to handlers, catching exceptions so a failing tool never
breaks the turn.

Each handler runs with a **tool context** carrying the tenant, agent, session, database, session
store, memory, and — when their tiers are enabled — the [workspace](/workspace/),
[sandbox](/sandboxing/), browser, shell, sub-agent runner, extension store, long-term memory,
embedder, and profile resolver.

## Mounted tools

Beyond the built-ins, tools are mounted from:

- **[MCP servers](/mcp/)** — external servers' tools appear as `mcp__{server}__{tool}` and refresh
  live when a server announces changes.
- **[A2A remote agents](/a2a/)** — each remote agent becomes an `a2a__{name}` tool.

## Related

- [Extensions](/extensions/) — tools the agent writes for itself.
- [Sandboxing](/sandboxing/) — how `exec_code` and `run_shell` are isolated.
- [MCP](/mcp/) and [A2A](/a2a/) — mounting external tools and agents.
