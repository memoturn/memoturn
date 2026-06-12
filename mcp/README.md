# Memoturn MCP server

Gives any MCP-capable agent (Claude Desktop, Claude Code, IDE assistants, agent frameworks)
typed memory tools over a Memoturn node: `memory_ingest`, `memory_recall`, `memory_ask`,
`memory_extract`, forget/erase, sessions, plus the substrate (docs/KV/vectors/SQL), branching
(checkpoint/rewind/fork), transcript, governance, and token minting — ~34 tools in five groups.
The full tool reference lives at [docs.memoturn.ai/mcp](https://docs.memoturn.ai/mcp/).

Build: `npm i && npm run build`. Tests (stubbed upstream, no node needed): `npm test`.

## stdio (local agents)

Claude Desktop / Claude Code config:

```json
{
  "mcpServers": {
    "memoturn": {
      "command": "node",
      "args": ["/path/to/memoturn/mcp/dist/index.js"],
      "env": {
        "MEMOTURN_URL": "http://127.0.0.1:8080",
        "MEMOTURN_TOKEN": "<per-database or namespace JWT>",
        "MEMOTURN_SOURCE": "claude-code"
      }
    }
  }
}
```

## Streamable HTTP (remote / shared)

`node dist/index.js --http [port]` (or set `MEMOTURN_MCP_PORT`) serves streamable HTTP with
per-session credentials. `MEMOTURN_MCP_HOST` defaults to `127.0.0.1` — set `0.0.0.0` only
behind TLS/ingress. A `Dockerfile` in this directory builds the server image; the Helm chart
deploys it alongside the nodes.

## Environment

| var | role |
| --- | --- |
| `MEMOTURN_URL` | the node/gateway to talk to (default `http://127.0.0.1:8080`) |
| `MEMOTURN_TOKEN` | data-plane JWT (per-database, or namespace for orchestrators) |
| `MEMOTURN_PLATFORM_KEY` | control-plane key — only needed for db/token tools |
| `MEMOTURN_SOURCE` | default provenance for memory writes (e.g. `claude-code`) — recorded on each memory so multi-agent profiles can filter recall by originating agent; read per call, overridable per tool invocation |
| `MEMOTURN_MCP_PORT` / `MEMOTURN_MCP_HOST` | HTTP transport (see above) |
