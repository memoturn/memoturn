# Changelog

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
