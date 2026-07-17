package memoturn

import (
	"net/http"
	"strings"
	"testing"
)

func TestCheckGuardrails(t *testing.T) {
	js := newJSONServer(`{"verdict":"redact","findings":[{"category":"pii","type":"email","count":2}],"redactedText":"hi [EMAIL]"}`)
	defer js.srv.Close()
	mt := newJSONTestClient(js)

	v, err := mt.CheckGuardrails("hi a@b.com")
	if err != nil {
		t.Fatalf("CheckGuardrails: %v", err)
	}
	method, path, auth, body := js.got()
	if method != http.MethodPost || path != "/v1/guardrails/check" {
		t.Errorf("request = %s %s, want POST /v1/guardrails/check", method, path)
	}
	if auth != "Basic "+mt.basicAuth() {
		t.Errorf("auth = %q", auth)
	}
	if body["text"] != "hi a@b.com" {
		t.Errorf("body = %v", body)
	}
	if v.Verdict != "redact" || v.RedactedText != "hi [EMAIL]" {
		t.Errorf("verdict = %+v", v)
	}
	if len(v.Findings) != 1 || v.Findings[0].Category != "pii" || v.Findings[0].Type != "email" || v.Findings[0].Count != 2 {
		t.Errorf("findings = %+v", v.Findings)
	}
}

func TestCheckGuardrailsErrorPath(t *testing.T) {
	js := newJSONServer(`{"error":"guardrails disabled"}`)
	defer js.srv.Close()
	js.setStatus(http.StatusBadRequest)
	mt := newJSONTestClient(js)

	if _, err := mt.CheckGuardrails("x"); err == nil || !strings.Contains(err.Error(), "400") {
		t.Errorf("error = %v, want 400 in message", err)
	}
}
