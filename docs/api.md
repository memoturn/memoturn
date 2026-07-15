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
| POST | `/v1/ingest` | Batched events (`trace-create`, `span/generation-create/update`, `event-create`, `score-create`). Returns `207` with per-event results: schema-invalid events are rejected individually in `errors` (id, index, reason) while valid events are accepted — inspect `errors` to catch silent data loss. Per-event `input`/`output`/`metadata` JSON capped at 1 MB (400 on oversize). Returns `429` when the per-project event rate limit (`INGEST_EVENTS_PER_MINUTE`) is exceeded; `Retry-After` header indicates when to retry. |
| POST | `/v1/otel/v1/traces` | OpenTelemetry OTLP/HTTP (JSON) receiver; maps GenAI semconv spans. |
| GET | `/v1/ingest/health` | Ingest-pipeline health for the ops console: DLQ depth, insert latency, error counters, recent failed batches. OWNER/ADMIN only. |
| POST | `/v1/ingest/dlq/replay` | Re-enqueue dead-lettered batches from blob onto the ingest queue. Body: `{ limit? }`. OWNER/ADMIN only; audited. |
| GET | `/health` | Liveness probe (public, unauthenticated) — `{ status: "ok" }`. |
| GET | `/metrics` | In-process API metrics (request counts, status classes, per-route latency percentiles, in-flight). Token-gated: returns `404` unless `API_METRICS_TOKEN` is set, then requires `Authorization: Bearer <token>`. |

### Traces & sessions

| Method | Path | Description |
| --- | --- | --- |
| GET | `/v1/traces` | Paginated list `{ data, total, scores }` (per-trace score map); paging: `page`, `pageSize` (or legacy `limit`); filters: `userId`, `sessionId`, `environment`, `search` (matches trace name OR observation input/output content), `tag`, `promptId`, `scoreName`, `level`, `days`. |
| GET | `/v1/traces/facets` | Distinct filter facet values + counts (`environment`, `name`, `tags`, `scores`, `levels`) over the range; params: `days`, `limit`, plus active filters (`environment`, `search`, `userId`, `tag`, `scoreName`, `level`) for facet-excluding counts. |
| GET | `/v1/traces/histogram` | Trace volume `{ interval, buckets }` bucketed by hour (ranges ≤ 2 days) or day; honors the trace-list filters (`environment`, `search`, `userId`, `tag`, `scoreName`, `level`, `days`). |
| POST | `/v1/traces/batch` | Bulk action on selected traces: `delete`, `add-to-dataset`, or `review`. |
| GET | `/v1/traces/{id}` | Assembled trace: observations + scores. |
| POST | `/v1/traces/{id}/replay` | Re-run a stored trace's input through the LLM gateway and record the result as a new trace. Body: `{ provider?, model? }`. Audited. |
| POST | `/v1/traces/{id}/annotate` | Add a manual ANNOTATION score to a trace. Body: `{ name, dataType, value?, stringValue?, comment? }`. Audited. |
| POST | `/v1/traces/{id}/tags` | Replace a trace's tags (merge-on-write). Body: `{ tags: string[] }`. Audited. |
| GET | `/v1/sessions` | Paginated sessions `{ data, total }` (traces grouped by `sessionId`); paging: `page`, `pageSize` (or legacy `limit`); scoped by `days`; `search` filters by `sessionId` substring. |
| GET | `/v1/users` | Paginated end users `{ data, total }` (traces grouped by `userId`); paging: `page`, `pageSize` (or legacy `limit`); scoped by `days`; `search` filters by `userId` substring. |
| GET | `/v1/metrics` | Cost/token/latency rollups by day and model (`days` query). |
| GET | `/v1/metrics/tools` | Per-tool analytics — call volume, error rate, and p50/p95/avg latency by tool name (named SPAN observations) over `days`. The top agent-debugging view. |

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
| GET | `/v1/datasets/{name}/comparison` | Compare a dataset's runs side by side (per-item output + scores). Optional `version` scopes to runs of one dataset version. |
| POST | `/v1/datasets/{name}/items` | Append items. |
| POST | `/v1/datasets/{name}/runs` | Record an experiment run (link items → traces). Optional `version` pins the run to a dataset version (defaults to current). |
| POST | `/v1/datasets/{name}/runs/{runId}/gate` | CI quality gate: aggregate a run's scores and check them against `thresholds` (`{ scoreName: { min?, max?, maxRegression? } }`; optional `baselineRun` for regression). Returns `{ passed, failures[], scores[] }` for a CI exit code. Read-only. |
| GET | `/v1/datasets/{name}/versions` | List a dataset's immutable version snapshots. |
| POST | `/v1/datasets/{name}/versions` | Cut a new version (freeze the current items). Body: `{ label?, description? }`. Audited. |
| GET | `/v1/datasets/{name}/versions/{version}` | A version's frozen items. |

### Playground

| Method | Path | Description |
| --- | --- | --- |
| POST | `/v1/playground/chat` | One-shot completion. `trace:true` (default) records it as a trace. |
| POST | `/v1/playground/stream` | Streaming completion (SSE: `data: {"delta":...}` then `[DONE]`). |

### Evaluators

| Method | Path | Description |
| --- | --- | --- |
| GET / POST | `/v1/evaluators` | List / create (supports `online`, `samplingRate`, `filterName`). |
| GET | `/v1/evaluators/analytics` | Per-evaluator EVAL score summary (avg, count) + daily trend (`days` query, default 30). |
| GET | `/v1/evaluators/templates` | The prebuilt evaluator library (RAG/quality judge templates). |
| POST | `/v1/evaluators/from-template` | Instantiate a template into a project evaluator. Body: `{ key, name?, provider?, model?, ... }`. Audited. |
| GET | `/v1/evaluators/{name}/versions` | Immutable judge-config version history (newest first). A version bumps when the prompt/model/provider changes, so online score drift is attributable to a config change. |
| POST | `/v1/evaluators/{name}/run` | Run over a trace's input/output → writes an `EVAL` score. |

### Experiments

Server-executed experiments run a prompt/model across a dataset and auto-score each item (a BullMQ job on the worker); results surface through the dataset comparison grid.

| Method | Path | Description |
| --- | --- | --- |
| GET / POST | `/v1/experiments` | List / create + enqueue. Create body: `{ datasetName, name, provider?, model, params?, promptName?, promptChannel?, evaluators? }`. Audited. |
| GET | `/v1/experiments/{id}` | Config, progress counters, and per-item results. |
| GET | `/v1/experiments/{id}/comparison` | The experiment's results as an items × runs grid. |
| POST | `/v1/experiments/{id}/cancel` | Cancel a pending/running experiment. Audited. |

### Embeddings

| Method | Path | Description |
| --- | --- | --- |
| GET | `/v1/embeddings/projection` | 2D PCA projection of observation embeddings (clusters + optional `colorBy` score). Computed by the daily worker cron. Params: `runId?`, `colorBy?`, `limit?`. |
| POST | `/v1/embeddings/projection/run` | Recompute the projection on demand (instead of waiting for the daily cron). Audited. |

### Review queues

| Method | Path | Description |
| --- | --- | --- |
| GET / POST | `/v1/review-queues` | List / create. |
| GET | `/v1/review-queues/analytics` | Per-queue review throughput (pending/done/skipped totals). |
| POST | `/v1/review-queues/{name}/items` | Enqueue traces. |
| GET | `/v1/review-queues/{name}/items` | Pending items with trace input/output. |
| POST | `/v1/review-queues/{name}/items/{itemId}/assign` | Assign an item to a user (empty `assigneeId` unassigns; defaults to self). |
| POST | `/v1/review-queues/{name}/items/{itemId}/score` | Submit a human `ANNOTATION` score. |
| POST | `/v1/review-queues/{name}/items/{itemId}/skip` | Skip an item without scoring it (marks it `SKIPPED`). |

### Providers

| Method | Path | Description |
| --- | --- | --- |
| GET / POST | `/v1/providers` | List (masked) / add an encrypted provider connection. Body: `{ provider, apiKey?, baseUrl?, region? }`. Providers: `anthropic`, `openai`, `gemini`, `bedrock` (needs `region`), `azure` (needs `baseUrl`), `openai_compatible` (needs `baseUrl`; covers vLLM/Ollama/OpenRouter). Credentials stored as an encrypted JSON config blob. |

### Dashboards, scoring & collaboration

| Method | Path | Description |
| --- | --- | --- |
| GET / POST | `/v1/widgets` | List dashboard widgets (with computed data series) / create. |
| DELETE | `/v1/widgets/{id}` | Delete a dashboard widget. |
| GET / POST | `/v1/score-configs` | List / create-update a score config. |
| DELETE | `/v1/score-configs/{id}` | Delete a score config. |
| PATCH | `/v1/scores/{id}` | Correct a score's `value`/`stringValue`/`comment` (inserts a replacement row; audited). |
| DELETE | `/v1/scores/{id}` | Hard-delete a score (Doris `DELETE`, project-scoped). |
| GET / POST | `/v1/saved-views` | List / save a table view (named set of filters). |
| DELETE | `/v1/saved-views/{id}` | Delete a saved view. |
| GET / POST | `/v1/comments` | List comments on an object (trace/observation/session/prompt) / add one. |
| DELETE | `/v1/comments/{id}` | Delete a comment. |

### Webhooks & automations

Webhook and automation target URLs are SSRF-validated on write: private IP ranges, loopback addresses, and cloud metadata endpoints are rejected with `400` (override with `ALLOW_PRIVATE_WEBHOOK_TARGETS=1` for dev/LAN). The same check runs again at dispatch time to guard against DNS rebinding. Webhook deliveries carry `X-Memoturn-Signature: sha256=<hmac>` (HMAC-SHA256 of `timestamp.body` using the webhook secret) and `X-Memoturn-Timestamp`; the `secret` is returned once on creation and never again.

| Method | Path | Description |
| --- | --- | --- |
| GET / POST | `/v1/webhooks` | List (includes `lastStatus`/`lastError`/`lastAttemptAt`/`failureCount` delivery tracking) / create a webhook (POSTs on an event; `score.created` supports a low-score threshold). `secret` returned once on `201`. |
| DELETE | `/v1/webhooks/{id}` | Delete a webhook. |
| GET / POST | `/v1/automations` | List / create a trigger→action automation (trigger: `score.created`/`trace.created`/`eval.completed`; action: `webhook`/`slack`). Target URL is SSRF-validated. |
| DELETE | `/v1/automations/{id}` | Delete an automation. |
| GET / POST | `/v1/alerts` | List / create a stateful alert rule. A worker cron evaluates `metric` (`error_rate`/`latency_p95`/`cost_per_day`/`ingest_volume`/`dlq_depth`) over a trailing `window` (minutes) against `threshold` per `comparator` (`gt`/`gte`/`lt`/`lte`), notifying `channels` (`[{ type, target }]`; type = `slack`/`webhook` (URL, SSRF-validated), `pagerduty` (Events-API routing key; auto-resolves), or `email` (address; needs an email transport configured)) once on firing and once on resolve. |
| PATCH / DELETE | `/v1/alerts/{id}` | Update (e.g. toggle `enabled`, adjust `threshold`/`channels`) / delete an alert rule. |
| GET / PUT / DELETE | `/v1/budgets` | Get / set / remove the project's monthly cost budget (`monthlyUsd` + `thresholds` steps, default 50/80/100%). Notifies `channels` as month-to-date spend crosses each step. Soft only — no hard caps. |

### Media / attachments

Multimodal attachments (images, audio, files). Inline base64 data URIs in trace/observation input/output are offloaded to blob storage at ingest time and replaced with a `memoturn-media://<key>` reference, so large payloads never bloat Doris; the console fetches them back through the `GET` route. Both routes require auth and are project-scoped.

| Method | Path | Description |
| --- | --- | --- |
| POST | `/v1/media` | Store a base64 data URI (`{ "dataUri": "data:<mime>;base64,…" }`). Returns `201` with `{ key, mimeType, url }`. |
| GET | `/v1/media/{key}` | Fetch raw bytes back with the stored `content-type` (immutable, long-cache). `404` if the key isn't in the caller's project. |
| GET | `/v1/payloads/{key}` | Fetch a large input/output payload that was offloaded to blob at ingest (> 256 KB). The trace stores a `{ "_truncated": true, "ref": "memoturn-blob://<key>", "preview": … }` marker; this returns the full serialized value. Project-scoped — `404` if the key isn't `payloads/<projectId>/…`. |

### Platform

| Method | Path | Description |
| --- | --- | --- |
| GET | `/v1/projects` | Projects the caller can access (with role). |
| GET | `/v1/audit-logs` | Recent audit entries. |
| GET / POST | `/v1/retention` | Get / set retention (days; 0 = keep forever). |
| POST | `/v1/retention/apply` | Apply retention now. |
| GET / POST | `/v1/model-prices` | List / create-update custom model price overrides (matched by name pattern, override built-ins). |
| DELETE | `/v1/model-prices/{id}` | Delete a model price override. |
| GET | `/v1/exports/traces` | Download traces as NDJSON (`application/x-ndjson`, default) or CSV (`?format=csv`); honors the trace-list filters: `limit`, `environment`, `search`, `userId`, `tag`, `scoreName`, `level`, `days`. |
| GET / POST | `/v1/scheduled-exports` | Get / configure the recurring daily NDJSON export of traces to blob storage. |
| POST | `/v1/scheduled-exports/run` | Run the export now and write the NDJSON to blob storage. |
| GET / POST | `/v1/masking` | Get / configure the PII redaction policy (built-in + custom patterns) applied to trace input/output at ingest. |
| GET / POST | `/v1/analytics-sink` | Get / configure the event sink — forwarding trace/score events to a product-analytics/CDP endpoint (PostHog-compatible capture API). POST `host` URL is SSRF-validated (400 on private/loopback targets). |
| GET / POST | `/v1/api-keys` | List project API keys (public key + hint) / mint a new pair (secret returned once). |
| DELETE | `/v1/api-keys/{id}` | Revoke an API key. |
| GET | `/v1/health` | Liveness (no auth). |
| `*` | `/auth/*` | Better Auth (sign-in/out, session). |

### MCP (remote, per-project)

A remote [Model Context Protocol](https://modelcontextprotocol.io) endpoint exposing the project's prompts, datasets, and review queues as tools for agent IDEs — the same tool registry (`packages/server/src/mcp-tools.ts`) the local stdio server (`apps/mcp`) serves, over Streamable HTTP. Each project is its own MCP resource, so clients connect per-project. RBAC is per-tool (not per-method — every call is a POST): a tool's mutating flag maps to a `read`/`write` permission, and write tools are audited.

Two auth paths resolve to the same per-project authorization:

- **API-key Basic** (`pk-mt-…:sk-mt-…`, self-host / headless) — the key must belong to the `{projectId}` in the URL; the tool's permission is checked against the key's `read`/`write` scope.
- **OAuth 2.1 bearer** (memoturn cloud, IDE click-through) — the Better Auth `mcp()` plugin issues the token; it resolves to a user, who is then authorized against `{projectId}` (org membership → role). Any member may run read tools; only non-`VIEWER` roles may run write tools. Clients discover the flow via the two `.well-known` documents below; an unauthenticated request returns `401` with `WWW-Authenticate: Bearer resource_metadata="…"`.

| Method | Path | Description |
| --- | --- | --- |
| `GET / POST / DELETE` | `/v1/mcp/{projectId}` | Streamable-HTTP MCP endpoint scoped to `{projectId}`. `401` (advertising `Bearer` + `Basic`) when auth is missing/invalid or the caller isn't authorized for the project. |
| GET | `/.well-known/oauth-authorization-server` | OAuth authorization-server metadata (Better Auth `mcp()` plugin). |
| GET | `/.well-known/oauth-protected-resource` | OAuth protected-resource metadata. |

> Behind Caddy (single-VM prod), the two `.well-known/oauth-*` paths are routed to the API (they're served at the domain root, not the console) — see `infra/Caddyfile`. The OAuth authorize flow bounces unauthenticated users to the console sign-in page (`MCP_LOGIN_PAGE`, default `<first AUTH_TRUSTED_ORIGINS>/login`).
