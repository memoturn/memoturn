package memoturn

// Env-gated integration tests against a running memoturn dev API (bun run dev).
// Skipped unless MEMOTURN_INTEGRATION=1. Config comes from the standard MEMOTURN_* env
// vars, defaulting to the local dev API (http://localhost:3001, pk-mt-dev/sk-mt-dev).
//
//	MEMOTURN_INTEGRATION=1 go test ./...

import (
	"os"
	"testing"
)

// integrationClient skips the test unless MEMOTURN_INTEGRATION=1, then builds a client
// for the dev API. Extra options are applied last, so they override the defaults.
func integrationClient(t *testing.T, opts ...Option) *Client {
	t.Helper()
	if os.Getenv("MEMOTURN_INTEGRATION") != "1" {
		t.Skip("set MEMOTURN_INTEGRATION=1 with a running dev API to run integration tests")
	}
	base := []Option{
		WithBaseURL(envOr("MEMOTURN_BASE_URL", "http://localhost:3001")),
		WithCredentials(envOr("MEMOTURN_PUBLIC_KEY", "pk-mt-dev"), envOr("MEMOTURN_SECRET_KEY", "sk-mt-dev")),
		WithFlushInterval(0), // flush explicitly; failures surface as test errors
		WithAllowInsecureHTTP(),
	}
	return New(append(base, opts...)...)
}

func TestIntegrationIngestRoundTrip(t *testing.T) {
	mt := integrationClient(t)

	tr := mt.Trace(TraceInput{Name: "it-ingest-" + uuid(), UserID: "it-user", Tags: []string{"integration"}})
	gen := tr.Generation(GenerationInput{
		Model:     "gpt-4o",
		Provider:  "openai",
		SpanInput: SpanInput{Input: "integration ping"},
	})
	gen.End(GenerationInput{
		SpanInput: SpanInput{Output: "integration pong"},
		Usage: &Usage{
			PromptTokens: 10, CompletionTokens: 5, TotalTokens: 15,
			CacheReadTokens: 4, CacheCreationTokens: 2,
		},
	})
	tr.Score(ScoreInput{Name: "it-quality", Value: Float(1)})

	if err := mt.Flush(); err != nil {
		t.Fatalf("ingest round-trip flush: %v", err)
	}
}

func TestIntegrationDatasetLifecycle(t *testing.T) {
	mt := integrationClient(t)
	name := "it-ds-" + uuid()

	if err := mt.CreateDataset(name, "go sdk integration test"); err != nil {
		t.Fatalf("CreateDataset: %v", err)
	}
	added, err := mt.AddDatasetItems(name, []DatasetItem{
		{Input: "q1", ExpectedOutput: "a1"},
		{Input: "q2", ExpectedOutput: "a2", Metadata: map[string]any{"difficulty": "hard"}},
	})
	if err != nil {
		t.Fatalf("AddDatasetItems: %v", err)
	}
	if added.Added != 2 || len(added.ItemIDs) != 2 {
		t.Fatalf("AddDatasetItems result = %+v, want 2 items", added)
	}

	ds, err := mt.GetDataset(name)
	if err != nil {
		t.Fatalf("GetDataset: %v", err)
	}
	if ds.Name != name || len(ds.Items) != 2 {
		t.Fatalf("GetDataset = %q with %d items, want %q with 2", ds.Name, len(ds.Items), name)
	}

	// Produce a real trace to link, and make sure it reached the server first.
	tr := mt.Trace(TraceInput{Name: "it-run-trace-" + uuid()})
	if err := mt.Flush(); err != nil {
		t.Fatalf("flush before RecordRun: %v", err)
	}
	run, err := mt.RecordRun(name, "it-run-"+uuid(), []RunLink{{DatasetItemID: added.ItemIDs[0], TraceID: tr.ID}}, nil)
	if err != nil {
		t.Fatalf("RecordRun: %v", err)
	}
	if run.Linked != 1 {
		t.Errorf("run.Linked = %d, want 1", run.Linked)
	}
}

func TestIntegrationCheckGuardrails(t *testing.T) {
	mt := integrationClient(t)

	v, err := mt.CheckGuardrails("My email is ada@example.com and my phone is 555-0100.")
	if err != nil {
		t.Fatalf("CheckGuardrails: %v", err)
	}
	switch v.Verdict {
	case "allow", "redact", "block":
		// valid verdicts; findings/redactedText depend on the project's guardrail config
	default:
		t.Errorf("verdict = %q, want one of allow/redact/block", v.Verdict)
	}
}

func TestIntegrationWrongCredentialsFlushFails(t *testing.T) {
	mt := integrationClient(t, WithCredentials("pk-definitely-wrong", "sk-definitely-wrong"))

	mt.Trace(TraceInput{Name: "it-unauthorized-" + uuid()})
	if err := mt.Flush(); err == nil {
		t.Fatal("Flush with wrong credentials should return an error")
	}
}
