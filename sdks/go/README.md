# memoturn Go SDK

Go client for [memoturn](https://memoturn.ai) — LLM observability, evals, and prompt management. Dependency-free (stdlib only).

```bash
go get github.com/memoturn/memoturn/sdks/go
```

## Tracing

The client buffers events and flushes them as batches to `POST /v1/ingest`; it handles ids, timestamps, batching, and auth. Create trace/span/generation handles and close them as work completes.

```go
package main

import (
	"context"

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
		Usage:     &memoturn.Usage{PromptTokens: 12, CompletionTokens: 20, TotalTokens: 32},
	})

	tr.Score(memoturn.ScoreInput{Name: "quality", Value: memoturn.Float(0.9)})
}
```

Nest spans, record events, and update a trace:

```go
span := tr.Span(memoturn.SpanInput{Name: "retrieve"})
child := span.Span(memoturn.SpanInput{Name: "vector-search"})
child.End(memoturn.GenerationInput{SpanInput: memoturn.SpanInput{Output: "3 docs"}})
tr.Update(memoturn.TraceInput{Output: "done"})
```

Configuration falls back to environment variables: `MEMOTURN_BASE_URL`, `MEMOTURN_PUBLIC_KEY`, `MEMOTURN_SECRET_KEY`, `MEMOTURN_ENVIRONMENT`. Tune batching with `WithFlushAt` (default 20) and `WithFlushInterval` (default 5s; `0` disables the background timer — call `Flush()` yourself).

## Prompts

Fetch a deployed prompt by channel and compile its `{{variables}}`. For channels running an A/B split, pass `WithBucketKey` (a stable session/user id) to keep a caller on one arm; stamp the returned version back on the generation for per-arm attribution.

```go
p, err := mt.GetPrompt("support-reply", memoturn.WithBucketKey("s_1"))
if err != nil {
	// handle
}
text := p.CompileText(map[string]any{"name": "Ada"}) // TEXT prompts
// msgs := p.CompileChat(map[string]any{"name": "Ada"}) // CHAT prompts → []{role, content}

gen := tr.Generation(memoturn.GenerationInput{
	Model:         "gpt-4o",
	PromptID:      p.Name,
	PromptVersion: fmt.Sprintf("%d", p.Version), // links the generation to the resolved arm
	SpanInput:     memoturn.SpanInput{Input: text},
})
_ = gen
```

## Concurrency

`Client` is safe for concurrent use. `Flush` may be called from multiple goroutines. Always call `Shutdown` before exit to flush buffered events.
