package memoturn

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
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

// captureServer records every ingest batch and answers with a settable status.
type captureServer struct {
	mu      sync.Mutex
	batches [][]envelope
	status  int
	srv     *httptest.Server
}

func newCaptureServer() *captureServer {
	cs := &captureServer{status: http.StatusMultiStatus}
	cs.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		var payload struct {
			Batch []envelope `json:"batch"`
		}
		_ = json.Unmarshal(b, &payload)
		cs.mu.Lock()
		cs.batches = append(cs.batches, payload.Batch)
		status := cs.status
		cs.mu.Unlock()
		w.WriteHeader(status)
		_, _ = w.Write([]byte(`{"errors":[]}`))
	}))
	return cs
}

func (cs *captureServer) setStatus(code int) {
	cs.mu.Lock()
	cs.status = code
	cs.mu.Unlock()
}

func (cs *captureServer) requestCount() int {
	cs.mu.Lock()
	defer cs.mu.Unlock()
	return len(cs.batches)
}

func (cs *captureServer) lastBatch() []envelope {
	cs.mu.Lock()
	defer cs.mu.Unlock()
	if len(cs.batches) == 0 {
		return nil
	}
	return cs.batches[len(cs.batches)-1]
}

func newTestClient(cs *captureServer, opts ...Option) *Client {
	base := []Option{WithBaseURL(cs.srv.URL), WithCredentials("pk-test", "sk-test"), WithFlushInterval(0)}
	return New(append(base, opts...)...)
}

func findByType(batch []envelope, typ string) *envelope {
	for i := range batch {
		if batch[i].Type == typ {
			return &batch[i]
		}
	}
	return nil
}

func TestTraceEnvironmentPropagatesToChildren(t *testing.T) {
	cs := newCaptureServer()
	defer cs.srv.Close()
	mt := newTestClient(cs)

	tr := mt.Trace(TraceInput{Name: "t", Environment: "prod"})
	tr.Span(SpanInput{Name: "child"})
	tr.Score(ScoreInput{Name: "quality", Value: Float(1)})
	if err := mt.Flush(); err != nil {
		t.Fatalf("flush: %v", err)
	}

	batch := cs.lastBatch()
	for _, typ := range []string{"trace-create", "span-create", "score-create"} {
		ev := findByType(batch, typ)
		if ev == nil {
			t.Fatalf("missing %s event", typ)
		}
		if ev.Body["environment"] != "prod" {
			t.Errorf("%s environment = %v, want prod", typ, ev.Body["environment"])
		}
	}
}

func TestPermanent4xxDropsBatch(t *testing.T) {
	cs := newCaptureServer()
	defer cs.srv.Close()
	cs.setStatus(http.StatusUnauthorized)
	mt := newTestClient(cs)

	mt.Trace(TraceInput{Name: "t"})
	if err := mt.Flush(); err == nil {
		t.Fatal("want error on 401")
	}
	// A permanent reject is not retried — the buffer stays empty.
	cs.setStatus(http.StatusMultiStatus)
	if err := mt.Flush(); err != nil {
		t.Fatalf("second flush: %v", err)
	}
	if got := cs.requestCount(); got != 1 {
		t.Errorf("requests = %d, want 1 (dropped batch must not be re-sent)", got)
	}
}

func TestTransient5xxRebuffers(t *testing.T) {
	cs := newCaptureServer()
	defer cs.srv.Close()
	cs.setStatus(http.StatusInternalServerError)
	mt := newTestClient(cs)

	mt.Trace(TraceInput{Name: "t"})
	if err := mt.Flush(); err == nil {
		t.Fatal("want error on 500")
	}
	cs.setStatus(http.StatusMultiStatus)
	if err := mt.Flush(); err != nil {
		t.Fatalf("retry flush: %v", err)
	}
	if got := cs.requestCount(); got != 2 {
		t.Fatalf("requests = %d, want 2", got)
	}
	if got := len(cs.lastBatch()); got != 1 {
		t.Errorf("retried batch len = %d, want 1 (nothing lost)", got)
	}
}

func TestBufferCapDropsNewEvents(t *testing.T) {
	cs := newCaptureServer()
	defer cs.srv.Close()
	mt := newTestClient(cs, WithMaxBufferSize(2))

	mt.Trace(TraceInput{Name: "a"})
	mt.Trace(TraceInput{Name: "b"})
	mt.Trace(TraceInput{Name: "c"}) // dropped
	if err := mt.Flush(); err != nil {
		t.Fatalf("flush: %v", err)
	}
	if got := len(cs.lastBatch()); got != 2 {
		t.Errorf("batch len = %d, want 2", got)
	}
}

func TestMaskAppliedToRedactableFields(t *testing.T) {
	cs := newCaptureServer()
	defer cs.srv.Close()
	mt := newTestClient(cs, WithMask(func(field string, v any) any {
		if field == "input" {
			return "[masked]"
		}
		return v
	}))

	mt.Trace(TraceInput{Name: "t", Input: map[string]any{"ssn": "123"}, Output: map[string]any{"ok": true}})
	if err := mt.Flush(); err != nil {
		t.Fatalf("flush: %v", err)
	}
	body := findByType(cs.lastBatch(), "trace-create").Body
	if body["input"] != "[masked]" {
		t.Errorf("input = %v, want masked", body["input"])
	}
	if out, ok := body["output"].(map[string]any); !ok || out["ok"] != true {
		t.Errorf("output = %v, want untouched", body["output"])
	}
}

func TestMaskPanicUsesSentinelNeverRawValue(t *testing.T) {
	cs := newCaptureServer()
	defer cs.srv.Close()
	mt := newTestClient(cs, WithMask(func(field string, v any) any { panic("mask bug") }))

	mt.Trace(TraceInput{Name: "t", Input: "raw secret"})
	if err := mt.Flush(); err != nil {
		t.Fatalf("flush: %v", err)
	}
	if got := findByType(cs.lastBatch(), "trace-create").Body["input"]; got != maskErrorSentinel {
		t.Errorf("input = %v, want sentinel", got)
	}
}

func TestSizeTriggeredFlushDelivers(t *testing.T) {
	cs := newCaptureServer()
	defer cs.srv.Close()
	mt := newTestClient(cs, WithFlushAt(2))

	mt.Trace(TraceInput{Name: "a"})
	mt.Trace(TraceInput{Name: "b"}) // hits flushAt -> background single-flight flush
	deadline := time.Now().Add(3 * time.Second)
	for cs.requestCount() == 0 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if cs.requestCount() == 0 {
		t.Fatal("size-triggered flush never delivered")
	}
}

func TestTraceToolAndAgentSetObservationType(t *testing.T) {
	tests := []struct {
		name  string
		start func(tr *Trace) *Span
		want  string
	}{
		{"tool", func(tr *Trace) *Span { return tr.Tool(SpanInput{Name: "search"}) }, ObservationTypeTool},
		{"agent", func(tr *Trace) *Span { return tr.Agent(SpanInput{Name: "planner"}) }, ObservationTypeAgent},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			cs := newCaptureServer()
			defer cs.srv.Close()
			mt := newTestClient(cs)

			tr := mt.Trace(TraceInput{Name: "t"})
			sp := tt.start(tr)
			if err := mt.Flush(); err != nil {
				t.Fatalf("flush: %v", err)
			}
			ev := findByType(cs.lastBatch(), "span-create")
			if ev == nil {
				t.Fatal("missing span-create event")
			}
			if ev.Body["observationType"] != tt.want {
				t.Errorf("observationType = %v, want %s", ev.Body["observationType"], tt.want)
			}
			if ev.Body["traceId"] != tr.ID || ev.Body["id"] != sp.ID {
				t.Errorf("linkage = %v", ev.Body)
			}
		})
	}
}

func TestSpanToolAndAgentSetObservationType(t *testing.T) {
	cs := newCaptureServer()
	defer cs.srv.Close()
	mt := newTestClient(cs)

	tr := mt.Trace(TraceInput{Name: "t"})
	parent := tr.Span(SpanInput{Name: "outer"})
	parent.Tool(SpanInput{Name: "search"})
	parent.Agent(SpanInput{Name: "planner"})
	if err := mt.Flush(); err != nil {
		t.Fatalf("flush: %v", err)
	}

	batch := cs.lastBatch()
	var got []string
	for _, ev := range batch {
		if ev.Type != "span-create" || ev.Body["parentObservationId"] != parent.ID {
			continue
		}
		ot, _ := ev.Body["observationType"].(string)
		got = append(got, ot)
	}
	if strings.Join(got, ",") != "TOOL,AGENT" {
		t.Errorf("nested observationTypes = %v, want [TOOL AGENT]", got)
	}
}

func TestSpanGenerationNestsAndEndsAsGeneration(t *testing.T) {
	cs := newCaptureServer()
	defer cs.srv.Close()
	mt := newTestClient(cs)

	tr := mt.Trace(TraceInput{Name: "t"})
	parent := tr.Span(SpanInput{Name: "outer"})
	gen := parent.Generation(GenerationInput{Model: "gpt-4o", SpanInput: SpanInput{Input: "hi"}})
	gen.End(GenerationInput{SpanInput: SpanInput{Output: "hello"}, Usage: &Usage{TotalTokens: 12, CacheReadTokens: 5}})
	if err := mt.Flush(); err != nil {
		t.Fatalf("flush: %v", err)
	}

	batch := cs.lastBatch()
	create := findByType(batch, "generation-create")
	if create == nil {
		t.Fatal("missing generation-create")
	}
	if create.Body["parentObservationId"] != parent.ID || create.Body["traceId"] != tr.ID {
		t.Errorf("generation-create linkage = %v", create.Body)
	}
	if create.Body["model"] != "gpt-4o" {
		t.Errorf("model = %v", create.Body["model"])
	}
	if _, ok := create.Body["startTime"]; !ok {
		t.Error("generation-create missing startTime")
	}
	update := findByType(batch, "generation-update")
	if update == nil {
		t.Fatal("nested generation must End as generation-update, not span-update")
	}
	if update.Body["id"] != gen.ID {
		t.Errorf("generation-update id = %v, want %s", update.Body["id"], gen.ID)
	}
	usage, ok := update.Body["usage"].(map[string]any)
	if !ok || usage["cacheReadTokens"] != float64(5) {
		t.Errorf("usage = %v, want cacheReadTokens 5", update.Body["usage"])
	}
}

func TestSpanEventEmitsEventCreateWithParent(t *testing.T) {
	cs := newCaptureServer()
	defer cs.srv.Close()
	mt := newTestClient(cs)

	tr := mt.Trace(TraceInput{Name: "t", Environment: "prod"})
	parent := tr.Span(SpanInput{Name: "outer"})
	parent.Event(SpanInput{Name: "cache-hit"})
	if err := mt.Flush(); err != nil {
		t.Fatalf("flush: %v", err)
	}

	ev := findByType(cs.lastBatch(), "event-create")
	if ev == nil {
		t.Fatal("missing event-create")
	}
	if ev.Body["parentObservationId"] != parent.ID || ev.Body["traceId"] != tr.ID {
		t.Errorf("event linkage = %v", ev.Body)
	}
	if ev.Body["environment"] != "prod" {
		t.Errorf("environment = %v, want prod", ev.Body["environment"])
	}
	if _, ok := ev.Body["startTime"]; !ok {
		t.Error("event-create missing startTime")
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

func TestCompileChat(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"name":"support","version":2,"type":"CHAT","content":[` +
			`{"role":"system","content":"You help {{product}} users."},` +
			`{"role":"user","content":"{{question}}"}],"config":{}}`))
	}))
	defer srv.Close()

	mt := New(WithBaseURL(srv.URL), WithFlushInterval(0))
	p, err := mt.GetPrompt("support")
	if err != nil {
		t.Fatalf("getPrompt: %v", err)
	}
	msgs := p.CompileChat(map[string]any{"product": "memoturn", "question": "How do I flush?"})
	if len(msgs) != 2 {
		t.Fatalf("messages = %d, want 2", len(msgs))
	}
	if msgs[0]["role"] != "system" || msgs[0]["content"] != "You help memoturn users." {
		t.Errorf("system message = %v", msgs[0])
	}
	if msgs[1]["role"] != "user" || msgs[1]["content"] != "How do I flush?" {
		t.Errorf("user message = %v", msgs[1])
	}
	// A TEXT prompt's content is not a message array — CompileChat returns nil.
	text := &CompiledPrompt{Type: "TEXT", Content: "Hi {{name}}!"}
	if got := text.CompileChat(map[string]any{"name": "Ada"}); got != nil {
		t.Errorf("CompileChat on TEXT prompt = %v, want nil", got)
	}
}
