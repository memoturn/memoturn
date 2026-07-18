# Changelog

All notable changes to the memoturn Python SDK.

## Unreleased

### Features

- `wrap_chroma(collection)` / `wrap_weaviate(collection)` / `wrap_qdrant(client)` —
  vector-store retriever wrappers mirroring `wrap_pinecone`: each patched retrieval
  call is recorded as a RETRIEVER span with `retrievedDocuments` (rank/id/score/
  content/metadata), query embeddings truncated to 4096 dims, content clamped to
  16 KB, error paths ending the span with level ERROR, and a `get_content=` override
  for non-standard schemas. Chroma patches `collection.query` (columnar
  arrays-of-arrays response; first query's column recorded; `score = 1 - distance`;
  content from `documents`, else metadata keys, else stringified metadata). Weaviate
  patches the v4 `collection.query` namespace retrieval methods (`near_vector`/
  `near_text`/`hybrid`/`bm25`/`fetch_objects`, whichever exist; score normalized
  higher-is-better from metadata `score`, else `certainty`, else `1 - distance`;
  content from properties). Qdrant patches `client.search` and `client.query_points`
  (bare list vs `.points` response shapes both handled; content from payload). All
  three are duck-typed with no hard dependency — the `chromadb`/`weaviate`/`qdrant`
  extras are discoverability-only.

- `wrap_groq(client)` — drop-in wrapper for a Groq client (`groq` on PyPI): records
  `client.chat.completions.create` as a generation with an exclusion-list
  `modelParameters` (`model`/`messages`/`stream` excluded, everything else passed
  through — matching `wrap_openai`'s philosophy, not Bedrock's small allowlist) and
  usage mapping (`prompt_tokens`/`completion_tokens`/`total_tokens`, no cache-token
  handling — Groq has no prompt caching). Streaming (`stream=True`) accumulates
  `content` deltas and `tool_calls` argument fragments by index the same way
  `wrap_openai`'s chat-completions path does. **This is a dedicated wrapper rather
  than reusing `wrap_openai` on a Groq client because Groq's `create()` has a strict,
  fully-enumerated parameter list with no `stream_options` field and no catch-all
  `**kwargs` — `wrap_openai` unconditionally injects `stream_options` on streaming
  calls, which would raise `TypeError` against a real Groq client.** `wrap_groq` never
  injects it; it only reads `chunk.usage` opportunistically if a chunk happens to
  carry it. Groq has no Responses API, so chat completions is the only surface.
  Duck-typed, no `groq` dependency (`pip install "memoturn[groq]"` is
  discoverability-only).
- `wrap_bedrock(client)` — drop-in wrapper for a boto3 `bedrock-runtime` client:
  records `client.converse` calls as generations (system + messages as input, an
  `inferenceConfig` allowlist — `maxTokens`/`temperature`/`topP`/`stopSequences` — as
  model parameters, usage mapping incl. cache read/write tokens) and independently
  wraps `client.converse_stream` (only if present), accumulating streamed content
  blocks by index the same way `wrap_anthropic` does. **Only the standardized
  Converse API (`converse`/`converse_stream`) is covered — `invoke_model`/
  `invoke_model_with_response_stream` are explicitly out of scope**, since their
  request/response body shape varies per underlying model family (Anthropic-on-Bedrock,
  Titan, Llama, ...) rather than being generic like Converse. Duck-typed, no `boto3`
  dependency (`pip install "memoturn[bedrock]"` is discoverability-only).
- Documentation clarification (no code change): `wrap_gemini` already covers Vertex AI
  — `genai.Client(vertexai=True, project=..., location=...)` is the same client class
  and the same `models.generate_content`/`.generate_content_stream` methods as the
  direct Gemini API, so a Vertex-AI-mode client is traced today with zero new code.
- `make_langgraph_handler()` (`memoturn.langgraph`) — a combined LangChain +
  LangGraph callback handler: inherits `MemoturnCallbackHandler`'s chain/LLM/tool
  recording unchanged, and additionally records `langgraph.interrupt`/
  `langgraph.resume` trace events for LangGraph's own interrupt/resume lifecycle
  callbacks (durable execution + human-in-the-loop), which LangGraph only ever
  dispatches to a real `langgraph.callbacks.GraphCallbackHandler` subclass — never to
  a duck-typed handler. **Requires the real `langgraph` package
  (`pip install "memoturn[langgraph]"`) — unlike every other integration in this SDK,
  this one is a load-bearing dependency, not a cosmetic extra**, since there is no
  duck-typed path to an isinstance-gated callback interface. The import is deferred
  inside the factory function, so `import memoturn` never touches `langgraph`.
- `instrument_crewai()` (`memoturn.crewai`) — registers handlers on CrewAI's
  process-global event bus (`crewai_event_bus`) to record crew kickoffs as traces,
  tasks as `CHAIN` spans, agent execution as `AGENT` observations, tool calls as
  `TOOL` observations, and LLM calls as generations with usage/model parameters —
  nested task → agent → tool/LLM. Call once at process startup, unlike every other
  wrapper in this SDK which wraps a specific client/session instance; CrewAI's event
  bus is a singleton, so there is no per-crew handle to return. **Requires the real
  `crewai` package (`pip install "memoturn[crewai]"`) — unlike every other integration
  in this SDK, this one is a load-bearing dependency, not a cosmetic extra**, since
  CrewAI's typed event-bus system has no duck-typed registration path. The import is
  deferred inside `instrument_crewai()`, so `import memoturn` never touches `crewai`.
- `wrap_mcp_client(session)` — drop-in wrapper for an MCP `ClientSession`
  (`modelcontextprotocol/python-sdk`): records each `call_tool()` call as a `TOOL`
  observation with the arguments as input and the result's `content` as output. A
  result with `isError`/`is_error` set marks the observation `ERROR` without raising
  (MCP signals tool failure via the result shape, not an exception); a raised exception
  also marks `ERROR` and re-raises. Duck-typed, no `mcp` dependency. There is
  deliberately no server-side wrapper — an MCP Python server already emits
  OpenTelemetry spans for `tools/call` by default, which memoturn's OTLP ingestion
  already classifies as `TOOL` observations; see the `## MCP` section of the README for
  how to point that built-in tracing at memoturn with `memoturn.otel.span_processor`.
- `wrap_gemini(client)` — drop-in Gemini wrapper: records `client.models.generate_content`
  as a generation (`systemInstruction` nested alongside `contents` as input, everything
  else in `config` as `modelParameters`, usage incl. cached tokens) and independently
  wraps the always-streaming `client.models.generate_content_stream` — each chunk is a
  full `GenerateContentResponse`, so `.text` is concatenated as a delta while
  `.usage_metadata` takes the latest non-null value instead of being summed. Duck-typed,
  no `google-genai` dependency.
- `wrap_pinecone(index)` — drop-in wrapper for a Pinecone data-plane index handle
  (`pc.Index(name)`): records `index.query()` calls as `RETRIEVER` spans with the query
  vector (truncated to 4096 dims), namespace/topK/filter metadata, and retrieved
  documents. Since Pinecone matches never carry the original chunk text, `content` is
  extracted best-effort from `metadata` (`text`/`content`/`page_content`, else
  stringified metadata) — pass `get_content=` to override for a non-standard schema.
  Duck-typed, no `pinecone` dependency.
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
