package memoturn

// Wire types — kept local to the SDK so it stays dependency-free and go-gettable on its own.
// Must stay structurally compatible with @memoturn/core's Zod ingest contracts. Fields use
// `omitempty` so unset values are dropped from the wire body (the "spread" semantics the
// TypeScript/Python SDKs get for free).

// Usage is token usage reported on a generation.
type Usage struct {
	PromptTokens     int `json:"promptTokens,omitempty"`
	CompletionTokens int `json:"completionTokens,omitempty"`
	TotalTokens      int `json:"totalTokens,omitempty"`
}

// RetrievedDocument is a document a retriever/RAG span returned (surfaced in the trace view).
type RetrievedDocument struct {
	ID        string    `json:"id,omitempty"`
	Rank      int       `json:"rank"`
	Score     float64   `json:"score,omitempty"`
	Content   string    `json:"content"`
	Metadata  any       `json:"metadata,omitempty"`
	Embedding []float64 `json:"embedding,omitempty"`
}

// TraceInput describes a trace to start (all fields optional).
type TraceInput struct {
	ID          string   `json:"id,omitempty"`
	Name        string   `json:"name,omitempty"`
	UserID      string   `json:"userId,omitempty"`
	SessionID   string   `json:"sessionId,omitempty"`
	Release     string   `json:"release,omitempty"`
	Version     string   `json:"version,omitempty"`
	Environment string   `json:"environment,omitempty"`
	Tags        []string `json:"tags,omitempty"`
	Metadata    any      `json:"metadata,omitempty"`
	Input       any      `json:"input,omitempty"`
	Output      any      `json:"output,omitempty"`
}

// SpanInput describes a span (a unit of work) inside a trace.
type SpanInput struct {
	ID                  string              `json:"id,omitempty"`
	Name                string              `json:"name,omitempty"`
	ParentObservationID string              `json:"parentObservationId,omitempty"`
	Metadata            any                 `json:"metadata,omitempty"`
	Input               any                 `json:"input,omitempty"`
	Output              any                 `json:"output,omitempty"`
	Level               string              `json:"level,omitempty"` // DEBUG | DEFAULT | WARNING | ERROR
	StatusMessage       string              `json:"statusMessage,omitempty"`
	RetrievedDocuments  []RetrievedDocument `json:"retrievedDocuments,omitempty"`
	Embedding           []float64           `json:"embedding,omitempty"`
}

// GenerationInput describes an LLM generation (a span with model/usage/prompt metadata).
type GenerationInput struct {
	SpanInput
	Model           string         `json:"model,omitempty"`
	Provider        string         `json:"provider,omitempty"`
	ModelParameters map[string]any `json:"modelParameters,omitempty"`
	Usage           *Usage         `json:"usage,omitempty"`
	PromptID        string         `json:"promptId,omitempty"`
	PromptVersion   string         `json:"promptVersion,omitempty"`
}

// ScoreInput attaches a score to a trace (or a specific observation). Value is a pointer so an
// explicit 0 is sent (a common, valid score) rather than being dropped by omitempty.
type ScoreInput struct {
	ID            string   `json:"id,omitempty"`
	Name          string   `json:"name"`
	Value         *float64 `json:"value,omitempty"`
	StringValue   string   `json:"stringValue,omitempty"`
	DataType      string   `json:"dataType,omitempty"` // NUMERIC | CATEGORICAL | BOOLEAN
	Comment       string   `json:"comment,omitempty"`
	ObservationID string   `json:"observationId,omitempty"`
}

// Float is a helper for optional float score values: memoturn.Float(0.9).
func Float(v float64) *float64 { return &v }
