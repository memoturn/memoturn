# Changelog

All notable changes to the memoturn Python SDK.

## Unreleased

### Features

- `wrap_gemini(client)` — drop-in Gemini wrapper: records `client.models.generate_content`
  as a generation (`systemInstruction` nested alongside `contents` as input, everything
  else in `config` as `modelParameters`, usage incl. cached tokens) and independently
  wraps the always-streaming `client.models.generate_content_stream` — each chunk is a
  full `GenerateContentResponse`, so `.text` is concatenated as a delta while
  `.usage_metadata` takes the latest non-null value instead of being summed. Duck-typed,
  no `google-genai` dependency.
- Streaming capture for `wrap_openai` and `wrap_anthropic`: `stream=True` calls are no
  longer a silent passthrough — the returned stream is wrapped so chunks/events forward
  to the caller unchanged while being accumulated into the same output/usage shape a
  non-streaming call produces, and the generation is closed once the stream is
  exhausted, errors, or is abandoned (early `close()`, garbage collection, or idle
  timeout). `wrap_openai` auto-injects `stream_options={"include_usage": True}` on
  chat-completions streams (never overriding an explicit value) so usage is captured;
  the Responses API streaming path watches `response.completed` / `.failed` /
  `.incomplete` events. Mid-stream errors mark the generation `ERROR` with partial
  output and re-raise; abandonment marks it `WARNING` with partial output.
- `run_guarded(fn, *, extract_text=str, on_failure="raise", **creds)` and
  `GuardrailBlockedError`: compose `check_guardrails` around a call instead of
  hand-rolling the check/act pattern. `on_failure` is `"raise"` (default — raises
  `GuardrailBlockedError`), `"log"` (warns and returns the original result), or a
  fallback callable invoked with the verdict.
- `set_trace_context(**kwargs)`: update the current trace's `userId`/`sessionId`/
  `tags`/`metadata` from anywhere inside an active `@observe` call stack, without
  threading a `Trace` handle through the call. No-op (with a warning) outside any
  `@observe` context.
- `MemoturnLlamaIndexHandler`: LlamaIndex callback integration recording
  query/retrieve/synthesize/LLM/tool/agent events with real parent/child nesting (via
  LlamaIndex's own `parent_id`), including retrieved documents and embedding vectors.
  Duck-typed, no llama-index dependency.

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
