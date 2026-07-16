package memoturn

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

func TestFlushSendsBatch(t *testing.T) {
	var (
		mu       sync.Mutex
		gotAuth  string
		gotBatch []envelope
	)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		gotAuth = r.Header.Get("authorization")
		b, _ := io.ReadAll(r.Body)
		var payload struct {
			Batch []envelope `json:"batch"`
		}
		_ = json.Unmarshal(b, &payload)
		gotBatch = payload.Batch
		w.WriteHeader(http.StatusMultiStatus)
		_, _ = w.Write([]byte(`{"errors":[]}`))
	}))
	defer srv.Close()

	mt := New(
		WithBaseURL(srv.URL),
		WithCredentials("pk-test", "sk-test"),
		WithFlushInterval(0), // no background timer; flush explicitly
	)

	tr := mt.Trace(TraceInput{Name: "chat", UserID: "u1"})
	gen := tr.Generation(GenerationInput{Model: "gpt-4o", SpanInput: SpanInput{Input: "hi"}})
	gen.End(GenerationInput{SpanInput: SpanInput{Output: "hello"}, Usage: &Usage{TotalTokens: 12}})
	tr.Score(ScoreInput{Name: "quality", Value: Float(0.9)})

	if err := mt.Flush(); err != nil {
		t.Fatalf("flush: %v", err)
	}

	mu.Lock()
	defer mu.Unlock()

	if gotAuth != "Basic "+mt.basicAuth() {
		t.Errorf("auth header = %q, want basic pk-test:sk-test", gotAuth)
	}
	if len(gotBatch) != 4 {
		t.Fatalf("batch len = %d, want 4", len(gotBatch))
	}
	types := make([]string, len(gotBatch))
	for i, e := range gotBatch {
		types[i] = e.Type
	}
	want := "trace-create,generation-create,generation-update,score-create"
	if strings.Join(types, ",") != want {
		t.Errorf("event types = %v, want %s", types, want)
	}

	// The generation-create carries the model + trace linkage + a start time.
	genEv := gotBatch[1]
	if genEv.Body["model"] != "gpt-4o" || genEv.Body["traceId"] != tr.ID {
		t.Errorf("generation body = %v", genEv.Body)
	}
	if _, ok := genEv.Body["startTime"]; !ok {
		t.Error("generation-create missing startTime")
	}
	// The score value (an explicit 0.9) survives (pointer field, not dropped by omitempty).
	if gotBatch[3].Body["value"] != 0.9 {
		t.Errorf("score value = %v, want 0.9", gotBatch[3].Body["value"])
	}
}

func TestFlushEmptyIsNoop(t *testing.T) {
	mt := New(WithFlushInterval(0))
	if err := mt.Flush(); err != nil {
		t.Fatalf("empty flush should be nil, got %v", err)
	}
}

func TestGetPromptAndCompile(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.URL.Query().Get("bucketKey"); got != "sess-1" {
			t.Errorf("bucketKey = %q, want sess-1", got)
		}
		if got := r.URL.Query().Get("channel"); got != "production" {
			t.Errorf("channel = %q, want production", got)
		}
		_, _ = w.Write([]byte(`{"name":"greet","version":3,"type":"TEXT","content":"Hi {{name}}!","config":{}}`))
	}))
	defer srv.Close()

	mt := New(WithBaseURL(srv.URL), WithFlushInterval(0))
	p, err := mt.GetPrompt("greet", WithBucketKey("sess-1"))
	if err != nil {
		t.Fatalf("getPrompt: %v", err)
	}
	if p.Version != 3 {
		t.Errorf("version = %d, want 3", p.Version)
	}
	if got := p.CompileText(map[string]any{"name": "Ada"}); got != "Hi Ada!" {
		t.Errorf("compiled = %q, want %q", got, "Hi Ada!")
	}
}
