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

// jsonServer records the last request (method, path, auth, body) and answers with a
// settable status + JSON body.
type jsonServer struct {
	mu       sync.Mutex
	method   string
	path     string
	auth     string
	body     map[string]any
	status   int
	response string
	srv      *httptest.Server
}

func newJSONServer(response string) *jsonServer {
	js := &jsonServer{status: http.StatusOK, response: response}
	js.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		js.mu.Lock()
		js.method = r.Method
		js.path = r.URL.EscapedPath()
		js.auth = r.Header.Get("authorization")
		js.body = nil
		if b, _ := io.ReadAll(r.Body); len(b) > 0 {
			_ = json.Unmarshal(b, &js.body)
		}
		status, resp := js.status, js.response
		js.mu.Unlock()
		w.WriteHeader(status)
		_, _ = w.Write([]byte(resp))
	}))
	return js
}

func (js *jsonServer) setStatus(code int) {
	js.mu.Lock()
	js.status = code
	js.mu.Unlock()
}

func (js *jsonServer) got() (method, path, auth string, body map[string]any) {
	js.mu.Lock()
	defer js.mu.Unlock()
	return js.method, js.path, js.auth, js.body
}

func newJSONTestClient(js *jsonServer) *Client {
	return New(WithBaseURL(js.srv.URL), WithCredentials("pk-test", "sk-test"), WithFlushInterval(0))
}

func TestCreateDataset(t *testing.T) {
	js := newJSONServer(`{"name":"qa set"}`)
	defer js.srv.Close()
	mt := newJSONTestClient(js)

	if err := mt.CreateDataset("qa set", "golden questions"); err != nil {
		t.Fatalf("CreateDataset: %v", err)
	}
	method, path, auth, body := js.got()
	if method != http.MethodPost || path != "/v1/datasets" {
		t.Errorf("request = %s %s, want POST /v1/datasets", method, path)
	}
	if auth != "Basic "+mt.basicAuth() {
		t.Errorf("auth = %q, want basic pk-test:sk-test", auth)
	}
	if body["name"] != "qa set" || body["description"] != "golden questions" {
		t.Errorf("body = %v", body)
	}
}

func TestAddDatasetItems(t *testing.T) {
	js := newJSONServer(`{"added":2,"itemIds":["it-1","it-2"]}`)
	defer js.srv.Close()
	mt := newJSONTestClient(js)

	res, err := mt.AddDatasetItems("qa/set", []DatasetItem{
		{Input: "q1", ExpectedOutput: "a1"},
		{Input: "q2", Metadata: map[string]any{"difficulty": "hard"}},
	})
	if err != nil {
		t.Fatalf("AddDatasetItems: %v", err)
	}
	method, path, _, body := js.got()
	if method != http.MethodPost || path != "/v1/datasets/qa%2Fset/items" {
		t.Errorf("request = %s %s, want POST /v1/datasets/qa%%2Fset/items (name escaped)", method, path)
	}
	items, ok := body["items"].([]any)
	if !ok || len(items) != 2 {
		t.Fatalf("body items = %v, want 2", body["items"])
	}
	first := items[0].(map[string]any)
	if first["input"] != "q1" || first["expectedOutput"] != "a1" {
		t.Errorf("first item = %v", first)
	}
	if _, present := first["metadata"]; present {
		t.Error("unset metadata should be dropped by omitempty")
	}
	if res.Added != 2 || len(res.ItemIDs) != 2 || res.ItemIDs[0] != "it-1" {
		t.Errorf("result = %+v", res)
	}
}

func TestGetDataset(t *testing.T) {
	js := newJSONServer(`{"name":"qa","description":"d","items":[{"id":"it-1","input":"q1","expectedOutput":"a1","metadata":null}]}`)
	defer js.srv.Close()
	mt := newJSONTestClient(js)

	ds, err := mt.GetDataset("qa")
	if err != nil {
		t.Fatalf("GetDataset: %v", err)
	}
	method, path, auth, _ := js.got()
	if method != http.MethodGet || path != "/v1/datasets/qa" {
		t.Errorf("request = %s %s, want GET /v1/datasets/qa", method, path)
	}
	if auth == "" {
		t.Error("missing auth header")
	}
	if ds.Name != "qa" || len(ds.Items) != 1 || ds.Items[0].ID != "it-1" || ds.Items[0].Input != "q1" {
		t.Errorf("dataset = %+v", ds)
	}
}

func TestRecordRun(t *testing.T) {
	tests := []struct {
		name        string
		version     *int
		wantVersion any
	}{
		{"without version", nil, nil},
		{"with version", intPtr(3), float64(3)},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			js := newJSONServer(`{"run":"run-1","linked":1}`)
			defer js.srv.Close()
			mt := newJSONTestClient(js)

			res, err := mt.RecordRun("qa", "run-1", []RunLink{{DatasetItemID: "it-1", TraceID: "tr-1"}}, tt.version)
			if err != nil {
				t.Fatalf("RecordRun: %v", err)
			}
			method, path, _, body := js.got()
			if method != http.MethodPost || path != "/v1/datasets/qa/runs" {
				t.Errorf("request = %s %s, want POST /v1/datasets/qa/runs", method, path)
			}
			if body["runName"] != "run-1" {
				t.Errorf("runName = %v", body["runName"])
			}
			links := body["links"].([]any)
			link := links[0].(map[string]any)
			if link["datasetItemId"] != "it-1" || link["traceId"] != "tr-1" {
				t.Errorf("link = %v", link)
			}
			got, present := body["version"]
			if tt.wantVersion == nil && present {
				t.Errorf("version should be omitted, got %v", got)
			}
			if tt.wantVersion != nil && got != tt.wantVersion {
				t.Errorf("version = %v, want %v", got, tt.wantVersion)
			}
			if res.Run != "run-1" || res.Linked != 1 {
				t.Errorf("result = %+v", res)
			}
		})
	}
}

func TestEvaluateGate(t *testing.T) {
	tests := []struct {
		name         string
		baselineRun  string
		wantBaseline any
		hasBaseline  bool
	}{
		{"without baseline", "", nil, false},
		{"with baseline", "main", "main", true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			js := newJSONServer(`{"passed":false,"failures":[{"score":"faithfulness"}],"scores":[{"name":"faithfulness","avg":0.7}]}`)
			defer js.srv.Close()
			mt := newJSONTestClient(js)

			res, err := mt.EvaluateGate("qa", "run 1", map[string]GateThreshold{
				"faithfulness": {Min: Float(0.8)},
				"toxicity":     {Max: Float(0.1), MaxRegression: Float(0.05)},
			}, tt.baselineRun)
			if err != nil {
				t.Fatalf("EvaluateGate: %v", err)
			}
			method, path, _, body := js.got()
			if method != http.MethodPost || path != "/v1/datasets/qa/runs/run%201/gate" {
				t.Errorf("request = %s %s, want POST /v1/datasets/qa/runs/run%%201/gate (run name escaped)", method, path)
			}
			thresholds := body["thresholds"].(map[string]any)
			faith := thresholds["faithfulness"].(map[string]any)
			if faith["min"] != 0.8 {
				t.Errorf("faithfulness threshold = %v", faith)
			}
			if _, present := faith["max"]; present {
				t.Error("unset max should be dropped by omitempty")
			}
			tox := thresholds["toxicity"].(map[string]any)
			if tox["max"] != 0.1 || tox["maxRegression"] != 0.05 {
				t.Errorf("toxicity threshold = %v", tox)
			}
			got, present := body["baselineRun"]
			if present != tt.hasBaseline {
				t.Errorf("baselineRun present = %v, want %v", present, tt.hasBaseline)
			}
			if tt.hasBaseline && got != tt.wantBaseline {
				t.Errorf("baselineRun = %v, want %v", got, tt.wantBaseline)
			}
			if res.Passed || len(res.Failures) != 1 || len(res.Scores) != 1 {
				t.Errorf("result = %+v", res)
			}
		})
	}
}

func TestDoJSONNon2xxReturnsError(t *testing.T) {
	js := newJSONServer(`{"error":"dataset not found"}`)
	defer js.srv.Close()
	js.setStatus(http.StatusNotFound)
	mt := newJSONTestClient(js)

	_, err := mt.GetDataset("missing")
	if err == nil {
		t.Fatal("want error on 404")
	}
	for _, want := range []string{"404", "GET /v1/datasets/missing", "dataset not found"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("error %q missing %q", err, want)
		}
	}
	if err := mt.CreateDataset("x", ""); err == nil || !strings.Contains(err.Error(), "404") {
		t.Errorf("CreateDataset error = %v, want status in message", err)
	}
}

func intPtr(v int) *int { return &v }
