# Changelog

## Unreleased

### 0.3.0 — feature parity (P1)

- **Observation taxonomy**: `ObservationType…` constants for all 10 kinds
  (SPAN/GENERATION/EVENT/TOOL/AGENT/RETRIEVER/RERANKER/EMBEDDING/CHAIN/GUARDRAIL),
  `SpanInput.ObservationType` override, and typed helpers `Trace.Tool` / `Trace.Agent` /
  `Span.Tool` / `Span.Agent`.
- **Nesting parity**: `Span.Generation` (nested LLM call with `parentObservationId`) and
  `Span.Event` (nested point-in-time event).
- **Wire-contract fields**: `Usage.CacheReadTokens` / `Usage.CacheCreationTokens`
  (prompt-caching usage), `TraceInput.Public` (`*bool` + `Bool` helper so an explicit
  `false` is sent), `ScoreInput.ConfigID`.
- **Datasets & CI gates** (`dataset.go`): `CreateDataset`, `AddDatasetItems`, `GetDataset`,
  `RecordRun`, and `EvaluateGate` (threshold min/max/maxRegression with optional baseline
  run) — mirrors the Python/JS dataset helpers endpoint-for-endpoint.
- **Runtime guardrails** (`guardrails.go`): `CheckGuardrails` returning an
  allow/redact/block verdict with findings and redacted text.
- **OpenTelemetry** (`otel.go`): `OTLPConfig` returns the OTLP/HTTP endpoint
  (`/v1/otel/v1/traces`) + Basic-auth header to wire into any OTLP span exporter —
  zero-dependency, matching the Python `otlp_config`.

### 0.2.1 — hardening fixes (P0)

- Fix environment mistagging: trace handles now carry the resolved per-trace environment
  (child spans/generations/events/scores previously got the client environment).
- Correct the default base URL to the API port (`:3001`; `:3000` is the console).
- Retry classification: network errors/5xx/408/429 re-buffer for retry; other 4xx
  (400/401) drop the batch — no more retry-forever loops on permanent rejects.
- Size-triggered flushes are single-flight (one goroutine at a time).
- Buffer capped via `WithMaxBufferSize` (default 10k, `MEMOTURN_MAX_BUFFER_SIZE`) with
  drop-oldest on re-buffer overflow.
- `WithMask` redaction hook applied to input/output/metadata before buffering; a panicking
  mask substitutes a sentinel, never the raw value.
- Warn once on cleartext http to non-local hosts (`WithAllowInsecureHTTP` /
  `MEMOTURN_ALLOW_HTTP=1`) and on empty API keys; default HTTP timeout 30s → 10s; error
  bodies truncated to 200 chars.
