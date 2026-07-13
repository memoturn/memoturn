---
title: Providers
description: The pluggable LLM layer — Anthropic, OpenAI, Ollama, Bedrock, and Vertex behind one streaming interface.
---

The **provider** is the LLM backing an agent. It's a pluggable interface: every backend maps to one
canonical streaming message format (text, tool-use, and tool-result blocks), so agents, tools, and
the [turn loop](/sessions/) don't change when you switch models.

Select with [`MEMOTURN_LLM_PROVIDER`](/configuration/#llm-provider) and set the model with
`MEMOTURN_MODEL`.

| Provider | `MEMOTURN_LLM_PROVIDER` | Credentials | Notes |
| --- | --- | --- | --- |
| **Anthropic (Claude)** | `anthropic` (default) | `ANTHROPIC_API_KEY` | Direct API; prompt caching on the static prefix. Default model `claude-sonnet-4-6`. |
| **OpenAI** | `openai` | `OPENAI_API_KEY` | Direct API; `MEMOTURN_OPENAI_BASE_URL` to override the endpoint. |
| **Ollama** | `ollama` | none | Local/remote, OpenAI-compatible. `MEMOTURN_OLLAMA_BASE_URL` (default `http://localhost:11434/v1`). |
| **AWS Bedrock** | `bedrock` | AWS default chain (IRSA / instance role) | Claude in-region for data residency. `MEMOTURN_BEDROCK_REGION`; `model` is the Bedrock model id. |
| **Google Vertex AI** | `vertex` | Google ADC / Workload Identity | Claude in-region for data residency. `MEMOTURN_VERTEX_PROJECT_ID`, `MEMOTURN_VERTEX_REGION`. |

`ANTHROPIC_API_KEY` and `OPENAI_API_KEY` are read **without** the `MEMOTURN_` prefix, to match the
official SDK conventions. Bedrock and Vertex take **no keys** — credentials come from the cloud's
default chain, so nothing is stored in config.

## The streaming interface

A provider exposes a single `stream(system, messages, tools, max_tokens)` method that yields
incremental text deltas, tool-use requests, and a final "done" event carrying the stop reason and
token usage (input, output, and cache read/write). Tool-calling is normalized across providers, so
the same agent and the same [tools](/tools/) work on any backend.

Prompt caching (where supported, e.g. Anthropic) is applied to the static prefix — the system
prompt and tool definitions — to cut cost on multi-turn conversations.

## Pluggability

`Provider` is one of three interfaces (`Provider`, [`Sandbox`](/sandboxing/),
[`Durability`](/fibers/)) you can swap without forking. Ship with Claude, run fully offline against
Ollama, or move to in-region Bedrock/Vertex for data residency — the rest of the runtime is
unchanged.

## Quick examples

```bash
# Claude (default)
export ANTHROPIC_API_KEY=...
MEMOTURN_MODEL=claude-sonnet-4-6 make dev

# Fully offline with Ollama
MEMOTURN_LLM_PROVIDER=ollama MEMOTURN_MODEL=llama3.1 make dev

# In-region on Bedrock (data residency)
MEMOTURN_LLM_PROVIDER=bedrock MEMOTURN_BEDROCK_REGION=us-east-1 \
  MEMOTURN_MODEL=anthropic.claude-... make dev
```

## Related

- [Memory embeddings](/memory/#embeddings) — embedders are configured separately and can also run
  in-region (Bedrock/Vertex/Ollama).
- [Configuration](/configuration/#llm-provider) — every provider setting.
