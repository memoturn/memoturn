---
title: MCP
description: Model Context Protocol — Memoturn as both an MCP server and client.
---


Memoturn speaks [MCP](https://modelcontextprotocol.io) in both directions, built on the official
[`mcp` Python SDK](https://github.com/modelcontextprotocol/python-sdk):

- **Client** — external MCP servers (stdio, Streamable HTTP, or legacy SSE) mount as tools your
  agents can call mid-turn.
- **Server** — every Memoturn agent is an MCP server that Claude Code, Claude.ai, or any other
  MCP client can call as a tool.

Install the extra:

```bash
pip install "memoturn[mcp]"          # or: uv sync --extra mcp
```

## Mounting external MCP servers as tools

Declare servers (JSON list in the env var); each server's tools mount as `mcp__{server}__{tool}`:

```bash
export MEMOTURN_MCP_SERVERS='[
  {"name": "files", "command": "npx",
   "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]},

  {"name": "linear", "url": "https://mcp.linear.app/mcp",
   "headers": {"authorization": "Bearer ..."}},

  {"name": "legacy", "url": "https://old.example.com/sse", "transport": "sse"}
]'
```

The transport is inferred: `command` → stdio subprocess, `url` → Streamable HTTP. Legacy SSE
servers share the `url` field, so they must say `"transport": "sse"` explicitly.

Semantics:

- Each server has an **independent connection**: one server failing to connect is logged and
  skipped, not fatal (set `MEMOTURN_MCP_STRICT=true` to abort startup instead).
- A tool result's `structuredContent` is passed to the model as JSON; otherwise content blocks
  are flattened to text. A server-side `isError` result surfaces as a tool error result.
- A server's `tools/list_changed` notification re-lists just that server's tools and updates
  every agent — live agents in place, hibernated ones on wake.
- When at least one server is connected, agents also get four discovery tools —
  `mcp_list_resources`, `mcp_read_resource`, `mcp_list_prompts`, `mcp_get_prompt` — for the
  servers' MCP resources and prompt templates (resources are not auto-mounted one-tool-each;
  a server can expose thousands).

## Serving agents over MCP

```bash
export MEMOTURN_MCP_SERVER_ENABLED=true
```

Each agent gets a Streamable HTTP MCP endpoint at `/mcp/{agent}/` exposing one tool, `chat`:

| Tool argument | Required | Meaning |
| --- | --- | --- |
| `message` | yes | the message to send to the agent |
| `session` | no | conversation id; calls sharing a `session` share one durable session (`sess_mcp_{session}`) with full history, compaction, and long-term memory — across hibernation and replica migration |

Agents are created lazily on first call, exactly like the WebSocket surface. The endpoint uses the
same authentication (`api_key`/`jwt`), RBAC (`chat` permission), per-tenant rate limits, and audit
logging as `/v1`; under scale-out, MCP requests owner-route on the agent name like every other
agent request.

Connect from Claude Code:

```bash
claude mcp add --transport http memoturn-demo http://localhost:8080/mcp/demo/ \
  --header "x-api-key: ..."
```

Or with the official SDK client:

```python
from mcp import ClientSession
from mcp.client.streamable_http import streamable_http_client

async with streamable_http_client("http://localhost:8080/mcp/demo/") as (read, write, _):
    async with ClientSession(read, write) as session:
        await session.initialize()
        result = await session.call_tool("chat", {"message": "hello", "session": "ctx-1"})
```

With `MEMOTURN_MCP_SERVER_EXPOSE_RESOURCES=true`, the agent's long-term memories are also served
as read-only `memory://{agent}/{id}` resources (`resources/list` + `resources/read`).

## Configuration reference

| Setting (env var) | Default | Meaning |
| --- | --- | --- |
| `MEMOTURN_MCP_SERVERS` | `[]` | external MCP servers to mount as tools |
| `MEMOTURN_MCP_STRICT` | `false` | a server that fails to connect aborts startup |
| `MEMOTURN_MCP_SERVER_ENABLED` | `false` | expose every agent under `/mcp/{agent}` |
| `MEMOTURN_MCP_SERVER_STATELESS` | `true` | self-contained requests (right for scale-out); `false` keeps MCP sessions in replica memory |
| `MEMOTURN_MCP_SERVER_EXPOSE_RESOURCES` | `false` | serve agent memories as MCP resources |

Per-server fields in `MEMOTURN_MCP_SERVERS`: `name` (required), and either `command` + `args` +
`env` (stdio) or `url` + `headers` (remote), with optional explicit `transport`
(`stdio` | `streamable_http` | `sse`).

## Related

- [Tools](/tools/) — how mounted MCP tools (`mcp__{server}__{tool}`) sit alongside built-ins.
- [A2A](/a2a/) — the sibling protocol for agent-to-agent messaging.
- [Security](/security/) — the auth/RBAC the `/mcp` surface shares with `/v1`.
- [Configuration](/configuration/#mcp) — every MCP setting.
