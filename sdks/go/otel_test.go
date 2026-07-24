package memoturn

import "testing"

func TestOTLPConfig(t *testing.T) {
	mt := New(
		WithBaseURL("https://cloud.memoturn.com/"),
		WithCredentials("pk-test", "sk-test"),
		WithFlushInterval(0),
	)
	endpoint, headers := mt.OTLPConfig()
	if endpoint != "https://cloud.memoturn.com/v1/otel/v1/traces" {
		t.Errorf("endpoint = %q", endpoint)
	}
	if got := headers["Authorization"]; got != "Basic "+mt.basicAuth() {
		t.Errorf("Authorization = %q, want basic pk-test:sk-test", got)
	}
	if len(headers) != 1 {
		t.Errorf("headers = %v, want only Authorization", headers)
	}
}
