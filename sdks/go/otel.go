package memoturn

// OpenTelemetry export helper — point an existing OTel setup at memoturn.
//
// memoturn's OTLP/HTTP receiver (POST /v1/otel/v1/traces) ingests standard OTel spans and
// maps GenAI semantic-convention attributes (gen_ai.*) into traces + generations. This is
// the zero-dependency half of the Python SDK's otlp_config: it pre-wires the endpoint URL
// and Basic-auth header from the client's credentials; you hand both to whichever OTLP
// HTTP exporter you already use.

// OTLPConfig returns the endpoint URL and headers an OTLP/HTTP span exporter needs to send
// traces to memoturn. Wire it into the official Go exporter like so:
//
//	endpoint, headers := mt.OTLPConfig()
//	exp, err := otlptracehttp.New(ctx,
//		otlptracehttp.WithEndpointURL(endpoint),
//		otlptracehttp.WithHeaders(headers),
//	)
//
// (go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp — the SDK itself stays
// dependency-free; only your application imports the exporter.)
func (c *Client) OTLPConfig() (endpoint string, headers map[string]string) {
	return c.baseURL + "/v1/otel/v1/traces", map[string]string{"Authorization": "Basic " + c.basicAuth()}
}
