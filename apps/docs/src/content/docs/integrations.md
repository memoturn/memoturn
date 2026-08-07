---
title: Integrations
description: Ingest telemetry from OpenTelemetry, the OpenAI/Anthropic/Bedrock/Gemini/Groq/Mistral/Cohere wrappers, LangChain, LangGraph, LlamaIndex, CrewAI, Haystack, the Pinecone/Chroma/Weaviate/Qdrant retrievers, MCP, or any custom source.
---

Memoturn ingests from any source that can speak its batched `/v1/ingest` API or
OpenTelemetry. All paths funnel through the same pipeline → Doris.

There are two ways in, and you can mix them:

1. **OpenTelemetry** — zero lock-in, works with anything that emits OTLP. Start here if your
   stack already has OTel wiring.
2. **First-party SDK wrappers** — one call to wrap a client you already constructed. Richer
   than the OTel path (retrieved documents, embeddings, streaming capture, prompt linkage)
   and no collector to run.

## Coverage at a glance

`✓` = a first-party wrapper ships in that SDK. Everything else can still reach Memoturn over
OpenTelemetry or `/v1/ingest`.

| Integration | TypeScript | Python | Go | Entry point |
| --- | :--: | :--: | :--: | --- |
| **Model providers** | | | | |
| OpenAI (+ Azure OpenAI) | ✓ | ✓ | | `wrapOpenAI` / `wrap_openai` |
| Anthropic | ✓ | ✓ | | `wrapAnthropic` / `wrap_anthropic` |
| Amazon Bedrock | ✓ | ✓ | | `wrapBedrock` / `wrap_bedrock` |
| Google Gemini | ✓ | ✓ | | `wrapGemini` / `wrap_gemini` |
| Groq | ✓ | ✓ | | `wrapGroq` / `wrap_groq` |
| Mistral | ✓ | ✓ | | `wrapMistral` / `wrap_mistral` |
| Cohere | ✓ | ✓ | | `wrapCohere` / `wrap_cohere` |
| OpenAI-compatible (vLLM, Ollama, OpenRouter) | ✓ | ✓ | | `wrapOpenAI` against the custom base URL |
| **Frameworks** | | | | |
| LangChain | ✓ | ✓ | | `MemoturnCallback` / `MemoturnCallbackHandler` |
| LangGraph | | ✓ | | `make_langgraph_handler` |
| LlamaIndex | | ✓ | | `MemoturnLlamaIndexHandler` |
| CrewAI | | ✓ | | `instrument_crewai` |
| Haystack | | ✓ | | `MemoturnHaystackTracer` |
| LiteLLM | | | | callback adapter or its OTel exporter |
| **Vector stores (RAG)** | | | | |
| Pinecone | ✓ | ✓ | | `wrapPinecone` / `wrap_pinecone` |
| Chroma | ✓ | ✓ | | `wrapChroma` / `wrap_chroma` |
| Weaviate | ✓ | ✓ | | `wrapWeaviate` / `wrap_weaviate` |
| Qdrant | ✓ | ✓ | | `wrapQdrant` / `wrap_qdrant` |
| **Protocols & platform** | | | | |
| MCP client | ✓ | ✓ | | `wrapMcpClient` / `wrap_mcp_client` |
| MCP server | ✓ | | | `wrapMcpServer` |
| OpenTelemetry export helpers | ✓ | ✓ | ✓ | `memoturnSpanProcessor` / `span_processor` / `OTLPConfig` |
| Manual tracing / decorators | ✓ | ✓ | ✓ | `observe` / `@observe` / `mt.Trace` |
| Prompts, datasets, guardrails | ✓ | ✓ | ✓ | see the SDK docs |

TypeScript wrappers are subpath imports — `import { wrapAnthropic } from "@memoturn/sdk/anthropic"`.
Python wrappers import from the package root — `from memoturn import wrap_anthropic`.

## OpenTelemetry (universal)

Point any OTLP/HTTP (JSON) exporter at the receiver with Basic auth:

```
POST http://localhost:3001/v1/otel/v1/traces
Authorization: Basic base64(publicKey:secretKey)
Content-Type: application/json
```

Spans carrying GenAI semantic-convention attributes (`gen_ai.*`) become **generations**
(model, provider, token usage mapped); other spans become **spans**. This is the
zero-lock-in path for frameworks that emit OTel (LlamaIndex, Pydantic AI, Semantic
Kernel, etc.). Both OTLP/HTTP encodings are accepted: `application/json` and
`application/x-protobuf` (the OTLP default).

There is also an OTLP **logs** receiver at `POST /v1/otel/v1/logs` (same auth + encodings).
Log records become **EVENT observations**: a record carrying trace context lands inside its
trace; records without it (common — many emitters attach only a `session.id`) group into a
per-session `otel-logs:<session.id>` trace that sits alongside the span-derived traces in
the session view. Log severity maps to the observation level (WARN → WARNING, ERROR/FATAL →
ERROR).

### Claude Code

Claude Code emits OTel natively, so Memoturn can observe your coding sessions: spans carry
the interaction/LLM-call/tool structure with token + cache usage (cost is computed from the
model registry), and log events carry the verbatim prompt/response text (`user_prompt` →
event input, `assistant_response` → event output, `api_error` → ERROR):

```bash
export CLAUDE_CODE_ENABLE_TELEMETRY=1 CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1
export OTEL_TRACES_EXPORTER=otlp OTEL_LOGS_EXPORTER=otlp
export OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
export OTEL_EXPORTER_OTLP_ENDPOINT=https://your-memoturn.example.com/v1/otel
export OTEL_EXPORTER_OTLP_HEADERS="Authorization=Basic $(printf 'pk-…:sk-…' | base64)"
export OTEL_LOG_USER_PROMPTS=1 OTEL_LOG_TOOL_DETAILS=1   # opt-in: include prompt/tool text
```

MCP semantic-convention spans are surfaced first-class: `mcp.session.id` maps to the trace
session, and a `tools/call` span is named after the tool (`mcp:<tool>`, or `mcp:<method>` for
`tools/list` / `resources/read` / `prompts/get`) so MCP calls appear in the trace waterfall
and the by-tool analytics next to other tools. The raw `mcp.*` attributes stay in metadata.

The first-party SDKs pre-wire the endpoint + auth so you don't hand-build the URL/header —
JS `import { memoturnSpanProcessor, memoturnOtlpConfig } from "@memoturn/sdk/otel"`, Python
`from memoturn.otel import span_processor, otlp_config`, and Go `mt.OTLPConfig()` (see
[Go SDK](/sdk-go/#opentelemetry)). All three resolve creds from `MEMOTURN_BASE_URL` /
`MEMOTURN_PUBLIC_KEY` / `MEMOTURN_SECRET_KEY` (or explicit args); the OTel exporter packages
are optional peer deps used only by these helpers.

## OpenAI

- **TypeScript:** `wrapOpenAI(new OpenAI(), mt)` — see [TS SDK](/sdk-typescript/).
- **Python:** `wrap_openai(OpenAI())` — see [Python SDK](/sdk-python/).

Each `chat.completions.create` and `responses.create` (the Responses API) is recorded as a
generation with model, params, usage, latency, and errors.

### Azure OpenAI

The same wrappers work unchanged with Azure clients — `AzureOpenAI` shares the OpenAI
client surface:

- **TypeScript:** `wrapOpenAI(new AzureOpenAI({ endpoint, apiKey, apiVersion, deployment }), mt)`
- **Python:** `wrap_openai(AzureOpenAI(azure_endpoint=..., api_key=..., api_version=...))`

Cost note: prices are matched on the recorded **model name**, and Azure reports your
*deployment* name. Deployments named after the base model (`gpt-4o`, `gpt-4o-mini`, …)
price correctly out of the box; custom deployment names need a per-project price override
(Settings → Model Pricing) — pattern-match the deployment name to the base model's price.
Azure spans arriving via OpenTelemetry (e.g. openllmetry) are also handled by the generic
`gen_ai.*` mapping above.

## Anthropic

- **TypeScript:** `wrapAnthropic(new Anthropic(), mt)` — `import … from "@memoturn/sdk/anthropic"`.
- **Python:** `wrap_anthropic(Anthropic())`.

`messages.create` is recorded as a generation, streaming included — streamed deltas are
accumulated so the final text lands on the observation rather than an empty output. Prompt
caching is captured as its own token split (`cacheReadTokens` / `cacheCreationTokens`), which
is what makes the cache-hit ratio visible in the trace view.

## Amazon Bedrock

- **TypeScript:** `wrapBedrock(new BedrockRuntimeClient({ region }), mt)`.
- **Python:** `wrap_bedrock(boto3.client("bedrock-runtime"))`.

Wraps the `Converse` and `ConverseStream` APIs, so any model behind Bedrock (Anthropic,
Llama, Mistral, Cohere, Titan) is recorded through one code path with usage and cache tokens
mapped from Bedrock's response shape.

## Google Gemini

- **TypeScript:** `wrapGemini(new GoogleGenAI({ apiKey }), mt)`.
- **Python:** `wrap_gemini(genai.Client())`.

`generate_content` and `generate_content_stream` become generations, with generation config
recorded as model parameters and Gemini's `usageMetadata` mapped onto the token split.

## Groq, Mistral, and Cohere

- **TypeScript:** `wrapGroq(...)`, `wrapMistral(...)`, `wrapCohere(...)`.
- **Python:** `wrap_groq(...)`, `wrap_mistral(...)`, `wrap_cohere(...)`.

Each wraps that provider's chat/completion entry point (streaming included) into generations
with the provider's own usage fields mapped onto the standard token split.

## OpenAI-compatible endpoints (vLLM, Ollama, OpenRouter)

Anything that speaks the OpenAI wire protocol works through the OpenAI wrapper — point the
client at your base URL and wrap it as usual. Because prices are matched on the recorded
model name, self-hosted or aliased model names need a per-project price override (Settings →
Model Pricing) to show non-zero cost; token counts and latency are recorded either way.

## LangChain

- **JS:** `new MemoturnCallback(mt)` passed in `callbacks`.
- **Python:** `MemoturnCallbackHandler()` passed in `config={"callbacks": [...]}`.

Chains, LLM/chat calls, and tools are recorded as a flat trace tree (one trace per
handler, siblings — LangChain's `parent_run_id` isn't used for nesting).

## LangGraph

- **Python:** `make_langgraph_handler()` passed in `config={"callbacks": [...]}`.

Graph execution is recorded with each node as its own observation, so a multi-step agent
shows up as the graph it actually is instead of one opaque call. Pairs with the **agent
graph** view in the console. Python only.

## LlamaIndex

- **Python:** `MemoturnLlamaIndexHandler()` passed to `CallbackManager([...])`.

Query/retrieve/synthesize/LLM/tool/agent steps are recorded as a properly nested
trace tree (using LlamaIndex's own parent ids), including retrieved documents and
embedding vectors, with one trace per top-level operation. Python only.

## CrewAI

- **Python:** `instrument_crewai()` — call once at startup; no per-crew wiring.

Agent and task execution is recorded with per-step usage, so a crew's cost is attributable to
the agent that spent it. Python only.

## Haystack

- **Python:** `MemoturnHaystackTracer()` registered as Haystack's tracer.

Pipeline components become observations; generator components are recorded as generations
with model + usage, and retriever components carry their retrieved documents. Content
capture follows Haystack's own `HAYSTACK_CONTENT_TRACING_ENABLED` setting. Python only.

## LiteLLM

Use LiteLLM's custom callback to forward to `/v1/ingest` (adapter under
`integrations/litellm`), or route LiteLLM through its OTel exporter into the OTel
receiver above.

## Vector stores (Pinecone, Chroma, Weaviate, Qdrant)

- **TypeScript:** `wrapPinecone`, `wrapChroma`, `wrapWeaviate`, `wrapQdrant`.
- **Python:** `wrap_pinecone`, `wrap_chroma`, `wrap_weaviate`, `wrap_qdrant`.

Each wraps the client's query method so a lookup is recorded as a **RETRIEVER** observation
carrying the retrieved documents — id, similarity score, rank, and content — as queryable
rows rather than a blob of JSON. That is what powers retrieval-quality evaluators
(context relevance / recall / precision) and the **Retrieval** view in the console, which
aggregates across traces: a similarity histogram, the weakest retrievals worst-first, and
per-document hit stats (`GET /v1/retrieval/analytics`).

Where the client exposes the query vector, it is captured as the span's embedding (truncated
to a bounded dimension), feeding semantic trace search and the embeddings projection view.
Content extraction is overridable per call when your documents don't use a conventional
text field.

## Model Context Protocol (MCP)

- **Client side — TypeScript:** `wrapMcpClient(client, mt)`; **Python:** `wrap_mcp_client(session)`.
  Every `callTool` is recorded as a TOOL observation (tool name + arguments in, result content
  out; `isError` and thrown errors mapped to level ERROR).
- **Server side — TypeScript:** `wrapMcpServer(server, mt)` wraps `registerTool` (and the legacy
  `tool()` overload), so every registered handler is traced when invoked without touching each
  handler. The TypeScript MCP SDK has no built-in tracing, so this is genuinely additive; the
  Python MCP SDK already auto-traces via OpenTelemetry, so point it at the OTel receiver instead.

MCP spans arriving over OpenTelemetry are also mapped first-class — see the semantic-convention
note in the Claude Code section above.

Memoturn is *also* an MCP server itself (prompts, datasets, and review queues as agent tools) —
that's a different thing, documented in the [MCP server docs](/mcp/).

## Anything else

Send batched events directly to `POST /v1/ingest` (see the [API reference](/api/) and
the event contracts in `packages/core/src/events.ts`).
