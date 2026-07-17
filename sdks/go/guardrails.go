package memoturn

// Runtime guardrails: scan text for PII, prompt injection, and blocked terms. Mirrors the
// Python/JS SDK checkGuardrails helpers.

import "net/http"

// GuardrailFinding is one match reported by a guardrail check.
type GuardrailFinding struct {
	Category string `json:"category"` // "pii" | "injection" | "blocked_term"
	Type     string `json:"type"`
	Count    int    `json:"count"`
}

// GuardrailVerdict is the result of CheckGuardrails: "allow", "redact", or "block".
type GuardrailVerdict struct {
	Verdict  string             `json:"verdict"` // "allow" | "redact" | "block"
	Findings []GuardrailFinding `json:"findings"`
	// RedactedText is present only when the verdict is "redact": the input with PII replaced.
	RedactedText string `json:"redactedText,omitempty"`
}

// CheckGuardrails scans text against the project's runtime guardrails (PII, prompt
// injection, blocked terms) and returns a verdict. Call it before sending user content to
// an LLM, or before returning a model's output; on a "redact" verdict use RedactedText.
func (c *Client) CheckGuardrails(text string) (*GuardrailVerdict, error) {
	var out GuardrailVerdict
	if err := c.doJSON(http.MethodPost, "/v1/guardrails/check", kv{"text": text}, &out); err != nil {
		return nil, err
	}
	return &out, nil
}
