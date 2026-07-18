# Changelog

## Unreleased

### Features

- `wrapGemini` (`@memoturn/sdk/gemini`): drop-in wrapper for the Google Gemini SDK's `models.generateContent` and `models.generateContentStream` — records generations with model, `config` (minus `systemInstruction`, promoted into `input`) as `modelParameters`, output, and usage mapped from `usageMetadata` (incl. `cachedContentTokenCount` as `cacheReadTokens`). Streaming (a separate always-streaming method, unlike OpenAI/Anthropic's `stream: true` flag) yields each full response chunk unchanged while concatenating `.text` deltas into `output` and taking the latest non-null `.usageMetadata`.
- `wrapPinecone` (`@memoturn/sdk/pinecone`): drop-in wrapper for a Pinecone data-plane index handle's `.query()` — records a `RETRIEVER` span with the query vector as `embedding` and matches mapped to `retrievedDocuments`. Document `content` (required by the schema but absent from Pinecone's response) is extracted best-effort from match `metadata` (`text`/`content`/`page_content`, else stringified), overridable via `{ getContent }`. `.namespace(ns)` is recursively re-wrapped so namespaced queries are instrumented too.
- Streaming capture for `wrapOpenAI` and `wrapAnthropic`: `stream: true` calls are now recorded as generations. Chunks/events are still yielded to the caller in real time (no buffering, no added latency) via a new internal `tapStream` helper, while content/tool-call/thinking deltas and the final usage are accumulated into the same output/usage shape as a non-streaming call. `stream_options.include_usage` is auto-injected for OpenAI chat completions when the caller didn't set one. A generation is closed as `WARNING` (not `ERROR`) when the caller stops consuming a stream early (`break`, or an idle-timeout backstop — default 120s, `{ streamTimeoutMs }`) instead of exhausting it. `wrapOpenAI` and `wrapAnthropic` both gained a `streamTimeoutMs` option.
- `runGuarded` (+ `GuardrailBlockedError`, `OnGuardFailure`) in `@memoturn/sdk/guardrails` (also exported from the barrel): run a function, scan its resolved value with `checkGuardrails`, and apply block/pass semantics — default `onFailure: "raise"` throws `GuardrailBlockedError`, or opt into `"log"` / `{ fallback }`. Compose two calls to guard input and output separately.
- `setTraceContext` in `@memoturn/sdk/observe`: update the current trace's `userId`/`sessionId`/`tags`/`metadata` from anywhere inside an active `observe()` call stack without holding a trace/span reference. No-op with a `console.warn` outside an active `observe()` context.
- `wrapMcpClient` / `wrapMcpServer` (`@memoturn/sdk/mcp`): auto-instrumentation for `@modelcontextprotocol/sdk`. `wrapMcpClient` records each `.callTool()` call as a TOOL observation (tool name + arguments as input, result `content` as output; `isError`/thrown errors mapped to ERROR). `wrapMcpServer` intercepts `.registerTool()`/the legacy `.tool()` overload so every registered handler is automatically wrapped as a TOOL observation when invoked — genuinely additive since, unlike the Python MCP SDK, the TypeScript MCP SDK has no built-in tracing.

### Fixes

- `wrapAnthropic` no longer passes streaming calls through unrecorded (previous limitation, documented in 0.3.0).

## 0.3.0 — 2026-07-17

### Features

- `wrapAnthropic` (`@memoturn/sdk/anthropic`): drop-in wrapper for the Anthropic SDK's `messages.create` — records generations with model, allowlisted params, output, and usage including prompt-cache tokens. Streaming calls pass through unrecorded.
- `observe` / `configure` / `getClient` (`@memoturn/sdk/observe`, Node-only): higher-order function auto-instrumentation — the outermost observed call opens a trace, nested observed calls become child spans (via `AsyncLocalStorage`); supports sync and async functions and `asType: "generation"`.
- `MemoturnSpan.generation()` and `MemoturnSpan.event()`: nested child generations and point-in-time events under any span.
- `evaluateGate` (+ `GateResult`, `GateThreshold` types): CI quality gate for dataset runs — `POST /v1/datasets/{name}/runs/{runName}/gate` with per-score `min`/`max`/`maxRegression` thresholds and an optional `baselineRun`.
- `Usage.cacheReadTokens` / `Usage.cacheCreationTokens` for prompt-cache accounting; `TraceInput.public` for shareable traces; `ScoreInput.configId` to link scores to evaluator configs.
- Package: subpath exports for `./anthropic`, `./observe`, `./prompt`, `./dataset`, `./guardrails`; optional `@anthropic-ai/sdk` peer dependency; `engines.node >= 18`; LICENSE shipped in the npm tarball.

### Fixes — transport hardening

- Default base URL corrected to the API port (`:3001`; `:3000` is the console) in the client and `getPrompt`.
- Per-trace environment fixed: child observations now inherit the trace's environment, not the client default.
- 10s request timeout (`AbortSignal.timeout`) on every HTTP call, configurable.
- Retry classification: network/5xx/408/429 re-buffer; other 4xx drop the batch (no more permanent-reject retry loops).
- Buffer capped at `maxBufferSize` (default 10k, `MEMOTURN_MAX_BUFFER_SIZE`) with drop-oldest on re-buffer overflow.
- Background/size-trigger/exit flushes never throw (no unhandled rejections); shared process `beforeExit` flush hook.
- `mask` option: redaction hook applied to input/output/metadata of every event at enqueue time.
- Warn once on cleartext http to non-local hosts (`allowInsecureHttp` / `MEMOTURN_ALLOW_HTTP=1` to opt out) and on empty API keys.
- Server error bodies truncated to 200 chars in thrown errors.
