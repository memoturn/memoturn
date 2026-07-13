---
title: Architecture
description: Topology, primitives, and the request path of the Memoturn agent runtime.
---

Memoturn is a durable runtime for AI agents built on open, self-hostable infrastructure. The
Apache-2.0 core (`memoturn`) is fully functional on its own; commercial capabilities ship in a
separate `memoturn-enterprise` distribution the core discovers at runtime — see
[Open-core & Enterprise Edition](/enterprise/).

## Topology

Everything runs via `docker compose`:

- **control-plane** — a FastAPI/uvicorn process that hosts agent **actors in-process** and serves
  the HTTP + WebSocket API. Escalates code execution to ephemeral sandbox containers via the Docker
  socket.
- **postgres** — control-plane metadata (agent registry, routing, tenants, users). SQLite is used
  for single-node dev without this.
- **minio** — S3-compatible blob storage for the Tier 0 workspace.
- **sandbox containers** — short-lived, spawned per code-execution request (Tiers 1–4).

## Core primitives

| Primitive | What it is | Backing tech |
| --- | --- | --- |
| [Agent actor](/agents/) | Addressable entity (`tenant/name → actor`) with a single-writer mailbox | in-process asyncio + per-agent SQLite |
| [Hibernation](/agents/#hibernation) | Idle actors flush state and evict from memory; rehydrate on next request | idle timer + `data/agents/<tenant>/<name>.db` |
| [Workspace](/workspace/) | Durable virtual filesystem | SQLite metadata + MinIO blobs |
| [Sandbox](/sandboxing/) | LLM-generated Python with zero ambient authority | subprocess / Docker / gVisor-on-Kubernetes + capability RPC bridge |
| [Durability (fibers)](/fibers/) | Crash-safe long-running invocations | SQLite checkpoint engine (pluggable backend) |
| [Provider](/providers/) | LLM access | Anthropic/Claude (swappable: OpenAI/Ollama/Bedrock/Vertex) |
| [Memory](/memory/) | Long-term recall + working context | SQLite/FTS + optional embeddings; cross-agent profiles |

`Provider`, `Sandbox`, and `Durability` are **public interfaces** — community extension points and
the way enterprises swap in their own backends.

## Cross-cutting

- **Multi-tenancy:** `tenant_id` is carried through routing and storage; per-agent SQLite files are
  namespaced by tenant. See [Security](/security/#hard-multi-tenancy).
- **Observability:** [OpenTelemetry](/observability/) spans threaded through turns, fibers, tools,
  and memory.
- **Security:** sandboxes start with [no capabilities](/sandboxing/); pluggable auth, RBAC, audit
  logging, secrets, rate limits, and encryption at rest — see [Security](/security/).
- **Metering:** the core emits four tenant-attributable usage meters (LLM tokens, agent turns,
  compute-seconds, storage) through a sink seam — see [Usage metering & billing](/billing/).
- **Scale-out:** run many replicas with consistent-hash ownership, leases, and transparent
  owner-proxy — see [Scaling out](/scaling/).
- **Open-core seam:** the core never imports `memoturn_enterprise`; it discovers optional
  capabilities (OIDC/SCIM, persistent audit, fine-grained RBAC, metered billing) through a
  runtime [plugin registry](/enterprise/#the-plugin-seam).

## The agent turn loop

A [turn](/sessions/) streams as `turn_started → text_delta* → (tool_call → tool_result)* →
turn_completed`, persisting each step before the next model call so a crash leaves a replayable
history. The harness (`agent/base.py`) is subclassable; override `get_system_prompt`, `get_tools`,
`max_steps`, and `max_tokens` without replacing the pipeline. See
[Sessions & turns](/sessions/) for the full lifecycle and [Tools](/tools/) for the action surface.

## What ships today

The runtime is in **alpha** — the capability surface below is built and tested, and APIs may still
change before a stability commitment. The durable core, the full [execution ladder](/execution-ladder/) (workspace →
sandboxed Python → dependencies → browser → shell), [long-term memory](/memory/) + sessions,
[durable fibers](/fibers/), [sub-agents](/agents/#sub-agents), [MCP](/mcp/)/[A2A](/a2a/) interop,
self-authored [extensions](/extensions/), [scale-out](/scaling/), and the
[enterprise hardening](/security/) surface (auth, RBAC, audit, rate limits, encryption at rest,
OpenTelemetry, the [admin console](/quickstart/), and a Helm chart) are all in place. Tracked,
not-yet-built work lives on the [roadmap](/roadmap/).

## Dive deeper

- **Concepts** — [Agents & actors](/agents/), [Sessions & turns](/sessions/),
  [Durable execution](/fibers/), [Workspace](/workspace/), [Memory](/memory/).
- **Execution** — [The execution ladder](/execution-ladder/), [Sandboxing](/sandboxing/),
  [Tools](/tools/), [Extensions](/extensions/).
- **Models & protocols** — [Providers](/providers/), [MCP](/mcp/), [A2A](/a2a/).
- **Operate** — [Deployment](/deployment/), [Operations](/operations/), [Security](/security/),
  [Scaling out](/scaling/), [Observability](/observability/).
- **Editions** — [Open-core & Enterprise Edition](/enterprise/),
  [Usage metering & billing](/billing/).
- **Reference** — [Configuration](/configuration/), [REST API](/api-rest/),
  [WebSocket API](/api-websocket/), [CLI](/cli/).
