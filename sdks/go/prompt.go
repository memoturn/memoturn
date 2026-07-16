package memoturn

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
)

// CompiledPrompt is a deployed prompt resolved from a channel.
type CompiledPrompt struct {
	Name    string         `json:"name"`
	Version int            `json:"version"`
	Type    string         `json:"type"` // TEXT | CHAT
	Content any            `json:"content"`
	Config  map[string]any `json:"config"`
}

type promptOpts struct {
	channel   string
	bucketKey string
}

// PromptOption configures GetPrompt.
type PromptOption func(*promptOpts)

// WithPromptChannel resolves against a specific channel (default "production").
func WithPromptChannel(ch string) PromptOption { return func(o *promptOpts) { o.channel = ch } }

// WithBucketKey sticks this caller to one A/B arm across resolves (pass a stable session/user id).
func WithBucketKey(key string) PromptOption { return func(o *promptOpts) { o.bucketKey = key } }

// GetPrompt fetches a deployed prompt by name. If the channel runs an A/B split, pass
// WithBucketKey to stick this caller to one arm; the returned Version is what you stamp on the
// resulting generation (GenerationInput.PromptID / PromptVersion).
func (c *Client) GetPrompt(name string, opts ...PromptOption) (*CompiledPrompt, error) {
	o := promptOpts{channel: "production"}
	for _, opt := range opts {
		opt(&o)
	}
	q := url.Values{}
	q.Set("channel", o.channel)
	if o.bucketKey != "" {
		q.Set("bucketKey", o.bucketKey)
	}
	u := c.baseURL + "/v1/prompts/" + url.PathEscape(name) + "?" + q.Encode()
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
