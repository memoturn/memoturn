# Go SDK (`github.com/memoturn/memoturn/sdks/go`)

Dependency-free (stdlib only). Install with `go get github.com/memoturn/memoturn/sdks/go`.
Configure via `New(...)` options or the env vars `MEMOTURN_BASE_URL`,
`MEMOTURN_PUBLIC_KEY`, `MEMOTURN_SECRET_KEY`, `MEMOTURN_ENVIRONMENT`,
`MEMOTURN_MAX_BUFFER_SIZE` (buffered-event cap, default 10000), and `MEMOTURN_ALLOW_HTTP`
(suppress the cleartext-http warning for non-local hosts) — options win over env vars.

## Tracing

```go
mt := memoturn.New(
	memoturn.WithBaseURL("http://localhost:3001"),
	memoturn.WithCredentials("pk-mt-dev", "sk-mt-dev"),
)
defer mt.Shutdown() // flush remaining events before exit

tr := mt.Trace(memoturn.TraceInput{Name: "support-chat", UserID: "u_123", SessionID: "s_1"})

gen := tr.Generation(memoturn.GenerationInput{
	Model:     "gpt-4o",
	Provider:  "openai",
	SpanInput: memoturn.SpanInput{Input: "How do I reset my password?"},
})
gen.End(memoturn.GenerationInput{
	SpanInput: memoturn.SpanInput{Output: "Click 'Forgot password'…"},
	Usage:     &memoturn.Usage{PromptTokens: 12, CompletionTokens: 20, TotalTokens: 32},
})

tr.Score(memoturn.ScoreInput{Name: "quality", Value: memoturn.Float(0.9)})
```

The client buffers events and flushes as batches to `POST /v1/ingest` (size-, interval-,
and shutdown-triggered). Spans nest via `span.Span({...})`; `Tool`/`Agent` helpers classify
a span as a TOOL/AGENT observation, and any kind can be set explicitly via
`SpanInput.ObservationType`.

## Prompts

```go
p, err := mt.GetPrompt("support-reply", memoturn.WithBucketKey("s_1")) // A/B-stable bucketing
text := p.CompileText(map[string]any{"name": "Ada"})                  // TEXT prompts
msgs := p.CompileChat(map[string]any{"name": "Ada"})                  // CHAT prompts
```

`GetPrompt` resolves the `"production"` channel by default; pick another with
`memoturn.WithPromptChannel("staging")`.

## Datasets, experiment runs & CI quality gates

```go
mt.CreateDataset("qa-golden", "golden questions")
added, _ := mt.AddDatasetItems("qa-golden", []memoturn.DatasetItem{
	{Input: "What is memoturn?", ExpectedOutput: "An open-source AI engineering platform."},
})

ds, _ := mt.GetDataset("qa-golden")
// … run your model against ds.Items, build []memoturn.RunLink …
mt.RecordRun("qa-golden", "run-42", links, nil)

res, _ := mt.EvaluateGate("qa-golden", "run-42", map[string]memoturn.GateThreshold{
	"faithfulness": {Min: memoturn.Float(0.8)},
	"quality":      {MaxRegression: memoturn.Float(0.05)}, // vs a baseline run
}, "main")
if !res.Passed {
	log.Fatalf("quality gate failed: %v", res.Failures)
}
```

`EvaluateGate` is built for CI: fail the pipeline when a dataset run's evaluator scores
regress past a threshold or baseline.

## Guardrails

```go
v, _ := mt.CheckGuardrails("My email is ada@example.com")
switch v.Verdict {
case "block":
	log.Fatal("input blocked by guardrails")
case "redact":
	fmt.Println("proceeding with redacted input:", v.RedactedText)
}
```

Scans text against the project's runtime guardrails (PII, prompt injection, blocked terms)
before sending user content to an LLM, or before returning a model's output.

## OpenTelemetry

Already instrumented with OTel? `mt.OTLPConfig()` returns the endpoint + Basic-auth header
for the official exporter (`go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp`)
— the SDK itself stays dependency-free.

```go
endpoint, headers := mt.OTLPConfig()
exp, _ := otlptracehttp.New(ctx, otlptracehttp.WithEndpointURL(endpoint), otlptracehttp.WithHeaders(headers))
provider := sdktrace.NewTracerProvider(sdktrace.WithBatcher(exp))
```

No OpenAI-wrapper or LangChain-callback equivalent today (no widely-used Go clients to wrap
the same way as the JS/Python SDKs) — instrument Go LLM calls via `Generation`/`Span` directly,
or via the OTel path above.

See [`sdks/go/README.md`](../sdks/go/README.md) for the full API and
[`BEST_PRACTICES.md`](../sdks/go/BEST_PRACTICES.md) for failure semantics, buffer sizing, and
PII masking.
