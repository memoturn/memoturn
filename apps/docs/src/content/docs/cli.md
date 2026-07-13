---
title: CLI
description: The memoturn command — the control-plane server, enterprise-auth admin subcommands, and the bundled WebSocket REPL client.
---

`memoturn` (a.k.a. `python -m memoturn`) is the runtime's entry point. With no subcommand it
starts the control-plane HTTP + WebSocket server; admin subcommands manage enterprise-auth state.
A separate bundled terminal client chats with an agent over the [WebSocket protocol](/api-websocket/).

## Server

```bash
uv run memoturn                 # serve (same as `make dev`)
```

| Flag | Default | Description |
| --- | --- | --- |
| `--host` | from config | Bind host (overrides `MEMOTURN_HOST`). |
| `--port` | from config | Bind port (overrides `MEMOTURN_PORT`). |
| `--reload` | off | Auto-reload on code change (dev only). |
| `--version` | — | Print the version and exit. |

## Admin subcommands (Enterprise Edition)

These manage identity-store state and require the `memoturn-enterprise` package. Each writes a
JSON audit line (and persists it when `MEMOTURN_AUDIT_PERSIST_ENABLED` is set).

**SCIM bearer tokens** — per-tenant [SCIM](/scim/) provisioning credentials. The raw token is
printed once at creation; only its hash is stored.

```bash
memoturn scim-token create --tenant acme --label okta
memoturn scim-token list   --tenant acme
memoturn scim-token revoke --tenant acme --id <token-id>
```

**OIDC issuers** — per-tenant [SSO](/sso/) issuer registrations; running replicas pick changes up
within `MEMOTURN_AUTH_OIDC_PROVIDER_REFRESH_SECONDS`.

```bash
memoturn oidc-provider add --issuer https://login.example.com/acme --tenant acme \
  --client-id memoturn --group-role-map '{"platform-admins": "admin"}'
memoturn oidc-provider list   --tenant acme
memoturn oidc-provider remove --issuer https://login.example.com/acme
```

## Terminal client

A reference implementation of the [WebSocket protocol](/api-websocket/) for chatting with an agent
from the command line:

```bash
uv run python clients/cli.py --agent demo
```

| Flag | Default | Description |
| --- | --- | --- |
| `--agent` | `demo` | Agent name (created on first contact). |
| `--tenant` | `default` | Tenant id. |
| `--host` | `localhost` | Server host. |
| `--port` | `8080` | Server port. |

It connects to `ws://{host}:{port}/v1/agents/{agent}/ws?tenant={tenant}`, then runs a REPL: type a
message and the reply streams back token by token. Tool calls, tool results, context-memory
updates, the stop reason, and token usage are printed inline as the corresponding
[events](/api-websocket/) arrive. Type `exit` or `quit` to disconnect.

## Example

```text
$ uv run python clients/cli.py --agent demo
connected to demo (session sess_…)
> what's 2+2?
4
[done] end_turn  (in 312, out 8 tokens)
> exit
```

## Beyond the CLI

The same protocol powers the [admin console](/quickstart/) (served at `/console`) and the minimal
`/ui` chat. To build your own client, see the [WebSocket API](/api-websocket/).
