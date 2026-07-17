# @memoturn/sdk

JavaScript/TypeScript SDK for [memoturn](https://github.com/memoturn/memoturn) — open-source LLM
observability, evals, prompts, and metrics. Trace LLM calls, wrap the OpenAI and Anthropic SDKs,
hook into LangChain, auto-instrument functions, fetch deployed prompts, and gate CI on eval
scores. Zero runtime dependencies. Node ≥ 18.

## Install

```bash
npm install @memoturn/sdk
# provider wrappers are optional peers
npm install openai            # for wrapOpenAI
npm install @anthropic-ai/sdk # for wrapAnthropic
```

## Quickstart

```ts
import { Memoturn } from "@memoturn/sdk";

const memoturn = new Memoturn({
  baseUrl: "http://localhost:3001",
  publicKey: "pk-mt-...",
  secretKey: "sk-mt-...",
});

const trace = memoturn.trace({ name: "chat", userId: "u_123" });
const gen = trace.generation({ name: "answer", model: "gpt-4o", provider: "openai", input: messages });
gen.end({ output, usage: { promptTokens: 42, completionTokens: 8, totalTokens: 50 } });
trace.score({ name: "helpfulness", value: 0.9, dataType: "NUMERIC" });

await memoturn.shutdown(); // flush before exit
```

The client batches events and flushes on a timer, at `flushAt` events, and on `shutdown()`.
Call `await memoturn.flush()` to push the buffer immediately (e.g. per request in serverless).

## Imports

| Import | Exposes |
| --- | --- |
| `@memoturn/sdk` | `Memoturn` client + types, `wrapOpenAI`, `MemoturnCallback`, `getPrompt`/`compilePrompt`, datasets (`createDataset`, `addDatasetItems`, `getDataset`, `evaluateGate`), `checkGuardrails` |
| `@memoturn/sdk/openai` | `wrapOpenAI` |
| `@memoturn/sdk/anthropic` | `wrapAnthropic` |
| `@memoturn/sdk/langchain` | `MemoturnCallback` |
| `@memoturn/sdk/otel` | `memoturnOtlpConfig`, `memoturnTraceExporter`, `memoturnSpanProcessor` |
| `@memoturn/sdk/observe` | `observe`, `configure`, `getClient` — **Node-only**, not in the barrel |
| `@memoturn/sdk/prompt` / `/dataset` / `/guardrails` | The same prompt/dataset/guardrail helpers as standalone subpaths |

## Client options

All options are optional; keys and URL fall back to env vars.

| Option | Default | Notes |
| --- | --- | --- |
| `baseUrl` | `http://localhost:3001` | The memoturn API |
| `publicKey` / `secretKey` | — | API key pair (Basic auth) |
| `environment` | `"default"` | Stamped on every event; override per trace |
| `flushAt` | `20` | Flush when the buffer reaches this many events |
| `flushInterval` | `5000` | Flush at least this often (ms) |
| `maxBufferSize` | `10000` | Hard cap on buffered events; new events are dropped (one warning) once full |
| `requestTimeout` | `10000` | Per-request timeout (ms) for ingest calls |
| `flushOnExit` | `true` | Best-effort flush on Node `beforeExit` (no-op elsewhere) |
| `allowInsecureHttp` | `false` | Suppress the cleartext-http warning for non-local `http://` hosts |
| `mask` | — | Redaction hook applied to `input`/`output`/`metadata` of every event before buffering |

Environment variables: `MEMOTURN_BASE_URL`, `MEMOTURN_PUBLIC_KEY`, `MEMOTURN_SECRET_KEY`,
`MEMOTURN_ENVIRONMENT`, `MEMOTURN_MAX_BUFFER_SIZE`, `MEMOTURN_ALLOW_HTTP=1`.

## Tracing

Traces hold a tree of observations. Every handle creates children; call `.end()` (with
`output`, and `usage` for generations) when the work completes.

```ts
const trace = memoturn.trace({ name: "support-chat", userId: "u_123", sessionId: "s_9", tags: ["prod"] });

const step = trace.agent({ name: "planner" }); // AGENT-classified span
const search = step.tool({ name: "web-search", input: query }); // nested TOOL span
search.end({ output: results });

const gen = step.generation({ name: "answer", model: "claude-sonnet-4-5", provider: "anthropic", input: msgs });
gen.end({ output: text, usage: { promptTokens: 900, completionTokens: 120, totalTokens: 1020, cacheReadTokens: 700 } });

step.event({ name: "cache-hit", metadata: { layer: "semantic" } }); // point-in-time, no .end()
step.end();

trace.score({ name: "helpfulness", value: 0.9, dataType: "NUMERIC" });
trace.update({ output: finalAnswer });
```

- `trace.span/generation/tool/agent/event/score/update` — root-level children + trace metadata.
- `span.span/generation/tool/agent/event` — nesting; children carry `parentObservationId` automatically.
- Plain spans also record RAG fields: `retrievedDocuments` and `embedding` (see `SpanInput`).
- `usage` supports `cacheReadTokens`/`cacheCreationTokens` for prompt-cache accounting.

## OpenAI wrapper

```ts
import OpenAI from "openai";
import { wrapOpenAI } from "@memoturn/sdk/openai";

const openai = wrapOpenAI(new OpenAI(), memoturn);
// chat completions AND the Responses API are recorded as generations
// (model, params, usage, latency, output)
await openai.chat.completions.create({ model: "gpt-4o", messages });
await openai.responses.create({ model: "gpt-4o", input: "hi" });
```

Pass `{ trace }` to nest calls under an existing trace; otherwise each call gets its own.

## Anthropic wrapper

```ts
import Anthropic from "@anthropic-ai/sdk";
import { wrapAnthropic } from "@memoturn/sdk/anthropic";

const anthropic = wrapAnthropic(new Anthropic(), memoturn);
await anthropic.messages.create({ model: "claude-sonnet-4-5", max_tokens: 1024, messages });
```

Records `messages.create` as a generation — model, allowlisted params (`max_tokens`,
`temperature`, `top_p`, `top_k`, `stop_sequences`), the system prompt + messages as input,
`result.content` as output, and usage including `cache_read_input_tokens` /
`cache_creation_input_tokens`. Streaming calls (`stream: true`) pass through unrecorded.

## LangChain

```ts
import { MemoturnCallback } from "@memoturn/sdk/langchain";

const handler = new MemoturnCallback(memoturn, { traceName: "agent-run" });
await chain.invoke(input, { callbacks: [handler] });
await handler.flush();
```

## observe() — function auto-instrumentation (Node-only)

Wrap any function; the outermost call opens a trace and nested observed calls become child
spans automatically (via `AsyncLocalStorage`, so it works across `await`). Sync and async
functions both work; errors are recorded as `ERROR` and rethrown.

```ts
import { Memoturn } from "@memoturn/sdk";
import { configure, observe } from "@memoturn/sdk/observe";

configure(new Memoturn()); // optional — a default client is built from env vars otherwise

const rerank = observe(async (docs: string[]) => docs.slice(0, 3), { name: "rerank" });
const llm = observe(callModel, { asType: "generation" });

const answer = observe(async function answer(question: string) {
  const docs = await rerank(await retrieve(question)); // child span
  return llm(docs, question); // child generation
});

await answer("why is the sky blue?"); // trace "answer" with nested spans
```

## OpenTelemetry

Already standardized on OpenTelemetry? Keep your instrumentation and point it at memoturn's
OTLP receiver — it maps GenAI semconv (`gen_ai.*`) spans into traces + generations. The helper
pre-wires the endpoint URL + Basic-auth header from your API keys.

```ts
import { NodeSDK } from "@opentelemetry/sdk-node";
import { memoturnSpanProcessor } from "@memoturn/sdk/otel";

// Needs @opentelemetry/exporter-trace-otlp-http + @opentelemetry/sdk-trace-base installed.
const sdk = new NodeSDK({ spanProcessors: [memoturnSpanProcessor()] });
sdk.start();
```

Or dependency-free — hand the config to any OTLP exporter you already use:

```ts
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { memoturnOtlpConfig } from "@memoturn/sdk/otel";

new OTLPTraceExporter(memoturnOtlpConfig()); // { url, headers } from MEMOTURN_* env or args
```

Python: `from memoturn.otel import span_processor, otlp_config` — same shape.

## Prompts

```ts
import { compilePrompt, getPrompt } from "@memoturn/sdk";

const prompt = await getPrompt(memoturn, "support-reply", { channel: "production" });
const messages = compilePrompt(prompt, { customer: "Ada" });
```

Pass `bucketKey` (a stable user/session id) to stick a caller to one arm of an A/B split, and
stamp `prompt.version` on the resulting generation via `promptVersion`.

## Datasets & CI gates

Dataset, prompt, and guardrail helpers take a plain creds object (`{}` uses the
`MEMOTURN_*` env vars).

```ts
import { addDatasetItems, createDataset, evaluateGate, getDataset } from "@memoturn/sdk";

const creds = { publicKey: "pk-mt-...", secretKey: "sk-mt-..." };

await createDataset(creds, "qa", "regression set");
await addDatasetItems(creds, "qa", [{ input: "2+2?", expectedOutput: "4" }]);
const ds = await getDataset(creds, "qa");
await ds.recordRun("baseline", [{ datasetItemId: ds.items[0].id, traceId: trace.id }]);
```

Gate a run's evaluator scores in CI — fail the pipeline when quality drops:

```ts
const gate = await evaluateGate(
  creds,
  "qa",
  "pr-1234",
  { faithfulness: { min: 0.8 }, toxicity: { max: 0.1 }, accuracy: { maxRegression: 0.05 } },
  { baselineRun: "main" }, // required for maxRegression bounds
);
if (!gate.passed) {
  console.error("eval gate failed:", gate.failures);
  process.exit(1);
}
```

## Guardrails

Scan text against the project's runtime guardrails (PII, prompt injection, blocked terms)
before it reaches a model — or before a model's output reaches a user.

```ts
import { checkGuardrails } from "@memoturn/sdk";

const verdict = await checkGuardrails(creds, userInput);
if (verdict.verdict === "block") throw new Error("input blocked by guardrails");
const safeInput = verdict.verdict === "redact" ? verdict.redactedText : userInput;
```

## License

Apache-2.0
