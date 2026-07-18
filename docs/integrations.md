# Integrations

memoturn ingests from any source that can speak its batched `/v1/ingest` API or
OpenTelemetry. All paths funnel through the same pipeline → Doris.

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
Kernel, etc.). OTLP/protobuf support is planned.

MCP semantic-convention spans are surfaced first-class: `mcp.session.id` maps to the trace
session, and a `tools/call` span is named after the tool (`mcp:<tool>`, or `mcp:<method>` for
`tools/list` / `resources/read` / `prompts/get`) so MCP calls appear in the trace waterfall
and the by-tool analytics next to other tools. The raw `mcp.*` attributes stay in metadata.

The first-party SDKs pre-wire the endpoint + auth so you don't hand-build the URL/header —
JS `import { memoturnSpanProcessor, memoturnOtlpConfig } from "@memoturn/sdk/otel"`, Python
`from memoturn.otel import span_processor, otlp_config`, and Go `mt.OTLPConfig()` (see
[Go SDK](./sdk-go.md#opentelemetry)). All three resolve creds from `MEMOTURN_BASE_URL` /
`MEMOTURN_PUBLIC_KEY` / `MEMOTURN_SECRET_KEY` (or explicit args); the OTel exporter packages
are optional peer deps used only by these helpers.

## OpenAI

- **TypeScript:** `wrapOpenAI(new OpenAI(), mt)` — see [TS SDK](./sdk-typescript.md).
- **Python:** `wrap_openai(OpenAI())` — see [Python SDK](./sdk-python.md).

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
`integrations/litellm`), or route LiteLLM through its OTel exporter into the OTel
receiver above.

## Anything else

Send batched events directly to `POST /v1/ingest` (see the [API reference](./api.md) and
the event contracts in `packages/core/src/events.ts`).
