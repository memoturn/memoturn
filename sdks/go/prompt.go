package memoturn

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"
)

// CompiledPrompt is a deployed prompt resolved from a channel.
type CompiledPrompt struct {
	Name    string         `json:"name"`
	Version int            `json:"version"`
	Type    string         `json:"type"` // TEXT | CHAT
	Content any            `json:"content"`
	Config  map[string]any `json:"config"`
}

// DefaultPromptCacheTTL is how long a fetched prompt stays fresh before a refresh is triggered.
const DefaultPromptCacheTTL = 60 * time.Second

// maxPromptCacheEntries bounds the cache so an A/B split keyed by user id can't grow it without
// limit. Entries are per (name, channel, bucketKey).
const maxPromptCacheEntries = 500

type promptEntry struct {
	prompt   *CompiledPrompt
	expires  time.Time
	inserted int64 // monotonic counter, for oldest-first eviction
}

type promptOpts struct {
	channel   string
	bucketKey string
	cacheTTL  time.Duration
	fallback  *CompiledPrompt
}

// PromptOption configures GetPrompt.
type PromptOption func(*promptOpts)

// WithPromptChannel resolves against a specific channel (default "production").
func WithPromptChannel(ch string) PromptOption { return func(o *promptOpts) { o.channel = ch } }

// WithBucketKey sticks this caller to one A/B arm across resolves (pass a stable session/user id).
func WithBucketKey(key string) PromptOption { return func(o *promptOpts) { o.bucketKey = key } }

// WithPromptCacheTTL overrides how long a fetched prompt stays fresh (default
// DefaultPromptCacheTTL). Pass 0 to disable caching for this call.
func WithPromptCacheTTL(d time.Duration) PromptOption {
	return func(o *promptOpts) { o.cacheTTL = d }
}

// WithPromptFallback supplies a last-resort prompt used when the fetch fails AND nothing is
// cached. Without one, GetPrompt returns the error (the historical behavior).
func WithPromptFallback(p *CompiledPrompt) PromptOption {
	return func(o *promptOpts) { o.fallback = p }
}

// ClearPromptCache drops all cached prompts. For tests, and for forcing a redeploy to take
// effect immediately rather than at the next TTL boundary.
func (c *Client) ClearPromptCache() {
	c.promptMu.Lock()
	defer c.promptMu.Unlock()
	c.promptCache = nil
}

func (c *Client) promptCacheGet(key string) (promptEntry, bool) {
	c.promptMu.Lock()
	defer c.promptMu.Unlock()
	e, ok := c.promptCache[key]
	return e, ok
}

func (c *Client) promptCacheSet(key string, p *CompiledPrompt, ttl time.Duration) {
	c.promptMu.Lock()
	defer c.promptMu.Unlock()
	if c.promptCache == nil {
		c.promptCache = make(map[string]promptEntry)
	}
	c.promptInserts++
	c.promptCache[key] = promptEntry{prompt: p, expires: time.Now().Add(ttl), inserted: c.promptInserts}
	for len(c.promptCache) > maxPromptCacheEntries {
		oldestKey, oldest := "", int64(-1)
		for k, e := range c.promptCache {
			if oldest < 0 || e.inserted < oldest {
				oldestKey, oldest = k, e.inserted
			}
		}
		delete(c.promptCache, oldestKey)
	}
}

// GetPrompt fetches a deployed prompt by name. If the channel runs an A/B split, pass
// WithBucketKey to stick this caller to one arm; the returned Version is what you stamp on the
// resulting generation (GenerationInput.PromptID / PromptVersion).
//
// Prompt resolution sits on the calling app's request path, so results are cached and the call
// degrades rather than failing:
//
//   - Fresh hit (within the TTL): served from memory, no network call.
//   - Stale hit: served immediately while a refresh runs in a background goroutine
//     (stale-while-revalidate), so a slow control plane never adds latency.
//   - Fetch failure with something cached: the stale value keeps being served. A memoturn
//     outage must not take down the app that depends on it.
//   - Fetch failure with nothing cached: WithPromptFallback if given, otherwise the error.
//
// Concurrent resolves of the same key are coalesced into one request. The cache lives on the
// Client, so it is scoped to that client's credentials by construction.
func (c *Client) GetPrompt(name string, opts ...PromptOption) (*CompiledPrompt, error) {
	o := promptOpts{channel: "production", cacheTTL: DefaultPromptCacheTTL}
	for _, opt := range opts {
		opt(&o)
	}
	q := url.Values{}
	q.Set("channel", o.channel)
	if o.bucketKey != "" {
		q.Set("bucketKey", o.bucketKey)
	}
	u := c.baseURL + "/v1/prompts/" + url.PathEscape(name) + "?" + q.Encode()

	if o.cacheTTL > 0 {
		if e, ok := c.promptCacheGet(u); ok {
			if time.Now().Before(e.expires) {
				return e.prompt, nil
			}
			// Stale: refresh behind the caller and hand back what we already have. The error
			// is deliberately dropped — this path exists precisely to absorb failures.
			go func() { _, _ = c.fetchPromptShared(u, o.cacheTTL) }()
			return e.prompt, nil
		}
	}

	p, err := c.fetchPromptShared(u, o.cacheTTL)
	if err != nil {
		// A concurrent call may have populated the cache while we were failing.
		if o.cacheTTL > 0 {
			if e, ok := c.promptCacheGet(u); ok {
				return e.prompt, nil
			}
		}
		if o.fallback != nil {
			return o.fallback, nil
		}
		return nil, err
	}
	return p, nil
}

// fetchPromptShared coalesces concurrent fetches for the same URL: the first caller performs
// the request while the others wait on a channel, then re-read the cache.
func (c *Client) fetchPromptShared(u string, ttl time.Duration) (*CompiledPrompt, error) {
	c.promptMu.Lock()
	if wait, ok := c.promptInflight[u]; ok {
		c.promptMu.Unlock()
		<-wait
		if e, ok := c.promptCacheGet(u); ok {
			return e.prompt, nil
		}
		return nil, fmt.Errorf("getPrompt failed: concurrent fetch for %q did not produce a result", u)
	}
	wait := make(chan struct{})
	if c.promptInflight == nil {
		c.promptInflight = make(map[string]chan struct{})
	}
	c.promptInflight[u] = wait
	c.promptMu.Unlock()

	defer func() {
		c.promptMu.Lock()
		delete(c.promptInflight, u)
		c.promptMu.Unlock()
		close(wait)
	}()

	p, err := c.fetchPrompt(u)
	if err != nil {
		return nil, err
	}
	if ttl > 0 {
		c.promptCacheSet(u, p, ttl)
	}
	return p, nil
}

func (c *Client) fetchPrompt(u string) (*CompiledPrompt, error) {
	req, err := http.NewRequest(http.MethodGet, u, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("authorization", "Basic "+c.basicAuth())

	res, err := c.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		bodyText, _ := io.ReadAll(res.Body)
		return nil, fmt.Errorf("getPrompt failed: %d %s", res.StatusCode, strings.TrimSpace(string(bodyText)))
	}
	var p CompiledPrompt
	if err := json.NewDecoder(res.Body).Decode(&p); err != nil {
		return nil, err
	}
	return &p, nil
}

var varRe = regexp.MustCompile(`\{\{\s*([\w.]+)\s*\}\}`)

// CompileText substitutes {{variable}} placeholders in a TEXT prompt's content. Unknown
// placeholders are left untouched. For CHAT prompts, use CompileChat.
func (p *CompiledPrompt) CompileText(vars map[string]any) string {
	s, _ := p.Content.(string)
	return fill(s, vars)
}

// CompileChat substitutes placeholders in each message of a CHAT prompt, returning
// []{role, content}. Returns nil if the content isn't a message array.
func (p *CompiledPrompt) CompileChat(vars map[string]any) []map[string]string {
	arr, ok := p.Content.([]any)
	if !ok {
		return nil
	}
	out := make([]map[string]string, 0, len(arr))
	for _, m := range arr {
		msg, ok := m.(map[string]any)
		if !ok {
			continue
		}
		role, _ := msg["role"].(string)
		content, _ := msg["content"].(string)
		out = append(out, map[string]string{"role": role, "content": fill(content, vars)})
	}
	return out
}

func fill(text string, vars map[string]any) string {
	if text == "" || len(vars) == 0 {
		return text
	}
	return varRe.ReplaceAllStringFunc(text, func(m string) string {
		key := varRe.FindStringSubmatch(m)[1]
		if v, ok := vars[key]; ok {
			return fmt.Sprintf("%v", v)
		}
		return m
	})
}
