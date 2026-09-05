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
	"errors"
	"fmt"
	"io"
	"log"
	mathrand "math/rand"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"
)

// SDKName and SDKVersion identify this build on every ingest batch, so telemetry can be
// attributed to the SDK that produced it (GET /v1/usage/sdks). Kept in lockstep with the
// JS/Python SDK versions by the doc-drift checker — bump all of them together.
const (
	SDKName    = "memoturn-go"
	SDKVersion = "0.6.0"
)

func sdkInfo() map[string]string {
	return map[string]string{"name": SDKName, "version": SDKVersion}
}

const defaultBaseURL = "http://localhost:3001"

const defaultMaxBufferSize = 10_000

// Hard limits of POST /v1/ingest: at most 1000 events per request and a 12 MB body. A
// flush never sends more than one request's worth at a time — the buffer can hold far
// more than one request (it exists to ride out an outage), and a single over-limit POST
// would be rejected as a permanent 400/413 and drop everything it carried.
const (
	maxBatchEvents = 1000
	maxBatchBytes  = 10 * 1024 * 1024 // headroom under the API's 12 MB cap
	backoffBase    = time.Second
	backoffMax     = 60 * time.Second
)

// transientError marks an ingest failure worth retrying; the chunk is re-buffered.
type transientError struct {
	err        error
	retryAfter time.Duration // 0 = not provided
}

func (t *transientError) Error() string { return t.err.Error() }
func (t *transientError) Unwrap() error { return t.err }

// maskErrorSentinel replaces a value when a WithMask function panics — the event is
// never dropped and the unmasked value is never sent.
const maskErrorSentinel = "<memoturn: mask error>"

type envelope struct {
	ID        string         `json:"id"`
	Type      string         `json:"type"`
	Timestamp string         `json:"timestamp"`
	Body      map[string]any `json:"body"`
}

// Client buffers events and flushes them to the ingest API. Safe for concurrent use.
type Client struct {
	baseURL           string
	publicKey         string
	secretKey         string
	environment       string
	flushAt           int
	flushInterval     time.Duration
	maxBufferSize     int
	maxBatchSize      int
	allowInsecureHTTP bool
	mask              func(field string, v any) any
	http              *http.Client

	mu         sync.Mutex
	buffer     []envelope
	flushing   bool // a size-triggered background flush is in flight (single-flight)
	warnedFull bool
	// Backoff for background flushes after a transient failure (an explicit Flush always tries).
	transientFailures int
	backoffUntil      time.Time

	// Prompt cache (see prompt.go). Separate mutex: a prompt resolve must never contend
	// with the ingest buffer.
	promptMu       sync.Mutex
	promptCache    map[string]promptEntry
	promptInflight map[string]chan struct{}
	promptInserts  int64 // monotonic insert counter, for oldest-first eviction

	stopOnce sync.Once
	stop     chan struct{}
	done     chan struct{}
}

// Option configures a Client.
type Option func(*Client)

// WithBaseURL sets the API base URL (default $MEMOTURN_BASE_URL or http://localhost:3001).
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

// WithMaxBufferSize caps the number of buffered events (default 10000 or
// $MEMOTURN_MAX_BUFFER_SIZE); once full, incoming events are dropped with a
// one-time warning, and a re-buffered failed batch drops its oldest events first.
func WithMaxBufferSize(n int) Option { return func(c *Client) { c.maxBufferSize = n } }

// WithMaxBatchSize sets the events per ingest request when flushing — a large buffer is
// sent as several requests. Default and hard maximum 1000 (the API's per-request limit).
func WithMaxBatchSize(n int) Option {
	return func(c *Client) {
		if n < 1 {
			n = 1
		}
		if n > maxBatchEvents {
			n = maxBatchEvents
		}
		c.maxBatchSize = n
	}
}

// WithMask sets a redaction hook applied to the "input", "output", and "metadata"
// fields of every event body before it is buffered. If the function panics, the
// value is replaced with a sentinel string — the event is never dropped and the
// unmasked value is never sent.
func WithMask(mask func(field string, v any) any) Option { return func(c *Client) { c.mask = mask } }

// WithAllowInsecureHTTP suppresses the warning about sending API keys over
// cleartext http to a non-local host (also $MEMOTURN_ALLOW_HTTP=1).
func WithAllowInsecureHTTP() Option { return func(c *Client) { c.allowInsecureHTTP = true } }

// New creates a Client, applying env-var defaults then the given options.
func New(opts ...Option) *Client {
	c := &Client{
		baseURL:       strings.TrimRight(envOr("MEMOTURN_BASE_URL", defaultBaseURL), "/"),
		publicKey:     os.Getenv("MEMOTURN_PUBLIC_KEY"),
		secretKey:     os.Getenv("MEMOTURN_SECRET_KEY"),
		environment:   envOr("MEMOTURN_ENVIRONMENT", "default"),
		flushAt:       20,
		flushInterval: 5 * time.Second,
		maxBufferSize: envInt("MEMOTURN_MAX_BUFFER_SIZE", defaultMaxBufferSize),
		maxBatchSize:  maxBatchEvents,
		http:          &http.Client{Timeout: 10 * time.Second},
		stop:          make(chan struct{}),
		done:          make(chan struct{}),
	}
	for _, o := range opts {
		o(c)
	}
	warnIfInsecure(c.baseURL, c.allowInsecureHTTP)
	if c.publicKey == "" && c.secretKey == "" {
		log.Printf("memoturn: no API keys configured (use WithCredentials or set MEMOTURN_PUBLIC_KEY / MEMOTURN_SECRET_KEY) — ingest will be unauthorized")
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
			if err := c.flushQuietly(); err != nil {
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
	return &Trace{client: c, ID: id, env: env}
}

func (c *Client) enqueue(typ string, b map[string]any) {
	c.applyMask(b)
	c.mu.Lock()
	if len(c.buffer) >= c.maxBufferSize {
		warn := !c.warnedFull
		c.warnedFull = true
		c.mu.Unlock()
		if warn {
			log.Printf("memoturn: event buffer full (%d), dropping new events — is the API reachable?", c.maxBufferSize)
		}
		return
	}
	c.buffer = append(c.buffer, envelope{ID: uuid(), Type: typ, Timestamp: nowISO(), Body: b})
	// Single-flight: at most one size-triggered flush goroutine at a time, no matter
	// how fast events arrive.
	full := len(c.buffer) >= c.flushAt && !c.flushing
	if full {
		c.flushing = true
	}
	c.mu.Unlock()
	if full {
		go func() {
			if err := c.flushQuietly(); err != nil {
				log.Printf("memoturn: flush failed: %v", err)
			}
			c.mu.Lock()
			c.flushing = false
			c.mu.Unlock()
		}()
	}
}

// applyMask runs the WithMask hook over the redactable fields of a freshly-built body.
func (c *Client) applyMask(b map[string]any) {
	if c.mask == nil {
		return
	}
	for _, field := range []string{"input", "output", "metadata"} {
		if v, ok := b[field]; ok && v != nil {
			b[field] = c.safeMask(field, v)
		}
	}
}

func (c *Client) safeMask(field string, v any) (out any) {
	// Never lose the event — and never leak the unmasked value.
	defer func() {
		if recover() != nil {
			out = maskErrorSentinel
		}
	}()
	return c.mask(field, v)
}

// flushQuietly is Flush for the background timer and the size trigger: it honours the
// backoff window after a transient failure so a fleet of clients doesn't hammer a
// recovering API in lockstep every flushInterval.
func (c *Client) flushQuietly() error {
	c.mu.Lock()
	wait := time.Now().Before(c.backoffUntil)
	c.mu.Unlock()
	if wait {
		return nil
	}
	return c.Flush()
}

func (c *Client) noteTransientFailure(retryAfter time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	exp := backoffBase << uint(c.transientFailures)
	if exp > backoffMax || exp <= 0 {
		exp = backoffMax
	}
	delay := retryAfter
	if delay <= 0 {
		// ±25% jitter so retries de-synchronize across processes.
		delay = time.Duration(float64(exp) * (0.75 + mathrand.Float64()*0.5))
	}
	if c.transientFailures < 16 {
		c.transientFailures++
	}
	c.backoffUntil = time.Now().Add(delay)
}

// chunkBatch splits a buffer into request-sized chunks (by event count AND serialized
// bytes). An event that alone exceeds the byte cap can never be accepted — it is dropped
// here with an error rather than poisoning the chunk it would ride in.
func (c *Client) chunkBatch(events []envelope) [][]envelope {
	var chunks [][]envelope
	var current []envelope
	currentBytes := 0
	for _, ev := range events {
		b, err := json.Marshal(ev)
		if err != nil {
			log.Printf("memoturn: dropping event %s (%s) — not serializable: %v", ev.ID, ev.Type, err)
			continue
		}
		size := len(b) + 1
		if size > maxBatchBytes {
			log.Printf("memoturn: dropping event %s (%s) — %d bytes exceeds the ingest limit", ev.ID, ev.Type, size)
			continue
		}
		if len(current) >= c.maxBatchSize || currentBytes+size > maxBatchBytes {
			chunks = append(chunks, current)
			current, currentBytes = nil, 0
		}
		current = append(current, ev)
		currentBytes += size
	}
	if len(current) > 0 {
		chunks = append(chunks, current)
	}
	return chunks
}

// Flush sends all buffered events now, in request-sized chunks (≤ 1000 events / ~10 MB
// each). Safe to call repeatedly and concurrently. On a transient failure (network error,
// 5xx, 408, 429) the failing chunk and every chunk after it are re-buffered — nothing is
// lost, order is kept — and the error is returned; a permanent reject (other 4xx) drops only
// that chunk and continues, returning the first such error after the rest has been sent.
// Schema-rejected events (reported in the 207 body) are logged, not retried.
func (c *Client) Flush() error {
	c.mu.Lock()
	if len(c.buffer) == 0 {
		c.mu.Unlock()
		return nil
	}
	pending := c.buffer
	c.buffer = nil
	c.mu.Unlock()

	chunks := c.chunkBatch(pending)
	var firstReject error
	for i, chunk := range chunks {
		err := c.send(chunk)
		if err == nil {
			continue
		}
		var t *transientError
		if errors.As(err, &t) {
			var rest []envelope
			for _, ch := range chunks[i:] {
				rest = append(rest, ch...)
			}
			c.rebuffer(rest)
			c.noteTransientFailure(t.retryAfter)
			return t.err
		}
		if firstReject == nil {
			firstReject = err
		}
	}
	c.mu.Lock()
	c.transientFailures = 0
	c.backoffUntil = time.Time{}
	c.mu.Unlock()
	return firstReject
}

func retryAfterHeader(res *http.Response) time.Duration {
	raw := strings.TrimSpace(res.Header.Get("Retry-After"))
	if raw == "" {
		return 0
	}
	if secs, err := strconv.ParseFloat(raw, 64); err == nil && secs >= 0 {
		d := time.Duration(secs * float64(time.Second))
		if d > backoffMax {
			d = backoffMax
		}
		return d
	}
	if at, err := http.ParseTime(raw); err == nil {
		d := time.Until(at)
		if d < 0 {
			d = 0
		}
		if d > backoffMax {
			d = backoffMax
		}
		return d
	}
	return 0
}

// send performs one POST /v1/ingest. It returns a *transientError when the chunk should
// be retried, or a plain error for a permanent reject (the chunk is dropped and logged).
func (c *Client) send(batch []envelope) error {
	payload, err := json.Marshal(map[string]any{"batch": batch, "sdk": sdkInfo()})
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
		return &transientError{err: err}
	}
	defer res.Body.Close()

	if res.StatusCode != http.StatusOK && res.StatusCode != http.StatusMultiStatus {
		bodyText, _ := io.ReadAll(res.Body)
		detail := truncate(strings.TrimSpace(string(bodyText)))
		if isTransient(res.StatusCode) {
			return &transientError{
				err:        fmt.Errorf("memoturn ingest failed: %d %s", res.StatusCode, detail),
				retryAfter: retryAfterHeader(res),
			}
		}
		// Permanent reject (bad request/auth) — retrying can never succeed; drop the batch.
		log.Printf("memoturn: dropping %d event(s) rejected at ingest: %d %s", len(batch), res.StatusCode, detail)
		return fmt.Errorf("memoturn ingest rejected: %d %s", res.StatusCode, detail)
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

// rebuffer prepends a failed batch ahead of any newly-buffered events, keeping the
// newest up to the cap (a failed batch is older than live traffic).
func (c *Client) rebuffer(batch []envelope) {
	c.mu.Lock()
	combined := append(batch, c.buffer...)
	overflow := len(combined) - c.maxBufferSize
	if overflow > 0 {
		combined = combined[overflow:]
	}
	c.buffer = combined
	warn := overflow > 0 && !c.warnedFull
	if warn {
		c.warnedFull = true
	}
	c.mu.Unlock()
	if warn {
		log.Printf("memoturn: event buffer full (%d), dropped %d oldest event(s)", c.maxBufferSize, overflow)
	}
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

// Tool starts a child span classified as a TOOL observation (a tool/function call made by
// an agent). Equivalent to Span with input.ObservationType = ObservationTypeTool.
func (t *Trace) Tool(input SpanInput) *Span {
	input.ObservationType = ObservationTypeTool
	return t.Span(input)
}

// Agent starts a child span classified as an AGENT observation (an agent step/turn).
// Equivalent to Span with input.ObservationType = ObservationTypeAgent.
func (t *Trace) Agent(input SpanInput) *Span {
	input.ObservationType = ObservationTypeAgent
	return t.Span(input)
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

// Generation starts a nested child generation (an LLM call made inside this span).
func (s *Span) Generation(input GenerationInput) *Span {
	id := orUUID(input.ID)
	s.client.enqueue("generation-create", body(input, kv{
		"id": id, "traceId": s.traceID, "parentObservationId": s.ID, "environment": s.env, "startTime": nowISO(),
	}))
	return &Span{client: s.client, traceID: s.traceID, ID: id, env: s.env, kind: "generation"}
}

// Tool starts a nested child span classified as a TOOL observation (a tool/function call
// made by an agent). Equivalent to Span with input.ObservationType = ObservationTypeTool.
func (s *Span) Tool(input SpanInput) *Span {
	input.ObservationType = ObservationTypeTool
	return s.Span(input)
}

// Agent starts a nested child span classified as an AGENT observation (an agent step/turn).
// Equivalent to Span with input.ObservationType = ObservationTypeAgent.
func (s *Span) Agent(input SpanInput) *Span {
	input.ObservationType = ObservationTypeAgent
	return s.Span(input)
}

// Event records a point-in-time event nested under this span.
func (s *Span) Event(input SpanInput) {
	s.client.enqueue("event-create", body(input, kv{
		"id": orUUID(input.ID), "traceId": s.traceID, "parentObservationId": s.ID, "environment": s.env, "startTime": nowISO(),
	}))
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

func envInt(key string, fallback int) int {
	if n, err := strconv.Atoi(os.Getenv(key)); err == nil && n > 0 {
		return n
	}
	return fallback
}

// truncate caps server-provided text embedded in errors/logs.
func truncate(s string) string {
	const max = 200
	if len(s) > max {
		return s[:max] + "…"
	}
	return s
}

// isTransient reports whether an ingest response status is worth retrying: 5xx and
// explicit backpressure/timeout statuses are; other 4xx are permanent.
func isTransient(status int) bool {
	return status >= 500 || status == http.StatusRequestTimeout || status == http.StatusTooManyRequests
}

var (
	warnedOriginsMu sync.Mutex
	warnedOrigins   = map[string]bool{}
)

// warnIfInsecure warns once per origin when API keys would go over cleartext http to a
// non-local host. Never fails — plain-http LAN self-hosted deployments are legitimate;
// the escape hatch is WithAllowInsecureHTTP or MEMOTURN_ALLOW_HTTP=1.
func warnIfInsecure(baseURL string, allow bool) {
	if allow || os.Getenv("MEMOTURN_ALLOW_HTTP") == "1" {
		return
	}
	u, err := url.Parse(baseURL)
	if err != nil || u.Scheme != "http" {
		return
	}
	switch u.Hostname() {
	case "localhost", "127.0.0.1", "::1":
		return
	}
	warnedOriginsMu.Lock()
	defer warnedOriginsMu.Unlock()
	origin := u.Scheme + "://" + u.Host
	if warnedOrigins[origin] {
		return
	}
	warnedOrigins[origin] = true
	log.Printf("memoturn: sending API keys over cleartext http to %s — use https or set WithAllowInsecureHTTP", u.Host)
}
