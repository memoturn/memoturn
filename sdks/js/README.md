# @memoturn/sdk

JavaScript/TypeScript SDK for [memoturn](https://github.com/memoturn/memoturn) — open-source LLM
observability, evals, prompts, and metrics. Trace LLM calls, wrap the OpenAI and Anthropic SDKs,
hook into LangChain, auto-instrument functions, fetch deployed prompts, and gate CI on eval
scores. Zero runtime dependencies. Node ≥ 18.

## Install

```bash
npm install @memoturn/sdk
# provider wrappers are optional peers
npm install openai                       # for wrapOpenAI
npm install @anthropic-ai/sdk            # for wrapAnthropic
npm install @google/genai                # for wrapGemini
npm install @pinecone-database/pinecone  # for wrapPinecone
npm install @aws-sdk/client-bedrock-runtime  # for wrapBedrock
npm install @modelcontextprotocol/sdk    # for wrapMcpClient / wrapMcpServer
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
| `@memoturn/sdk` | `Memoturn` client + types, `wrapOpenAI`, `MemoturnCallback`, `getPrompt`/`compilePrompt`, datasets (`createDataset`, `addDatasetItems`, `getDataset`, `evaluateGate`), `checkGuardrails`, `runGuarded`, `GuardrailBlockedError` |
| `@memoturn/sdk/openai` | `wrapOpenAI` |
| `@memoturn/sdk/anthropic` | `wrapAnthropic` |
| `@memoturn/sdk/gemini` | `wrapGemini` |
| `@memoturn/sdk/pinecone` | `wrapPinecone` |
| `@memoturn/sdk/bedrock` | `wrapBedrock` |
| `@memoturn/sdk/mcp` | `wrapMcpClient`, `wrapMcpServer` |
| `@memoturn/sdk/langchain` | `MemoturnCallback` |
| `@memoturn/sdk/otel` | `memoturnOtlpConfig`, `memoturnTraceExporter`, `memoturnSpanProcessor` |
| `@memoturn/sdk/observe` | `observe`, `configure`, `getClient`, `setTraceContext` — **Node-only**, not in the barrel |
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

// Streaming is recorded too — chunks are still yielded to you in real time (no buffering);
// content/tool-call deltas and the final usage chunk are accumulated into one generation.
const stream = await openai.chat.completions.create({ model: "gpt-4o", messages, stream: true });
for await (const chunk of stream) {
  /* consume as usual */
}
```

Pass `{ trace }` to nest calls under an existing trace; otherwise each call gets its own. Pass
`{ streamTimeoutMs }` to override the idle-stream abandonment backstop (default 120s) — if the
caller stops consuming a stream without a `break`/error (e.g. an unhandled promise), the
generation is closed as `WARNING` once the stream goes idle that long.

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
`cache_creation_input_tokens`. Streaming calls (`stream: true`) are recorded too: text,
tool-use `input_json_delta`, and thinking/signature deltas are accumulated per content block
(same shape as `result.content`) while every event is still yielded to the caller in real time
— no buffering, no added latency. `{ streamTimeoutMs }` overrides the idle-stream abandonment
backstop (default 120s).

## Gemini wrapper

```ts
import { GoogleGenAI } from "@google/genai";
import { wrapGemini } from "@memoturn/sdk/gemini";

const gemini = wrapGemini(new GoogleGenAI({ apiKey }), memoturn);
await gemini.models.generateContent({ model: "gemini-2.5-flash", contents, config: { temperature: 0.2 } });

// Streaming is a completely separate, always-streaming method (no `stream: true` flag) —
// each yielded chunk is a full response object; `.text` deltas are concatenated for `output`.
const stream = await gemini.models.generateContentStream({ model: "gemini-2.5-flash", contents });
for await (const chunk of stream) {
  /* consume as usual */
}
```

Records `generateContent`/`generateContentStream` as generations — model, `config` minus
`systemInstruction` as `modelParameters` (everything else in `config`, mirroring OpenAI's
exclusion approach rather than an allowlist, since Gemini's config surface is large and
evolving), `systemInstruction` + `contents` as input (or bare `contents` when there's no system
instruction), and usage mapped from `usageMetadata` (`promptTokenCount`/`candidatesTokenCount`,
with `cachedContentTokenCount` included as `cacheReadTokens` when reported). Streaming chunks
are yielded to the caller unchanged in real time; `.text` deltas are concatenated into `output`
and the latest non-null `.usageMetadata` is taken as-is (Gemini's usage is cumulative, not
per-chunk). `{ streamTimeoutMs }` overrides the idle-stream abandonment backstop (default 120s).

`wrapGemini` also covers **Vertex AI** — no separate wrapper needed. `@google/genai` is a
unified client for both the direct Gemini API and Vertex AI:
`new GoogleGenAI({ vertexai: true, project, location })` is the same `GoogleGenAI` class with
the identical `models.generateContent`/`.generateContentStream` methods, so a Vertex-mode
client gets full tracing with zero code changes.

## Pinecone wrapper

```ts
import { Pinecone } from "@pinecone-database/pinecone";
import { wrapPinecone } from "@memoturn/sdk/pinecone";

const pc = new Pinecone({ apiKey });
const index = wrapPinecone(pc.index("my-index"), memoturn);
await index.query({ vector: queryEmbedding, topK: 5 });

// `.namespace(ns)` returns a new index-like object — the wrapper re-wraps it recursively so
// namespaced queries are instrumented too, with the namespace recorded on the span.
await index.namespace("prod").query({ vector: queryEmbedding, topK: 5 });
```

Wraps the **data-plane index handle** returned by `pinecone.index(name)` — not the
control-plane client (`createIndex`/`listIndexes`). Each `.query()` call is recorded as a
`RETRIEVER` span: the query vector as `embedding` (truncated to 4096 dims), and `matches` as
`retrievedDocuments`. Pinecone's matches never include the original document text (only
`id`/`score`/optional `metadata`), but memoturn's `retrievedDocument.content` is required — the
wrapper extracts it **best-effort** from `metadata` (`text`, `content`, then `page_content`, in
that order), falling back to the stringified metadata if none match. Pass `{ getContent }` to
override the extraction for a non-standard metadata schema:

```ts
const index = wrapPinecone(pc.index("my-index"), memoturn, {
  getContent: (match) => match.metadata?.body,
});
```

## Bedrock wrapper

```ts
import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import { wrapBedrock } from "@memoturn/sdk/bedrock";

const bedrock = wrapBedrock(new BedrockRuntimeClient({ region: "us-east-1" }), memoturn);
await bedrock.send(
  new ConverseCommand({
    modelId: "anthropic.claude-3-5-sonnet-20241022-v2:0",
    messages: [{ role: "user", content: [{ text: "2+2?" }] }],
    inferenceConfig: { maxTokens: 64, temperature: 0.2 },
  }),
);
```

**Only the standardized `Converse`/`ConverseStream` API is covered** — this is a stated
limitation, not a silent gap. `InvokeModel`/`InvokeModelWithResponseStream` use a raw,
per-model-family request/response body (Anthropic-on-Bedrock, Titan, Llama, … each shaped
differently) and are out of scope; calls using those commands (or any other Bedrock/AWS
command) pass straight through the wrapper completely untouched.

AWS SDK v3 routes every operation through a single `client.send(command)` call — there's no
`client.converse(...)` method to intercept like the other wrappers in this package. `wrapBedrock`
proxies `.send` and checks `command.constructor.name` (`"ConverseCommand"` /
`"ConverseStreamCommand"`) to decide whether to instrument a call; it never imports
`@aws-sdk/client-bedrock-runtime`.

Records `modelId` as `model`, provider `"bedrock"`, allowlisted `inferenceConfig` params
(`maxTokens`, `temperature`, `topP`, `stopSequences`) as `modelParameters`, `system` + `messages`
as input (mirroring the Anthropic wrapper's own system+messages shape, or bare `messages` when
there's no system prompt), `output.message` as output, and usage mapped from Bedrock's
`inputTokens`/`outputTokens`/`totalTokens` (incl. `cacheReadInputTokens`/`cacheWriteInputTokens`
as `cacheReadTokens`/`cacheCreationTokens` when reported). `ConverseStreamCommand` calls are
recorded too: `contentBlockStart`/`contentBlockDelta` events are accumulated per content-block
index (text deltas concatenated, other delta shapes like `toolUse` merged as-is) while every
event is still yielded to the caller in real time — no buffering, no added latency; final usage
is taken from the stream's `metadata` event. `{ streamTimeoutMs }` overrides the idle-stream
abandonment backstop (default 120s).

## MCP

Two independent wrappers for `@modelcontextprotocol/sdk` — the official TypeScript MCP SDK.
Both are duck-typed (no hard dependency on the SDK) and produce `TOOL` observations via
`.tool()`.

**`wrapMcpClient`** — for apps that *call* tools via an MCP `Client`:

```ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { wrapMcpClient } from "@memoturn/sdk/mcp";

const client = wrapMcpClient(new Client({ name: "my-app", version: "1.0.0" }), memoturn);
await client.connect(transport);
await client.callTool({ name: "get-weather", arguments: { city: "SF" } });
```

Each `.callTool()` call is recorded as a TOOL observation: the tool name + `arguments` as
input, the result's `content` as output. MCP signals tool-level failure via `result.isError`
(not a thrown error) — that case marks the observation ERROR without rethrowing; a
transport-level throw marks it ERROR and rethrows.

**`wrapMcpServer`** — for apps that *implement* an MCP server via `McpServer`:

```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { wrapMcpServer } from "@memoturn/sdk/mcp";

const server = wrapMcpServer(new McpServer({ name: "my-server", version: "1.0.0" }), memoturn);
server.registerTool("get-weather", { description: "...", inputSchema: {...} }, async (args) => {
  return { content: [{ type: "text", text: `sunny in ${args.city}` }] };
});
```

`wrapMcpServer` intercepts tool *registration* (`.registerTool()`, and the deprecated
`.tool()` overload) so every registered handler is automatically wrapped — no need to
instrument each tool by hand. Unlike the Python MCP SDK, which auto-traces via
OpenTelemetry out of the box, the TypeScript MCP SDK has no built-in tracing at all, so this
is genuinely additive. Both wrappers accept `{ trace }` to nest under an existing trace;
otherwise each call/invocation gets its own trace (`mcp.client` / `mcp.server`, override via
`{ traceName }`).

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

Call `setTraceContext` from anywhere inside an active `observe()` call stack to stamp
`userId`/`sessionId`/`tags`/`metadata` on the current trace, without threading a trace/span
reference through your call stack:

```ts
import { setTraceContext } from "@memoturn/sdk/observe";

const answer = observe(async function answer(question: string, userId: string) {
  setTraceContext({ userId, sessionId: currentSessionId() });
  return callModel(question);
});
```

It has the same patch semantics as `MemoturnTrace.update()` (fields you omit keep their
previous value); it's a no-op with a `console.warn` outside any active `observe()` context, and
never throws. Manual `.trace()`/`.span()` code already holds a trace handle and should call
`trace.update(...)` directly instead.

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

`runGuarded` wraps that check/block decision around a function call — compose two calls to
guard both input and output:

```ts
import { GuardrailBlockedError, runGuarded } from "@memoturn/sdk";

const safeInput = await runGuarded(() => userInput, { creds });
const answer = await runGuarded(() => callModel(safeInput), { creds });
```

`onFailure` controls what happens on a "block" verdict — default `"raise"` throws
`GuardrailBlockedError` (deliberately not swallowed by default: guardrails exist to block).
Pass `"log"` to warn and return the original result, or `{ fallback: value | (verdict) => value }`
for a substitute. A "redact" verdict is returned as-is — content substitution via
`redactedText` stays the caller's/server's decision.

## License

Apache-2.0
