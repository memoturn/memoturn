// Package memoturn is the Go SDK for memoturn — the open-source AI engineering platform
// (LLM observability, evals, prompts). Buffer trace/span/generation/score events and flush
// them as batches to POST /v1/ingest; the client handles ids, timestamps, batching, and auth.
//
//	mt := memoturn.New(memoturn.WithCredentials("pk-...", "sk-..."))
//	defer mt.Shutdown()
//	tr := mt.Trace(memoturn.TraceInput{Name: "chat", UserID: "u1"})
//	gen := tr.Generation(memoturn.GenerationInput{Model: "gpt-4o", SpanInput: memoturn.SpanInput{Input: "hi"}})
//	gen.End(memoturn.GenerationInput{SpanInput: memoturn.SpanInput{Output: "hello"}, Usage: &memoturn.Usage{TotalTokens: 12}})
//	tr.Score(memoturn.ScoreInput{Name: "quality", Value: memoturn.Float(0.9)})
package memoturn

import (
	"bytes"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"
)

const defaultBaseURL = "http://localhost:3000"

type envelope struct {
	ID        string         `json:"id"`
	Type      string         `json:"type"`
	Timestamp string         `json:"timestamp"`
	Body      map[string]any `json:"body"`
}

// Client buffers events and flushes them to the ingest API. Safe for concurrent use.
type Client struct {
	baseURL       string
	publicKey     string
	secretKey     string
	environment   string
	flushAt       int
	flushInterval time.Duration
	http          *http.Client

	mu     sync.Mutex
	buffer []envelope

	stopOnce sync.Once
	stop     chan struct{}
	done     chan struct{}
}

// Option configures a Client.
type Option func(*Client)

// WithBaseURL sets the API base URL (default $MEMOTURN_BASE_URL or http://localhost:3000).
func WithBaseURL(u string) Option { return func(c *Client) { c.baseURL = strings.TrimRight(u, "/") } }

// WithCredentials sets the API key pair (default $MEMOTURN_PUBLIC_KEY / $MEMOTURN_SECRET_KEY).
func WithCredentials(publicKey, secretKey string) Option {
	return func(c *Client) { c.publicKey, c.secretKey = publicKey, secretKey }
}

// WithEnvironment tags events with an environment (default $MEMOTURN_ENVIRONMENT or "default").
func WithEnvironment(env string) Option { return func(c *Client) { c.environment = env } }

// WithFlushAt flushes once the buffer reaches n events (default 20).
func WithFlushAt(n int) Option { return func(c *Client) { c.flushAt = n } }

// WithFlushInterval flushes at least this often (default 5s). Zero disables the background timer.
func WithFlushInterval(d time.Duration) Option { return func(c *Client) { c.flushInterval = d } }

// WithHTTPClient overrides the underlying *http.Client.
func WithHTTPClient(h *http.Client) Option { return func(c *Client) { c.http = h } }

// New creates a Client, applying env-var defaults then the given options.
func New(opts ...Option) *Client {
	c := &Client{
		baseURL:       strings.TrimRight(envOr("MEMOTURN_BASE_URL", defaultBaseURL), "/"),
		publicKey:     os.Getenv("MEMOTURN_PUBLIC_KEY"),
		secretKey:     os.Getenv("MEMOTURN_SECRET_KEY"),
		environment:   envOr("MEMOTURN_ENVIRONMENT", "default"),
		flushAt:       20,
		flushInterval: 5 * time.Second,
		http:          &http.Client{Timeout: 30 * time.Second},
		stop:          make(chan struct{}),
		done:          make(chan struct{}),
	}
	for _, o := range opts {
		o(c)
	}
	if c.flushInterval > 0 {
		go c.loop()
	} else {
		close(c.done)
	}
	return c
}

func (c *Client) loop() {
	defer close(c.done)
	t := time.NewTicker(c.flushInterval)
	defer t.Stop()
	for {
		select {
		case <-c.stop:
			return
		case <-t.C:
			if err := c.Flush(); err != nil {
				log.Printf("memoturn: background flush failed: %v", err)
			}
		}
	}
}

// Trace starts a trace and returns a handle for adding observations and scores.
func (c *Client) Trace(input TraceInput) *Trace {
	id := orUUID(input.ID)
	env := input.Environment
	if env == "" {
		env = c.environment
	}
	c.enqueue("trace-create", body(input, kv{"id": id, "environment": env}))
	return &Trace{client: c, ID: id, env: c.environment}
}

func (c *Client) enqueue(typ string, b map[string]any) {
	c.mu.Lock()
	c.buffer = append(c.buffer, envelope{ID: uuid(), Type: typ, Timestamp: nowISO(), Body: b})
	full := len(c.buffer) >= c.flushAt
	c.mu.Unlock()
	if full {
		go func() {
			if err := c.Flush(); err != nil {
				log.Printf("memoturn: flush failed: %v", err)
			}
		}()
	}
}

// Flush sends all buffered events now. Safe to call repeatedly and concurrently. On a transport
// error the batch is re-buffered so the next flush retries; schema-rejected events (reported in
// the 207 body) are logged, not retried.
func (c *Client) Flush() error {
	c.mu.Lock()
	if len(c.buffer) == 0 {
		c.mu.Unlock()
		return nil
	}
	batch := c.buffer
	c.buffer = nil
	c.mu.Unlock()

	payload, err := json.Marshal(map[string]any{"batch": batch})
	if err != nil {
		return err
	}
	req, err := http.NewRequest(http.MethodPost, c.baseURL+"/v1/ingest", bytes.NewReader(payload))
	if err != nil {
		return err
	}
	req.Header.Set("content-type", "application/json")
	req.Header.Set("authorization", "Basic "+c.basicAuth())

	res, err := c.http.Do(req)
	if err != nil {
		c.rebuffer(batch)
		return err
	}
	defer res.Body.Close()

	if res.StatusCode != http.StatusOK && res.StatusCode != http.StatusMultiStatus {
		bodyText, _ := io.ReadAll(res.Body)
		c.rebuffer(batch)
		return fmt.Errorf("memoturn ingest failed: %d %s", res.StatusCode, strings.TrimSpace(string(bodyText)))
	}

	// The 207 body reports per-event results; surface rejects (they are NOT retried — a schema
	// rejection is permanent) instead of silently dropping them.
	if res.StatusCode == http.StatusMultiStatus {
		var parsed struct {
			Errors []struct {
				Error string `json:"error"`
			} `json:"errors"`
		}
		if json.NewDecoder(res.Body).Decode(&parsed) == nil && len(parsed.Errors) > 0 {
			log.Printf("memoturn: %d event(s) rejected at ingest — first: %s", len(parsed.Errors), parsed.Errors[0].Error)
		}
	}
	return nil
}

// rebuffer prepends a failed batch ahead of any newly-buffered events.
func (c *Client) rebuffer(batch []envelope) {
	c.mu.Lock()
	c.buffer = append(batch, c.buffer...)
	c.mu.Unlock()
}

// Shutdown stops the background timer and flushes remaining events. Call before exit.
func (c *Client) Shutdown() error {
	c.stopOnce.Do(func() { close(c.stop) })
	<-c.done
	return c.Flush()
}

func (c *Client) basicAuth() string {
	return base64.StdEncoding.EncodeToString([]byte(c.publicKey + ":" + c.secretKey))
}

// Trace is a handle to a started trace.
type Trace struct {
	client *Client
	ID     string
	env    string
}

// Update patches trace fields (re-emits trace-create with a partial body).
func (t *Trace) Update(input TraceInput) *Trace {
	t.client.enqueue("trace-create", body(input, kv{"id": t.ID, "environment": t.env}))
	return t
}

// Span starts a child span.
func (t *Trace) Span(input SpanInput) *Span {
	id := orUUID(input.ID)
	t.client.enqueue("span-create", body(input, kv{"id": id, "traceId": t.ID, "environment": t.env, "startTime": nowISO()}))
	return &Span{client: t.client, traceID: t.ID, ID: id, env: t.env, kind: "span"}
}

// Generation starts a child generation (an LLM call).
func (t *Trace) Generation(input GenerationInput) *Span {
	id := orUUID(input.ID)
	t.client.enqueue("generation-create", body(input, kv{"id": id, "traceId": t.ID, "environment": t.env, "startTime": nowISO()}))
	return &Span{client: t.client, traceID: t.ID, ID: id, env: t.env, kind: "generation"}
}

// Event records a point-in-time event on the trace.
func (t *Trace) Event(input SpanInput) {
	t.client.enqueue("event-create", body(input, kv{"id": orUUID(input.ID), "traceId": t.ID, "environment": t.env, "startTime": nowISO()}))
}

// Score attaches a score to the trace (or an observation via ScoreInput.ObservationID).
func (t *Trace) Score(input ScoreInput) *Trace {
	t.client.enqueue("score-create", body(input, kv{"id": orUUID(input.ID), "traceId": t.ID, "environment": t.env}))
	return t
}

// Span is a handle to a started span or generation.
type Span struct {
	client  *Client
	traceID string
	ID      string
	env     string
	kind    string // "span" | "generation"
}

// Span starts a nested child span.
func (s *Span) Span(input SpanInput) *Span {
	id := orUUID(input.ID)
	s.client.enqueue("span-create", body(input, kv{
		"id": id, "traceId": s.traceID, "parentObservationId": s.ID, "environment": s.env, "startTime": nowISO(),
	}))
	return &Span{client: s.client, traceID: s.traceID, ID: id, env: s.env, kind: "span"}
}

// End updates and closes the observation. Pass Output and (for generations) Usage.
func (s *Span) End(input GenerationInput) {
	typ := "span-update"
	if s.kind == "generation" {
		typ = "generation-update"
	}
	s.client.enqueue(typ, body(input, kv{"id": s.ID, "traceId": s.traceID, "environment": s.env, "endTime": nowISO()}))
}

// ── helpers ─────────────────────────────────────────────────────────────────────

type kv = map[string]any

// body marshals an input struct to a map (dropping unset fields via omitempty) then overlays
// the injected fields — the Go equivalent of the JS SDK's object spread.
func body(input any, inject kv) map[string]any {
	m := map[string]any{}
	if input != nil {
		if b, err := json.Marshal(input); err == nil {
			_ = json.Unmarshal(b, &m)
		}
	}
	for k, v := range inject {
		m[k] = v
	}
	return m
}

func orUUID(id string) string {
	if id != "" {
		return id
	}
	return uuid()
}

func nowISO() string { return time.Now().UTC().Format("2006-01-02T15:04:05.000Z") }

func uuid() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	b[6] = (b[6] & 0x0f) | 0x40 // version 4
	b[8] = (b[8] & 0x3f) | 0x80 // variant 10
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
