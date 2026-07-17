# memoturn Go SDK

Go client for [memoturn](https://memoturn.ai) — LLM observability, evals, prompt management, datasets with CI quality gates, runtime guardrails, and OpenTelemetry export. Dependency-free (stdlib only).

```bash
go get github.com/memoturn/memoturn/sdks/go
```

Every snippet below is doc-tested: each one is compiled as an `Example` function in [`example_test.go`](./example_test.go), so the code you copy actually builds. Production guidance lives in [`BEST_PRACTICES.md`](./BEST_PRACTICES.md).

## Quick start

The client buffers events and flushes them as batches to `POST /v1/ingest`; it handles ids, timestamps, batching, retries, and auth. Create trace/span/generation handles and close them as work completes.

```go
package main

import (
	memoturn "github.com/memoturn/memoturn/sdks/go"
)

func main() {
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
		Usage: &memoturn.Usage{
			PromptTokens: 12, CompletionTokens: 20, TotalTokens: 32,
			CacheReadTokens: 8, // prompt-caching usage (e.g. Anthropic)
		},
	})

	tr.Score(memoturn.ScoreInput{Name: "quality", Value: memoturn.Float(0.9)})
}
```

## Configuration

`New` applies environment-variable defaults first, then options (so options win):

| Option | What it does | Default / env var |
| --- | --- | --- |
| `WithBaseURL(u)` | API base URL | `MEMOTURN_BASE_URL`, else `http://localhost:3001` |
| `WithCredentials(pk, sk)` | API key pair (Basic auth) | `MEMOTURN_PUBLIC_KEY` / `MEMOTURN_SECRET_KEY` |
| `WithEnvironment(env)` | Tags every event with an environment | `MEMOTURN_ENVIRONMENT`, else `"default"` |
| `WithFlushAt(n)` | Flush once the buffer reaches n events | `20` |
| `WithFlushInterval(d)` | Background flush cadence; `0` disables the timer (call `Flush` yourself) | `5s` |
| `WithMaxBufferSize(n)` | Cap on buffered events (drop-with-warning when full) | `MEMOTURN_MAX_BUFFER_SIZE`, else `10000` |
| `WithMask(f)` | Redaction hook over `input`/`output`/`metadata` before buffering | none |
| `WithHTTPClient(h)` | Custom `*http.Client` (timeouts, proxies, TLS) | 10s timeout |
| `WithAllowInsecureHTTP()` | Suppress the cleartext-http-to-non-local-host warning | `MEMOTURN_ALLOW_HTTP=1` |

## Tracing

Observations form a tree under a trace. Beyond `Span`/`Generation`/`Event`, the `Tool` and `Agent` helpers classify a span as a TOOL or AGENT observation for agentic traces, and any kind can be set explicitly via `SpanInput.ObservationType` with the `ObservationType…` constants (`SPAN`, `GENERATION`, `EVENT`, `TOOL`, `AGENT`, `RETRIEVER`, `RERANKER`, `EMBEDDING`, `CHAIN`, `GUARDRAIL`).

```go
tr := mt.Trace(memoturn.TraceInput{Name: "agent-run"})

span := tr.Span(memoturn.SpanInput{Name: "retrieve"})
child := span.Span(memoturn.SpanInput{Name: "vector-search"})
child.End(memoturn.GenerationInput{SpanInput: memoturn.SpanInput{Output: "3 docs"}})
span.End(memoturn.GenerationInput{})

tool := tr.Tool(memoturn.SpanInput{Name: "web-search", Input: "memoturn docs"}) // TOOL observation
tool.End(memoturn.GenerationInput{SpanInput: memoturn.SpanInput{Output: "5 results"}})

agent := tr.Agent(memoturn.SpanInput{Name: "planner"}) // AGENT observation
sub := agent.Generation(memoturn.GenerationInput{Model: "gpt-4o"})
sub.End(memoturn.GenerationInput{})
agent.Event(memoturn.SpanInput{Name: "plan-selected"})
agent.End(memoturn.GenerationInput{})

// Any other observation kind via the ObservationType… constants.
rr := tr.Span(memoturn.SpanInput{Name: "rerank", ObservationType: memoturn.ObservationTypeReranker})
rr.End(memoturn.GenerationInput{})

tr.Event(memoturn.SpanInput{Name: "cache-hit"})
tr.Update(memoturn.TraceInput{Output: "done", Public: memoturn.Bool(true)})
tr.Score(memoturn.ScoreInput{Name: "helpfulness", Value: memoturn.Float(1), ObservationID: sub.ID})
```

Notes:

- `Trace.Update` patches trace fields; `TraceInput.Public` is a `*bool` (use `memoturn.Bool`) so an explicit `false` is sent to un-share a trace.
- `Score` attaches to the trace, or to a specific observation via `ScoreInput.ObservationID`; `ScoreInput.ConfigID` links it to a score config.
- A per-trace environment overrides the client default and propagates to all children: `mt.Trace(memoturn.TraceInput{Environment: "staging"})`.

## Prompts

Fetch a deployed prompt by channel and compile its `{{variables}}`. For channels running an A/B split, pass `WithBucketKey` (a stable session/user id) to keep a caller on one arm; stamp the returned version back on the generation for per-arm attribution. Needs `fmt` and `log` imported.

```go
p, err := mt.GetPrompt("support-reply", memoturn.WithBucketKey("s_1"))
if err != nil {
	log.Fatal(err)
}
text := p.CompileText(map[string]any{"name": "Ada"}) // TEXT prompts
msgs := p.CompileChat(map[string]any{"name": "Ada"}) // CHAT prompts → []{role, content}
_ = msgs

gen := tr.Generation(memoturn.GenerationInput{
	Model:         "gpt-4o",
	PromptID:      p.Name,
	PromptVersion: fmt.Sprintf("%d", p.Version), // links the generation to the resolved A/B arm
	SpanInput:     memoturn.SpanInput{Input: text},
})
gen.End(memoturn.GenerationInput{})
```

`GetPrompt` resolves the `"production"` channel by default; pick another with `memoturn.WithPromptChannel("staging")`.

## Datasets & experiment runs

Create datasets of golden examples, link each item to the trace your model produced for it, and record the run. Needs `log` imported.

```go
if err := mt.CreateDataset("qa-golden", "golden questions"); err != nil {
	log.Fatal(err)
}
added, err := mt.AddDatasetItems("qa-golden", []memoturn.DatasetItem{
	{Input: "What is memoturn?", ExpectedOutput: "An open-source AI engineering platform."},
	{Input: "Which port does the API use?", ExpectedOutput: "3001", Metadata: map[string]any{"difficulty": "easy"}},
})
if err != nil {
	log.Fatal(err)
}

ds, err := mt.GetDataset("qa-golden")
if err != nil {
	log.Fatal(err)
}
links := make([]memoturn.RunLink, 0, len(ds.Items))
for _, item := range ds.Items {
	tr := mt.Trace(memoturn.TraceInput{Name: "qa-experiment", Input: item.Input})
	// … run your model against item.Input and record the generation …
	tr.Update(memoturn.TraceInput{Output: "model answer"})
	links = append(links, memoturn.RunLink{DatasetItemID: item.ID, TraceID: tr.ID})
}
if err := mt.Flush(); err != nil {
	log.Fatal(err)
}

run, err := mt.RecordRun("qa-golden", "run-42", links, nil)
if err != nil {
	log.Fatal(err)
}
fmt.Printf("linked %d of %d items\n", run.Linked, added.Added)
```

### CI quality gates

Gate a run's evaluator scores in CI — fail the pipeline when quality regresses. Each threshold may set `Min`, `Max`, and/or `MaxRegression` (the last compares against a baseline run):

```go
res, err := mt.EvaluateGate("qa-golden", "run-42", map[string]memoturn.GateThreshold{
	"faithfulness": {Min: memoturn.Float(0.8)},
	"toxicity":     {Max: memoturn.Float(0.1)},
	"quality":      {MaxRegression: memoturn.Float(0.05)}, // vs the baseline run
}, "main") // baseline run name; pass "" for none
if err != nil {
	log.Fatal(err)
}
if !res.Passed {
	log.Fatalf("quality gate failed: %v", res.Failures)
}
```

## Guardrails

Scan text against the project's runtime guardrails (PII, prompt injection, blocked terms) before sending user content to an LLM — or before returning a model's output:

```go
v, err := mt.CheckGuardrails("My email is ada@example.com")
if err != nil {
	log.Fatal(err)
}
switch v.Verdict {
case "block":
	log.Fatal("input blocked by guardrails")
case "redact":
	fmt.Println("proceeding with redacted input:", v.RedactedText)
default: // "allow"
	fmt.Println("clean input")
}
```

## OpenTelemetry

Already instrumented with OTel? memoturn's OTLP/HTTP receiver ingests standard spans and maps GenAI semantic conventions (`gen_ai.*`) into traces + generations. `OTLPConfig` pre-wires the endpoint and Basic-auth header — the SDK stays dependency-free; only your application imports the exporter:

```go
endpoint, headers := mt.OTLPConfig()
// endpoint = "<baseURL>/v1/otel/v1/traces", headers = {"Authorization": "Basic …"}
```

Wire it into the official exporter (`go get go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp`):

```go
package main

import (
	"context"
	"log"

	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"

	memoturn "github.com/memoturn/memoturn/sdks/go"
)

func main() {
	mt := memoturn.New()
	endpoint, headers := mt.OTLPConfig()

	exp, err := otlptracehttp.New(context.Background(),
		otlptracehttp.WithEndpointURL(endpoint),
		otlptracehttp.WithHeaders(headers),
	)
	if err != nil {
		log.Fatal(err)
	}
	provider := sdktrace.NewTracerProvider(sdktrace.WithBatcher(exp))
	defer provider.Shutdown(context.Background())
}
```

## Concurrency & shutdown

`Client` is safe for concurrent use; `Flush` may be called from multiple goroutines, and size-triggered background flushes are single-flight. There is no automatic flush on process exit — always `defer mt.Shutdown()` (it stops the background timer and flushes the remaining buffer). See [`BEST_PRACTICES.md`](./BEST_PRACTICES.md) for failure semantics, buffer sizing, and PII masking.

## Development

```bash
go test ./...                      # unit tests (no API needed)
MEMOTURN_INTEGRATION=1 go test ./... # + integration tests against a running dev API (bun run dev)
```

Integration tests default to `http://localhost:3001` with the dev keys `pk-mt-dev`/`sk-mt-dev`; override via the standard `MEMOTURN_*` env vars.
