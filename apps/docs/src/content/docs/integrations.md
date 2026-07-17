---
title: Integrations
description: Ingest telemetry from OpenTelemetry, OpenAI, LangChain, LiteLLM, or any custom source.
---

memoturn ingests from any source that can speak its batched `/v1/ingest` API or OpenTelemetry.
All paths funnel through the same pipeline → Doris.

## OpenTelemetry (universal)

Point any OTLP/HTTP (JSON) exporter at the receiver with Basic auth:

```
POST http://localhost:3001/v1/otel/v1/traces
Authorization: Basic base64(publicKey:secretKey)
Content-Type: application/json
```

Spans carrying GenAI semantic-convention attributes (`gen_ai.*`) become **generations** (model,
provider, token usage mapped); other spans become **spans**. This is the zero-lock-in path for
frameworks that emit OTel (LlamaIndex, Pydantic AI, Semantic Kernel, etc.). OTLP/protobuf support
is planned.

## OpenAI

- **TypeScript:** `wrapOpenAI(new OpenAI(), mt)` — see the [TypeScript SDK](/sdk-typescript/).
- **Python:** `wrap_openai(OpenAI())` — see the [Python SDK](/sdk-python/).

Each `chat.completions.create` is recorded as a generation with model, params, usage, latency,
and errors.

## LangChain

- **JS:** `new MemoturnCallback(mt)` passed in `callbacks`.
- **Python:** `MemoturnCallbackHandler()` passed in `config={"callbacks": [...]}`.

Chains, LLM/chat calls, and tools are recorded as a flat trace tree (one trace per
handler, siblings — LangChain's `parent_run_id` isn't used for nesting).

## LlamaIndex

- **Python:** `MemoturnLlamaIndexHandler()` passed to `CallbackManager([...])`.

Query/retrieve/synthesize/LLM/tool/agent steps are recorded as a properly nested
trace tree (using LlamaIndex's own parent ids), including retrieved documents and
embedding vectors, with one trace per top-level operation. Python only.

## LiteLLM

Use LiteLLM's custom callback to forward to `/v1/ingest` (adapter under
[`integrations/litellm`](https://github.com/memoturn/memoturn/blob/main/integrations/litellm)),
or route LiteLLM through its OTel exporter into the OTel receiver above.

## Anything else

Send batched events directly to `POST /v1/ingest` — see the [API reference](/api/) and the event
contracts in
[`packages/core/src/events.ts`](https://github.com/memoturn/memoturn/blob/main/packages/core/src/events.ts).
