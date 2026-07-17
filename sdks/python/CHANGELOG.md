# Changelog

All notable changes to the memoturn Python SDK.

## 0.3.0 — 2026-07-17

### Features

- `wrap_anthropic(client)` — drop-in Anthropic wrapper: records `messages.create`
  calls as generations with the system prompt captured alongside messages, a model-
  parameter allowlist (`max_tokens`, `temperature`, `top_p`, `top_k`,
  `stop_sequences`), and usage mapping including cache tokens
  (`cache_read_input_tokens` → `cacheReadTokens`, `cache_creation_input_tokens` →
  `cacheCreationTokens`). Errors mark the generation `ERROR` and re-raise; streaming
  calls (`stream=True`) pass through unrecorded.
- `MemoturnCallbackHandler` is now exported from the package root
  (`from memoturn import MemoturnCallbackHandler`) — it is duck-typed and imports
  no LangChain packages.
- Discoverability extras in `pyproject.toml`: `memoturn[anthropic]`,
  `memoturn[otel]`, `memoturn[langchain]` (runtime dependencies remain empty —
  the SDK stays stdlib-only).

### Fixes — transport hardening

- Transport hardening: `flush()` no longer loses the dequeued batch on network
  errors (`URLError` is caught and the batch re-buffered before re-raising).
- Retry classification: network errors, 5xx, 408, and 429 re-buffer; other 4xx
  are permanent rejects and drop the batch instead of retrying forever.
- 207 partial-failure responses are parsed and rejected events logged (previously
  silently ignored).
- Size-trigger and atexit flushes never raise into user code; diagnostics go to
  the `memoturn` logger; `shutdown()` unregisters the atexit hook.
- Child spans/generations/events/scores inherit the trace's resolved environment
  instead of the client default.
- Event buffer capped at `max_buffer_size` (default 10 000,
  `MEMOTURN_MAX_BUFFER_SIZE`) with drop-oldest on re-buffer overflow.
- New `mask` kwarg: a redaction hook `(value, field, event_type)` applied to
  `input`/`output`/`metadata` at enqueue; a raising mask substitutes a sentinel
  rather than sending the unmasked value.
- Warn once on cleartext http to non-local hosts (`allow_insecure_http` /
  `MEMOTURN_ALLOW_HTTP=1`) and on empty API keys.
- Configurable timeouts (default 10 s) threaded through prompt, dataset, and
  guardrail helpers; server error bodies truncated in raised errors.

## 0.2.0

Initial public release.
