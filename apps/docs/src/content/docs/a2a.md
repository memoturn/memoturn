---
title: A2A
description: Agent2Agent protocol — discover and message Memoturn agents, and call remote A2A agents.
---


Memoturn speaks the [A2A protocol](https://a2a-protocol.org) in both directions, built on the
official [`a2a-sdk`](https://github.com/a2aproject/a2a-python) (A2A 1.0, JSON-RPC binding):

- **Server** — every Memoturn agent is an A2A agent other frameworks can discover and message.
- **Client** — remote A2A agents become tools your Memoturn agents can call mid-turn.

Install the extra and enable it:

```bash
pip install "memoturn[a2a]"          # or: uv sync --extra a2a
export MEMOTURN_A2A_ENABLED=true
```

## Serving agents over A2A

With `a2a_enabled`, each agent gets an A2A surface under `/a2a/{agent}`:

| Endpoint | Auth | Purpose |
| --- | --- | --- |
| `GET /a2a/{agent}/.well-known/agent-card.json` | public | discovery metadata (card) |
| `POST /a2a/{agent}/` | required | JSON-RPC: `SendMessage`, `SendStreamingMessage`, `GetTask`, `CancelTask`, ... |

Agents are created lazily on first message, exactly like the WebSocket surface. The JSON-RPC
endpoint uses the same authentication (`api_key`/`jwt`), RBAC (`chat` permission), per-tenant rate
limits, and audit logging as `/v1`; the advertised security scheme appears in the card. Under
scale-out, A2A requests owner-route on the agent name like every other agent request.

```bash
curl -s localhost:8080/a2a/demo/.well-known/agent-card.json | jq .name

curl -s localhost:8080/a2a/demo/ \
  -H 'content-type: application/json' -H 'A2A-Version: 1.0' -d '{
  "jsonrpc": "2.0", "id": 1, "method": "SendMessage",
  "params": {"message": {"messageId": "m1", "role": "ROLE_USER",
             "contextId": "ctx-1", "parts": [{"text": "hello"}]}}
}'
```

Or with the official SDK client (it negotiates transport and version from the card):

```python
from a2a.client import create_client
from a2a.helpers import new_text_message
from a2a.types import Role, SendMessageRequest

client = await create_client("http://localhost:8080/a2a/demo/")
request = SendMessageRequest(
    message=new_text_message("hello", role=Role.ROLE_USER, context_id="ctx-1")
)
async for chunk in client.send_message(request):
    ...
```

Semantics:

- An A2A **`context_id` maps to a durable session** (`sess_a2a_{context_id}`): reuse one
  `context_id` to continue a conversation with full history, compaction, and long-term memory —
  across hibernation and replica migration.
- `message/stream` streams assistant text incrementally as artifact chunks of one `response`
  artifact; tool calls surface as `working` status updates; token usage lands in the completion
  status metadata (`memoturn/usage`).
- `tasks/cancel` interrupts an in-flight turn.

Set `MEMOTURN_A2A_PUBLIC_BASE_URL` to the externally reachable base URL so agent cards advertise
the right endpoint (falls back to `replica_address`, then `http://{host}:{port}`).

## Calling remote A2A agents as tools

Declare remote agents (JSON list in the env var); each mounts as an `a2a__{name}` tool, mirroring
how MCP servers mount:

```bash
export MEMOTURN_A2A_REMOTE_AGENTS='[
  {"name": "researcher", "url": "https://agents.example.com/a2a/researcher/",
   "headers": {"x-api-key": "..."}}
]'
```

The model then calls `a2a__researcher` with `{"message": "...", "context_id": "..."}`. The remote
card is resolved lazily on first call (the server boots even if the remote is down), and by default
one remote `context_id` is reused per local session so repeated calls continue the same remote
conversation.

## Configuration reference

| Setting (env var) | Default | Meaning |
| --- | --- | --- |
| `MEMOTURN_A2A_ENABLED` | `false` | expose every agent under `/a2a/{agent}` |
| `MEMOTURN_A2A_PUBLIC_BASE_URL` | `""` | base URL advertised in agent cards |
| `MEMOTURN_A2A_REMOTE_AGENTS` | `[]` | remote A2A agents to mount as tools |

## Related

- [MCP](/mcp/) — the sibling protocol for tool servers and exposing agents as tools.
- [Tools](/tools/) — how mounted remote agents (`a2a__{name}`) sit alongside built-ins.
- [Sessions & turns](/sessions/) — the durable sessions A2A `context_id`s map to.
- [Configuration](/configuration/#a2a) — every A2A setting.
