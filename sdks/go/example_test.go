package memoturn_test

// Doc-tested examples backing the README snippets. Every Example function here is
// compiled by `go test` / `go vet` (they have no "// Output:" comments, so they are
// compiled but never executed — none of them needs a running API).

import (
	"fmt"
	"log"

	memoturn "github.com/memoturn/memoturn/sdks/go"
)

// Quick start: trace an LLM call and score it.
func ExampleNew() {
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

// Agentic traces: TOOL/AGENT observations, nesting, events, and trace updates.
func ExampleTrace_Tool() {
	mt := memoturn.New()
	defer mt.Shutdown()

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
}

// Prompts: resolve a deployed prompt, compile it, and stamp the version on the generation.
func ExampleClient_GetPrompt() {
	mt := memoturn.New()
	defer mt.Shutdown()
	tr := mt.Trace(memoturn.TraceInput{Name: "support-chat"})

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
}

// Datasets: create, fill, fetch, and record an experiment run.
func ExampleClient_AddDatasetItems() {
	mt := memoturn.New()
	defer mt.Shutdown()

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
}

// CI quality gate: fail the pipeline when evaluator scores regress.
func ExampleClient_EvaluateGate() {
	mt := memoturn.New()
	defer mt.Shutdown()

	res, err := mt.EvaluateGate("qa-golden", "run-42", map[string]memoturn.GateThreshold{
		"faithfulness": {Min: memoturn.Float(0.8)},
		"toxicity":     {Max: memoturn.Float(0.1)},
		"quality":      {MaxRegression: memoturn.Float(0.05)}, // vs the baseline run
	}, "main")
	if err != nil {
		log.Fatal(err)
	}
	if !res.Passed {
		log.Fatalf("quality gate failed: %v", res.Failures)
	}
}

// Guardrails: scan text before sending it to an LLM (or before returning model output).
func ExampleClient_CheckGuardrails() {
	mt := memoturn.New()
	defer mt.Shutdown()

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
}

// OpenTelemetry: endpoint + auth header for any OTLP/HTTP span exporter.
func ExampleClient_OTLPConfig() {
	mt := memoturn.New(memoturn.WithCredentials("pk-mt-dev", "sk-mt-dev"))
	defer mt.Shutdown()

	endpoint, headers := mt.OTLPConfig()
	// Hand these to your exporter, e.g. otlptracehttp.New(ctx,
	//   otlptracehttp.WithEndpointURL(endpoint), otlptracehttp.WithHeaders(headers)).
	fmt.Println(endpoint, headers["Authorization"])
}
