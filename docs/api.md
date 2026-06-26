# REST API

Base URL: `http://localhost:3001` (dev). Interactive reference (Scalar) at
[`/docs`](http://localhost:3001/docs); machine-readable [`/openapi.json`](http://localhost:3001/openapi.json)
generated from the shared zod contracts.

## Authentication

Every `/v1/*` route (except `/v1/health`) accepts **either**:

- **API key** — HTTP Basic auth with `publicKey` as username, `secretKey` as password.
  Scoped to one project. Used by SDKs.
  ```bash
  curl -u pk-mt-dev:sk-mt-dev http://localhost:3001/v1/metrics
  ```
- **Session cookie** — Better Auth session (dashboard). The active project is selected
  via the `x-memoturn-project` header (defaults to the user's first project).

Write endpoints require a non-`VIEWER` role (viewers get `403`).

## Endpoints

### Ingestion

| Method | Path | Description |
| --- | --- | --- |
| POST | `/v1/ingest` | Batched events (`trace-create`, `span/generation-create/update`, `event-create`, `score-create`). Returns `207`. |
| POST | `/v1/otel/v1/traces` | OpenTelemetry OTLP/HTTP (JSON) receiver; maps GenAI semconv spans. |

### Traces & sessions

| Method | Path | Description |
| --- | --- | --- |
| GET | `/v1/traces` | List; filters: `limit`, `userId`, `sessionId`, `environment`, `search`. |
| GET | `/v1/traces/{id}` | Assembled trace: observations + scores. |
| GET | `/v1/sessions` | Sessions (traces grouped by `sessionId`). |
| GET | `/v1/metrics` | Cost/token/latency rollups by day and model (`days` query). |

### Prompts

| Method | Path | Description |
| --- | --- | --- |
| GET | `/v1/prompts` | List prompts with channels + latest version. |
| POST | `/v1/prompts` | Create a new version; `labels` point channels at it. |
| GET | `/v1/prompts/{name}/detail` | All versions + channels. |
| GET | `/v1/prompts/{name}?channel=` | Resolve a deployed prompt (SDK path). |

### Datasets & experiments

| Method | Path | Description |
| --- | --- | --- |
| GET / POST | `/v1/datasets` | List / create. |
| GET | `/v1/datasets/{name}` | Items + runs. |
| POST | `/v1/datasets/{name}/items` | Append items. |
| POST | `/v1/datasets/{name}/runs` | Record an experiment run (link items → traces). |

### Playground

| Method | Path | Description |
| --- | --- | --- |
| POST | `/v1/playground/chat` | One-shot completion. `trace:true` (default) records it as a trace. |
| POST | `/v1/playground/stream` | Streaming completion (SSE: `data: {"delta":...}` then `[DONE]`). |

### Evaluators

| Method | Path | Description |
| --- | --- | --- |
| GET / POST | `/v1/evaluators` | List / create (supports `online`, `samplingRate`, `filterName`). |
| POST | `/v1/evaluators/{name}/run` | Run over a trace's input/output → writes an `EVAL` score. |

### Review queues

| Method | Path | Description |
| --- | --- | --- |
| GET / POST | `/v1/review-queues` | List / create. |
| POST | `/v1/review-queues/{name}/items` | Enqueue traces. |
| GET | `/v1/review-queues/{name}/items` | Pending items with trace input/output. |
| POST | `/v1/review-queues/{name}/items/{itemId}/score` | Submit a human `ANNOTATION` score. |

### Providers

| Method | Path | Description |
| --- | --- | --- |
| GET / POST | `/v1/providers` | List (masked) / add an encrypted provider API key. |

### Platform

| Method | Path | Description |
| --- | --- | --- |
| GET | `/v1/projects` | Projects the caller can access (with role). |
| GET | `/v1/audit-logs` | Recent audit entries. |
| GET / POST | `/v1/retention` | Get / set retention (days; 0 = keep forever). |
| POST | `/v1/retention/apply` | Apply retention now. |
| GET | `/v1/exports/traces` | NDJSON export (download). |
| GET | `/v1/health` | Liveness (no auth). |
| `*` | `/auth/*` | Better Auth (sign-in/out, session). |
