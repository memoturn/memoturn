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

The first-party SDKs pre-wire the endpoint + auth so you don't hand-build the URL/header —
JS `import { memoturnSpanProcessor, memoturnOtlpConfig } from "@memoturn/sdk/otel"` and
Python `from memoturn.otel import span_processor, otlp_config`. Both resolve creds from
`MEMOTURN_BASE_URL` / `MEMOTURN_PUBLIC_KEY` / `MEMOTURN_SECRET_KEY` (or explicit args); the
OTel exporter packages are optional peer deps used only by the `span_processor` helpers.

## OpenAI

- **TypeScript:** `wrapOpenAI(new OpenAI(), mt)` — see [TS SDK](./sdk-typescript.md).
- **Python:** `wrap_openai(OpenAI())` — see [Python SDK](./sdk-python.md).

Each `chat.completions.create` is recorded as a generation with model, params, usage,
latency, and errors.

## LangChain

- **JS:** `new MemoturnCallback(mt)` passed in `callbacks`.
- **Python:** `MemoturnCallbackHandler()` passed in `config={"callbacks": [...]}`.

Chains, LLM/chat calls, and tools are recorded as a nested trace tree.

## LiteLLM

Use LiteLLM's custom callback to forward to `/v1/ingest` (adapter under
`integrations/litellm`), or route LiteLLM through its OTel exporter into the OTel
receiver above.

## Anything else

Send batched events directly to `POST /v1/ingest` (see the [API reference](./api.md) and
the event contracts in `packages/core/src/events.ts`).
