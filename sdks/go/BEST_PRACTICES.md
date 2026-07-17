# Go SDK — production best practices

Guidance for running the memoturn Go SDK in production. Everything here is grounded in the actual implementation (`client.go`) — behaviors are described as they are coded, not as aspirations.

## Credentials & transport

- Use **HTTPS** and pass keys via the environment (`MEMOTURN_PUBLIC_KEY` / `MEMOTURN_SECRET_KEY`), not hardcoded strings. `New()` picks them up automatically.
- The client warns **once per origin** when it would send API keys over cleartext `http` to a non-local host (`localhost`/`127.0.0.1`/`::1` are exempt). Plain-http LAN self-hosted deployments are legitimate — silence the warning deliberately with `WithAllowInsecureHTTP()` or `MEMOTURN_ALLOW_HTTP=1`, never by ignoring it.
- With no keys configured at all, `New` logs a warning and every ingest request will be unauthorized — the SDK never panics over missing config.

## Always `defer Shutdown()`

Go has no reliable process-exit hook, so the SDK cannot flush automatically when your program ends. `Shutdown` stops the background timer and flushes the remaining buffer:

```go
mt := memoturn.New()
defer mt.Shutdown()
```

Without it, up to `flushInterval` (default 5s) of trailing events — often the most interesting ones, right before a crash or exit — are silently lost. In short-lived jobs (CLIs, Lambdas, cron), call `Shutdown` (or at least `Flush`) explicitly before returning.

## Buffering, batching & failure semantics

How the pipeline behaves under failure (all in `Flush`/`enqueue`/`rebuffer`):

- Events buffer in memory and flush when the buffer reaches `WithFlushAt` (default 20, single-flight background flush) or every `WithFlushInterval` (default 5s).
- **Transient failures** — network errors, 5xx, 408, 429 — re-buffer the batch ahead of newer events; the next flush retries it. Nothing is lost while the buffer has room.
- **Permanent rejects** — any other 4xx (400, 401, 403…) — drop the batch with a log line. Retrying a bad request or bad credentials can never succeed, so the SDK refuses to retry-loop on them.
- **Schema rejects** inside a 207 response are logged and *not* retried (a schema rejection is permanent); the rest of the batch is accepted.
- The buffer is capped at `WithMaxBufferSize` (default 10 000, `MEMOTURN_MAX_BUFFER_SIZE`). When full, **new events are dropped** with a one-time warning; when a re-buffered failed batch overflows the cap, the **oldest events are dropped** first. Size the cap for your worst-case outage window: `events/sec × acceptable outage seconds`, bounded by memory (each buffered event holds its full input/output payloads).
- `Flush` returns an error you can act on; the background timer only logs. If delivery matters at a specific point (end of a batch job, before gating CI), call `Flush()` and check the error.

## Mask PII before it leaves the process

`WithMask` runs over the `input`, `output`, and `metadata` fields of every event **before buffering**, so raw values never sit in memory queues or hit the wire:

```go
mt := memoturn.New(memoturn.WithMask(func(field string, v any) any {
	if field == "input" || field == "output" {
		return redactPII(v) // your redaction logic
	}
	return v
}))
```

If the mask function panics, the SDK substitutes the sentinel `"<memoturn: mask error>"` — the event is kept, and the unmasked value is never sent. Prefer masking in the SDK over server-side guardrails when the data must not leave your process at all; use `CheckGuardrails` for runtime allow/redact/block decisions on user input.

## Timeouts & the HTTP client

The default `*http.Client` has a 10s timeout — sane for batched telemetry. Tune it (proxies, custom TLS, tighter deadlines) with `WithHTTPClient`:

```go
mt := memoturn.New(memoturn.WithHTTPClient(&http.Client{Timeout: 3 * time.Second}))
```

Note the same client is used by the synchronous helpers (`GetPrompt`, datasets, `CheckGuardrails`) — if those sit on your request path (e.g. a guardrail check before every LLM call), set a timeout you can afford there, and remember a timeout during ingest counts as transient (the batch re-buffers).

## Environments

Set the deployment environment once on the client (`WithEnvironment("production")` or `MEMOTURN_ENVIRONMENT`), and override per trace when one service handles mixed traffic:

```go
tr := mt.Trace(memoturn.TraceInput{Name: "replay", Environment: "staging"})
```

The trace handle carries the resolved environment, so all child spans, generations, events, and scores are tagged consistently — you never mix environments inside one trace.

## Agentic traces

Use the typed helpers so the console renders the right tree: `tr.Tool(...)`/`tr.Agent(...)` (and the same on `*Span` for nesting) classify observations as TOOL/AGENT; `span.Generation(...)` nests LLM calls under the step that made them; `span.Event(...)` records point-in-time markers. For retrieval pipelines, set `SpanInput.ObservationType` explicitly (`ObservationTypeRetriever`, `ObservationTypeReranker`, `ObservationTypeEmbedding`, `ObservationTypeChain`, `ObservationTypeGuardrail`) and attach `RetrievedDocuments` to retriever spans.

## Gate quality in CI

Record an experiment run per pipeline execution and let the server enforce thresholds — the pipeline fails on regression, not on vibes:

```go
res, err := mt.EvaluateGate("qa-golden", runName, map[string]memoturn.GateThreshold{
	"faithfulness": {Min: memoturn.Float(0.8)},
	"quality":      {MaxRegression: memoturn.Float(0.05)},
}, "main")
if err != nil {
	log.Fatal(err)
}
if !res.Passed {
	log.Fatalf("quality gate failed: %v", res.Failures)
}
```

`Flush()` (and check its error) before `RecordRun`/`EvaluateGate`, so the traces you link actually reached the server.

## Concurrency

- `Client` is safe for concurrent use from any number of goroutines; one client per process is the intended shape (per-trace state lives in the returned handles, not the client).
- `Flush` is safe to call concurrently; each call drains whatever is buffered at that moment.
- Size-triggered background flushes are **single-flight**: at most one flush goroutine runs at a time no matter how fast events arrive, so bursty traffic can't stampede the API.
- `Shutdown` is idempotent (`sync.Once` on the stop signal) — calling it twice is harmless.
