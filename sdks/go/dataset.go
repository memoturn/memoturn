package memoturn

// Datasets, experiment runs, and CI quality gates. Mirrors the Python/JS SDK dataset
// helpers so CI pipelines driven from Go services can create runs and gate them on
// evaluator scores.

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
)

// DatasetItem is one example to add to a dataset: an input, an optional expected
// (reference) output, and optional metadata.
type DatasetItem struct {
	Input          any `json:"input"`
	ExpectedOutput any `json:"expectedOutput,omitempty"`
	Metadata       any `json:"metadata,omitempty"`
}

// AddItemsResult reports the outcome of AddDatasetItems.
type AddItemsResult struct {
	Added   int      `json:"added"`
	ItemIDs []string `json:"itemIds"`
}

// DatasetItemRecord is a stored dataset item, as returned by GetDataset.
type DatasetItemRecord struct {
	ID             string `json:"id"`
	Input          any    `json:"input"`
	ExpectedOutput any    `json:"expectedOutput"`
	Metadata       any    `json:"metadata"`
}

// Dataset is a dataset with its items, as returned by GetDataset.
type Dataset struct {
	Name        string              `json:"name"`
	Description string              `json:"description"`
	Items       []DatasetItemRecord `json:"items"`
}

// RunLink links a dataset item to the trace produced for it during a run.
type RunLink struct {
	DatasetItemID string `json:"datasetItemId"`
	TraceID       string `json:"traceId"`
}

// RunResult is the server's response to RecordRun: the run name and how many items were linked.
type RunResult struct {
	Run    string `json:"run"`
	Linked int    `json:"linked"`
}

// GateThreshold bounds one score for EvaluateGate. Each bound is optional: Min fails the
// gate when the average score is below it, Max when above, and MaxRegression when the
// score dropped more than this amount versus the baseline run (requires baselineRun).
type GateThreshold struct {
	Min           *float64 `json:"min,omitempty"`
	Max           *float64 `json:"max,omitempty"`
	MaxRegression *float64 `json:"maxRegression,omitempty"`
}

// GateResult is the outcome of EvaluateGate — check Passed for CI.
type GateResult struct {
	Passed   bool  `json:"passed"`
	Failures []any `json:"failures"`
	Scores   []any `json:"scores"`
}

// CreateDataset creates a dataset (POST /v1/datasets). Idempotent by name on the server.
func (c *Client) CreateDataset(name, description string) error {
	return c.doJSON(http.MethodPost, "/v1/datasets", kv{"name": name, "description": description}, nil)
}

// AddDatasetItems appends items to the named dataset and returns the created item ids
// (in input order) for linking runs via RecordRun.
func (c *Client) AddDatasetItems(name string, items []DatasetItem) (*AddItemsResult, error) {
	var out AddItemsResult
	path := "/v1/datasets/" + url.PathEscape(name) + "/items"
	if err := c.doJSON(http.MethodPost, path, kv{"items": items}, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// GetDataset fetches the named dataset with all its items.
func (c *Client) GetDataset(name string) (*Dataset, error) {
	var out Dataset
	if err := c.doJSON(http.MethodGet, "/v1/datasets/"+url.PathEscape(name), nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// RecordRun records an experiment run on the named dataset, linking each dataset item to
// the trace produced for it. Pass a non-nil version to pin the dataset version the run
// executed against.
func (c *Client) RecordRun(name, runName string, links []RunLink, version *int) (*RunResult, error) {
	body := kv{"runName": runName, "links": links}
	if version != nil {
		body["version"] = *version
	}
	var out RunResult
	path := "/v1/datasets/" + url.PathEscape(name) + "/runs"
	if err := c.doJSON(http.MethodPost, path, body, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// EvaluateGate gates a run's evaluator scores against thresholds for CI, e.g.
//
//	res, err := mt.EvaluateGate("qa-set", "run-42", map[string]memoturn.GateThreshold{
//		"faithfulness": {Min: memoturn.Float(0.8)},
//		"toxicity":     {Max: memoturn.Float(0.1)},
//	}, "")
//
// Pass baselineRun (or "" for none) to enable MaxRegression bounds. Check GateResult.Passed
// and fail the pipeline when false.
func (c *Client) EvaluateGate(name, runName string, thresholds map[string]GateThreshold, baselineRun string) (*GateResult, error) {
	body := kv{"thresholds": thresholds}
	if baselineRun != "" {
		body["baselineRun"] = baselineRun
	}
	var out GateResult
	path := "/v1/datasets/" + url.PathEscape(name) + "/runs/" + url.PathEscape(runName) + "/gate"
	if err := c.doJSON(http.MethodPost, path, body, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// doJSON sends an authenticated JSON request to path (relative to the base URL), returning
// an error for any non-2xx status and decoding the response into out when out != nil.
func (c *Client) doJSON(method, path string, body any, out any) error {
	var reader io.Reader
	if body != nil {
		payload, err := json.Marshal(body)
		if err != nil {
			return err
		}
		reader = bytes.NewReader(payload)
	}
	req, err := http.NewRequest(method, c.baseURL+path, reader)
	if err != nil {
		return err
	}
	req.Header.Set("authorization", "Basic "+c.basicAuth())
	if body != nil {
		req.Header.Set("content-type", "application/json")
	}
	res, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode > 299 {
		bodyText, _ := io.ReadAll(res.Body)
		return fmt.Errorf("%s %s failed: %d %s", method, path, res.StatusCode, truncate(strings.TrimSpace(string(bodyText))))
	}
	if out != nil {
		return json.NewDecoder(res.Body).Decode(out)
	}
	return nil
}
