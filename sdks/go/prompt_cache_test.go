package memoturn

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// promptServer serves a versioned prompt and counts requests. Set fail to make every
// subsequent request return 503.
func promptServer(t *testing.T) (*httptest.Server, *int32, *atomic.Bool, *atomic.Int32) {
	t.Helper()
	var hits int32
	var fail atomic.Bool
	var version atomic.Int32
	version.Store(1)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&hits, 1)
		if fail.Load() {
			w.WriteHeader(http.StatusServiceUnavailable)
			_, _ = w.Write([]byte("down"))
			return
		}
		_, _ = fmt.Fprintf(w,
			`{"name":"greet","version":%d,"type":"TEXT","content":"hi","config":{}}`, version.Load())
	}))
	t.Cleanup(srv.Close)
	return srv, &hits, &fail, &version
}

func TestPromptCacheFreshHitSkipsNetwork(t *testing.T) {
	srv, hits, _, _ := promptServer(t)
	mt := New(WithBaseURL(srv.URL), WithFlushInterval(0))

	if _, err := mt.GetPrompt("greet"); err != nil {
		t.Fatalf("first: %v", err)
	}
	if _, err := mt.GetPrompt("greet"); err != nil {
		t.Fatalf("second: %v", err)
	}
	if got := atomic.LoadInt32(hits); got != 1 {
		t.Errorf("requests = %d, want 1 (second resolve should hit the cache)", got)
	}
}

func TestPromptCacheKeyedByChannelAndBucket(t *testing.T) {
	srv, hits, _, _ := promptServer(t)
	mt := New(WithBaseURL(srv.URL), WithFlushInterval(0))

	for _, opts := range [][]PromptOption{
		{WithBucketKey("u1")},
		{WithBucketKey("u2")},
		{WithPromptChannel("staging"), WithBucketKey("u1")},
	} {
		if _, err := mt.GetPrompt("greet", opts...); err != nil {
			t.Fatalf("resolve: %v", err)
		}
	}
	if got := atomic.LoadInt32(hits); got != 3 {
		t.Errorf("requests = %d, want 3 (distinct keys)", got)
	}
	// ...and each is independently cached.
	if _, err := mt.GetPrompt("greet", WithBucketKey("u2")); err != nil {
		t.Fatalf("repeat: %v", err)
	}
	if got := atomic.LoadInt32(hits); got != 3 {
		t.Errorf("requests = %d after repeat, want 3", got)
	}
}

func TestPromptCacheTTLZeroDisablesCaching(t *testing.T) {
	srv, hits, _, _ := promptServer(t)
	mt := New(WithBaseURL(srv.URL), WithFlushInterval(0))

	for i := 0; i < 2; i++ {
		if _, err := mt.GetPrompt("greet", WithPromptCacheTTL(0)); err != nil {
			t.Fatalf("resolve: %v", err)
		}
	}
	if got := atomic.LoadInt32(hits); got != 2 {
		t.Errorf("requests = %d, want 2 (caching disabled)", got)
	}
}

func TestPromptStaleWhileRevalidate(t *testing.T) {
	srv, hits, _, version := promptServer(t)
	mt := New(WithBaseURL(srv.URL), WithFlushInterval(0))

	p, err := mt.GetPrompt("greet", WithPromptCacheTTL(20*time.Millisecond))
	if err != nil {
		t.Fatalf("first: %v", err)
	}
	if p.Version != 1 {
		t.Fatalf("version = %d, want 1", p.Version)
	}

	version.Store(2)
	time.Sleep(40 * time.Millisecond) // let the entry go stale

	// The STALE value comes back immediately; the refresh runs behind it.
	stale, err := mt.GetPrompt("greet", WithPromptCacheTTL(20*time.Millisecond))
	if err != nil {
		t.Fatalf("stale read: %v", err)
	}
	if stale.Version != 1 {
		t.Errorf("stale version = %d, want 1 (caller must not wait on the refresh)", stale.Version)
	}

	// Once the background refresh lands, the next resolve sees the new version.
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		fresh, err := mt.GetPrompt("greet", WithPromptCacheTTL(20*time.Millisecond))
		if err == nil && fresh.Version == 2 {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Errorf("background refresh never landed (requests = %d)", atomic.LoadInt32(hits))
}

func TestPromptServesStaleWhenRefreshFails(t *testing.T) {
	srv, _, fail, _ := promptServer(t)
	mt := New(WithBaseURL(srv.URL), WithFlushInterval(0))

	if _, err := mt.GetPrompt("greet", WithPromptCacheTTL(20*time.Millisecond)); err != nil {
		t.Fatalf("first: %v", err)
	}
	fail.Store(true)
	time.Sleep(40 * time.Millisecond)

	// A memoturn outage must not take down the app that depends on it.
	for i := 0; i < 3; i++ {
		p, err := mt.GetPrompt("greet", WithPromptCacheTTL(20*time.Millisecond))
		if err != nil {
			t.Fatalf("resolve %d during outage: %v", i, err)
		}
		if p.Version != 1 {
			t.Errorf("version = %d, want the cached 1", p.Version)
		}
	}
}

func TestPromptFallbackWhenNothingCached(t *testing.T) {
	srv, _, fail, _ := promptServer(t)
	fail.Store(true)
	mt := New(WithBaseURL(srv.URL), WithFlushInterval(0))

	fb := &CompiledPrompt{Name: "greet", Type: "TEXT", Content: "local default"}
	p, err := mt.GetPrompt("greet", WithPromptFallback(fb))
	if err != nil {
		t.Fatalf("expected the fallback, got error: %v", err)
	}
	if p != fb {
		t.Errorf("prompt = %+v, want the fallback", p)
	}
}

func TestPromptErrorsWithNoCacheAndNoFallback(t *testing.T) {
	srv, _, fail, _ := promptServer(t)
	fail.Store(true)
	mt := New(WithBaseURL(srv.URL), WithFlushInterval(0))

	if _, err := mt.GetPrompt("greet"); err == nil {
		t.Error("expected an error when the fetch fails with nothing cached and no fallback")
	}
}

func TestPromptCachedValuePreferredOverFallback(t *testing.T) {
	srv, _, fail, _ := promptServer(t)
	mt := New(WithBaseURL(srv.URL), WithFlushInterval(0))

	if _, err := mt.GetPrompt("greet", WithPromptCacheTTL(20*time.Millisecond)); err != nil {
		t.Fatalf("first: %v", err)
	}
	fail.Store(true)
	time.Sleep(40 * time.Millisecond)

	fb := &CompiledPrompt{Name: "greet", Type: "TEXT", Content: "local default"}
	p, err := mt.GetPrompt("greet", WithPromptCacheTTL(20*time.Millisecond), WithPromptFallback(fb))
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	if p.Content != "hi" {
		t.Errorf("content = %v, want the cached %q", p.Content, "hi")
	}
}

func TestPromptConcurrentResolvesCoalesce(t *testing.T) {
	srv, hits, _, _ := promptServer(t)
	mt := New(WithBaseURL(srv.URL), WithFlushInterval(0))

	var wg sync.WaitGroup
	errs := make(chan error, 20)
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, err := mt.GetPrompt("greet"); err != nil {
				errs <- err
			}
		}()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Fatalf("concurrent resolve: %v", err)
	}
	if got := atomic.LoadInt32(hits); got != 1 {
		t.Errorf("requests = %d, want 1 (concurrent misses should coalesce)", got)
	}
}

func TestPromptCacheIsBounded(t *testing.T) {
	srv, _, _, _ := promptServer(t)
	mt := New(WithBaseURL(srv.URL), WithFlushInterval(0))

	for i := 0; i < maxPromptCacheEntries+10; i++ {
		if _, err := mt.GetPrompt("greet", WithBucketKey(fmt.Sprintf("u%d", i))); err != nil {
			t.Fatalf("resolve %d: %v", i, err)
		}
	}
	mt.promptMu.Lock()
	size := len(mt.promptCache)
	mt.promptMu.Unlock()
	// A per-user A/B split must not grow the cache without limit.
	if size != maxPromptCacheEntries {
		t.Errorf("cache size = %d, want %d", size, maxPromptCacheEntries)
	}
}

func TestClearPromptCache(t *testing.T) {
	srv, hits, _, _ := promptServer(t)
	mt := New(WithBaseURL(srv.URL), WithFlushInterval(0))

	if _, err := mt.GetPrompt("greet"); err != nil {
		t.Fatalf("first: %v", err)
	}
	mt.ClearPromptCache()
	if _, err := mt.GetPrompt("greet"); err != nil {
		t.Fatalf("second: %v", err)
	}
	if got := atomic.LoadInt32(hits); got != 2 {
		t.Errorf("requests = %d, want 2 (clear should force a refetch)", got)
	}
}
