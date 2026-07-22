---
title: MCP server
description: Expose a project's traces, metrics, prompts, datasets, and review queues as MCP tools — stdio for agent IDEs, or the remote Streamable HTTP endpoint.
---

memoturn ships a [Model Context Protocol](https://modelcontextprotocol.io) server that exposes a
project's **traces & metrics**, **prompts**, **datasets**, and **review queues** as tools for
agent IDEs (Claude Desktop, Cursor, etc.). It talks to the same server logic the REST API uses,
so it reads and writes the live project.

There are two ways to connect, backed by the same tool registry:

- **Local stdio server** (`apps/mcp`) — runs next to your datastores, ideal for self-host.
- **Remote Streamable HTTP endpoint** — served by the API at `/v1/mcp/{projectId}`, one MCP
  resource per project.

## Tools

| Tool | Purpose |
| --- | --- |
| `query_traces` | List recent traces with filters (environment, user, session, level, tag, score name, free-text search, day window); returns summaries with cost/token/latency rollups. |
| `get_trace` | Full trace detail: metadata, observation tree (spans/generations), scores. |
| `get_metrics` | Project metrics over the last N days (default 30): totals + per-day/per-model breakdowns of traces, generations, errors, tokens, cost. |
| `list_scores` | Scores attached to a trace (name, value, source). |
| `run_evaluator` | Run an existing LLM-as-judge evaluator over a trace and record an EVAL score (write). |
| `list_prompts` | List prompts (name, folder, versions, channels). |
| `get_prompt` | Full prompt detail with every version. |
| `resolve_prompt` | Resolve a channel (default `production`) to compiled content + config. |
| `create_prompt_version` | Create a new prompt version (and the prompt if new). |
| `list_datasets` | List datasets with item/run counts. |
| `get_dataset` | Dataset items + runs. |
| `create_dataset` | Create a dataset (idempotent on name). |
| `add_dataset_items` | Append items (input / expectedOutput / metadata). |
| `list_review_queues` | List review queues with pending/done counts. |
| `create_review_queue` | Create a queue bound to a score name + data type. |
| `add_review_items` | Enqueue traces by id. |
| `list_review_items` | List queue items (default `PENDING`) with trace I/O. |
| `submit_review_score` | Score a review item (numeric/boolean `value` or categorical `stringValue`). |

## Local stdio server

### Auth

The server is scoped to a single project, resolved at startup from a project API key pair (the
same `pk-mt-…` / `sk-mt-…` keys the SDK uses):

- `MEMOTURN_PUBLIC_KEY`
- `MEMOTURN_SECRET_KEY`

It also needs the datastore connection env (`DATABASE_URL`, `REDIS_URL`, `DORIS_HOST`, …)
since it queries them directly.

### Run

```bash
bun --filter @memoturn/mcp start    # stdio; logs to stderr, JSON-RPC on stdout
```

### Configure an agent IDE

The server speaks stdio. Point your IDE's MCP config at it, e.g.:

```jsonc
{
  "mcpServers": {
    "memoturn": {
      "command": "bun",
      "args": ["run", "/path/to/memoturn/apps/mcp/src/index.ts"],
      "env": {
        "MEMOTURN_PUBLIC_KEY": "pk-mt-…",
        "MEMOTURN_SECRET_KEY": "sk-mt-…",
        "DATABASE_URL": "postgresql://…",
        "REDIS_URL": "redis://…",
        "DORIS_HOST": "…"
      }
    }
  }
}
```

## Remote endpoint (Streamable HTTP)

The API serves the same tool registry over Streamable HTTP. Each project is its own MCP
resource, so clients connect per-project. RBAC is per-tool (not per-method — every call is a
POST): a tool's mutating flag maps to a `read`/`write` permission, and write tools are audited.

Two auth paths resolve to the same per-project authorization:

- **API-key Basic** (`pk-mt-…:sk-mt-…`, self-host / headless) — the key must belong to the
  `{projectId}` in the URL; the tool's permission is checked against the key's `read`/`write`
  scope.
- **OAuth 2.1 bearer** (memoturn cloud, IDE click-through) — memoturn is its own OAuth 2.1
  authorization server: PKCE (S256) is mandatory, IDE clients self-register via dynamic client
  registration (RFC 7591), and refresh tokens rotate. Access tokens are JWTs verified
  **statelessly** (signature against the server's JWKS, strict issuer `{AUTH_BASE_URL}/auth` +
  audience binding to the API origin — no DB hit per call). The token's `sub` resolves to a
  user, who is then authorized against `{projectId}` (org membership → role): any member may run
  read tools; only non-`VIEWER` roles may run write tools. Clients discover the flow via the
  `.well-known` documents below; an unauthenticated request returns `401` with
  `WWW-Authenticate: Bearer resource_metadata="…"`.

| Method | Path | Description |
| --- | --- | --- |
| `GET / POST / DELETE` | `/v1/mcp/{projectId}` | Streamable-HTTP MCP endpoint scoped to `{projectId}`. `401` (advertising `Bearer` + `Basic`) when auth is missing/invalid or the caller isn't authorized for the project. |
| GET | `/.well-known/oauth-authorization-server` | OAuth authorization-server metadata. |
| GET | `/.well-known/openid-configuration` | OpenID Connect discovery metadata. |
| GET | `/.well-known/oauth-protected-resource` | OAuth protected-resource metadata (RFC 9728) — names the API origin as the canonical `resource` and points clients at the authorization server. |

Behind Caddy (the single-VM production stack), these `.well-known/*` paths are routed to
the API — they're served at the domain root, not the console. The OAuth authorize flow bounces
users to the console sign-in and consent pages (`MCP_LOGIN_PAGE` / `MCP_CONSENT_PAGE`, defaults
`<first AUTH_TRUSTED_ORIGINS>/login` and `…/consent`). The endpoint also applies a per-IP
rate limit before auth, so unauthenticated clients don't get free credential-check tries.

See the [API reference](/api/) for the full route surface.
