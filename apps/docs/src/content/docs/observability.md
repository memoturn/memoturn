---
title: Observability
description: OpenTelemetry traces, metrics, and correlated logs for turns, fibers, tools, memory, and the scale-out control loop.
---

Memoturn integrates [OpenTelemetry](https://opentelemetry.io) for distributed tracing, metrics,
and log correlation. Everything is off by default and a no-op until enabled, so there's zero
overhead unless you opt in. Install the `otel` extra to activate the SDK:

```bash
uv pip install "memoturn[otel]"
```

## Enabling

```bash
MEMOTURN_OTEL_ENABLED=true            # master switch
MEMOTURN_OTEL_SERVICE_NAME=memoturn   # service.name on every signal (default)
MEMOTURN_OTEL_DEPLOYMENT_ENVIRONMENT=production   # -> deployment.environment resource attribute

# The OTLP target uses the STANDARD OpenTelemetry env vars, read natively by the SDK:
OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4317
OTEL_EXPORTER_OTLP_PROTOCOL=grpc      # or http/protobuf
OTEL_EXPORTER_OTLP_HEADERS=authorization=Bearer%20...
```

Traces and metrics export to any OTLP-compatible backend through a collector or directly. If the
SDK isn't present or is misconfigured, the runtime falls back to no-op tracers/meters and keeps
running. Traces and metrics can be gated independently:

```bash
MEMOTURN_OTEL_TRACES_ENABLED=true
MEMOTURN_OTEL_METRICS_ENABLED=true
```

## Traces

Spans are emitted around the runtime's hot paths:

- **Agent turns** — `actor.handle` wraps the whole turn; `agent.turn.step` wraps each model call
  and carries [GenAI semantic-convention](https://opentelemetry.io/docs/specs/semconv/gen-ai/)
  attributes: `gen_ai.system`, `gen_ai.request.model`, `gen_ai.response.finish_reason`, and
  `gen_ai.usage.input_tokens` / `output_tokens` / `cache_read_tokens` / `cache_write_tokens`.
- **Tool calls** — `tool.call` per invocation, with `tool` and `outcome` attributes.
- **Sandbox** — `sandbox.run` around code execution, with `backend` and `compute_s`.
- **Memory** — `memory.recall`, `memory.remember`, `memory.bulk_ingest`, `memory.prune_history`.
- **Compaction** — `session.compact` around history compaction.
- **Fibers** — `fiber.run` for durable background task runs and resumes.
- **HTTP** — automatic FastAPI server spans (the long-lived chat WebSocket and the
  `/health`/`/metrics` scrape endpoints are excluded).

## Metrics

Metrics mirror the [usage metering](/billing/) stream, so the fleet view and the billable view
share attribute names. Tenant and agent ride as attributes on every instrument:

| Instrument | Type | Attributes |
|---|---|---|
| `memoturn.turns` | counter | tenant, agent |
| `memoturn.tokens` | counter | tenant, agent, direction (`input`/`output`/`cache_read`/`cache_write`) |
| `memoturn.tool.calls` | counter | tenant, agent, tool, outcome |
| `memoturn.sandbox.compute_seconds` | counter | tenant, agent, backend |
| `memoturn.turn.duration` | histogram (s) | tenant, agent |
| `memoturn.storage.bytes` | gauge | tenant, agent |
| `memoturn.agents.live` | observable gauge | — |

Two export paths, combinable:

```bash
MEMOTURN_METRICS_OTLP_PUSH_ENABLED=true     # push to the OTLP endpoint (default)
MEMOTURN_METRICS_PROMETHEUS_ENABLED=true    # pull: serve /metrics in Prometheus text format
```

`/metrics` is unauthenticated by default (parity with `/health`) and returns 404 until enabled.
The instruments carry per-tenant aggregate counts, so for production either protect it at the
network layer or set `MEMOTURN_METRICS_AUTH_REQUIRED=true` to require an admin principal. Under
scale-out, `/metrics` is **per-replica** (process-local); cross-replica aggregation belongs to the
OTLP/collector path. High tenant counts also mean high Prometheus series cardinality — prefer the
OTLP path for large fleets.

## Logs

```bash
MEMOTURN_LOG_LEVEL=INFO
MEMOTURN_LOG_FORMAT=json    # one JSON object per line (default: text)
```

With `json`, every record carries `trace_id`/`span_id` fields whenever an OTel span is active, so
logs correlate with traces in your backend. The structured `memoturn.usage` (metering) and
`memoturn.audit` (security audit) streams flow through the same handler, and uvicorn's
access/error logs share the format.

## Running a collector

A commented-out `otel-collector` service ships in `docker-compose.yml`. Minimal collector config:

```yaml
receivers:
  otlp:
    protocols:
      grpc:
        endpoint: 0.0.0.0:4317
      http:
        endpoint: 0.0.0.0:4318
exporters:
  debug:
    verbosity: basic
service:
  pipelines:
    traces:
      receivers: [otlp]
      exporters: [debug]
    metrics:
      receivers: [otlp]
      exporters: [debug]
    logs:
      receivers: [otlp]
      exporters: [debug]
```

Point `OTEL_EXPORTER_OTLP_ENDPOINT` at it and swap the `debug` exporter for your backend's.

## Liveness & readiness

Beyond traces, the server exposes health endpoints for orchestrators (see the
[REST API](/api-rest/)):

- `GET /health` — liveness; returns `{"status":"ok"}`.
- `GET /` — server info: name, version, model, auth mode, and live agent count.

Token usage is reported per turn on the `turn_completed`
[event](/api-websocket/) (input, output, and cache read/write tokens), so cost can be tracked from
the chat stream itself.

## Related

- [Operations](/operations/) — running and monitoring in production.
- [Configuration](/configuration/#observability) — the observability settings.
