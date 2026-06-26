# Roadmap

A prioritized backlog of candidate features, benchmarked against the broader
LLM-engineering-platform category. Effort is rough (S = hours, M = a day or two,
L = multi-day). Items are independent unless noted.

## Shipped

Observability (traces / observations / scores, waterfall, sessions, OTel) · metrics &
dashboards · custom widgets · prompt registry + channels · playground (multi-provider,
streaming, trace-linked) · datasets & experiments · evaluators (offline + online) ·
human review queues · scores on traces · webhooks (score alerts) · auth (sessions +
API keys) · projects + RBAC + project switcher · audit log · data retention · NDJSON
export · TypeScript + Python SDKs (tracing, OpenAI, LangChain, prompts).

## Collaboration

| Feature | Effort | Notes |
| --- | --- | --- |
| **Comments** | M | Threaded comments on traces/observations/sessions/prompts. New `Comment` table, `/v1/comments` CRUD, thread UI on the trace page. |
| **Tags + tag facets** | S | Traces already carry `tags`; add a tag filter on the trace list, a tags column, and tag management. |
| **Score configs** | M | The `ScoreConfig` model exists but is unused — expose CRUD; enforce allowed names/data-types/categories on score creation; drive the review form from configs. |
| **Annotation assignments** | M | Assign review-queue items to specific users; "my queue" filter. |

## Evaluation depth

| Feature | Effort | Notes |
| --- | --- | --- |
| **Experiment comparison view** | M | Side-by-side run comparison (per-item output + scores across runs). |
| ~~**Generalized automations**~~ | Done | Trigger→action rules (`/v1/automations`): triggers score.created/trace.created/eval.completed, actions webhook + Slack. |
| **Playground tools + structured output** | M | Tool definitions and JSON-schema structured outputs in the playground (the gateway already abstracts providers). |

## Data platform

| Feature | Effort | Notes |
| --- | --- | --- |
| ~~**Custom model definitions**~~ | Done | Per-project model price overrides (`/v1/model-prices`); the worker applies them over the built-in registry at ingest. |
| ~~**Batch actions**~~ | Done | Multi-select on the trace table → bulk delete / add-to-dataset / enqueue-for-review (`POST /v1/traces/batch`). |
| ~~**Scheduled blob exports**~~ | Done | Daily worker cron writes per-project traces (NDJSON) to blob (`/v1/scheduled-exports`, plus run-now). |
| ~~**Saved table views**~~ | Done | Persist named filter sets per table (`/v1/saved-views`), applied from the trace explorer. |
| **Multimodal media** | L | Store image/audio/file attachments referenced in traces in blob; render in the trace view. |

## Tenancy & enterprise

| Feature | Effort | Notes |
| --- | --- | --- |
| ~~**Organizations**~~ | Done | Tenancy via the Better Auth organization plugin (org/member/invitation); projects scoped to an org, role-mapped to our RBAC, console org management. |
| **SSO / social login** | M | Add OAuth/SAML providers to the auth layer (the auth library supports them; mostly config + UI). |
| ~~**API rate limiting**~~ | Done | Per-project Redis fixed-window limiter on `/v1` (`RATE_LIMIT_PER_MINUTE`), 429 + `X-RateLimit-*`/`Retry-After`. |
| **Worker health/metrics endpoint** | S | A small HTTP health/metrics surface on the worker for liveness + queue depth. |

## Integrations & SDKs

| Feature | Effort | Notes |
| --- | --- | --- |
| ~~**MCP server**~~ | Done | Stdio MCP server (`apps/mcp`) exposing prompts / datasets / review queues as tools for agent IDEs. |
| **More OTel coverage** | M | OTLP/protobuf (currently JSON only); richer GenAI semconv mapping. |
| **Product-analytics export** | M | Forward events to an analytics sink (e.g. PostHog) for funnels. |

## UX

| Feature | Effort | Notes |
| --- | --- | --- |
| **Command-K menu** | S | Global navigation/search palette. |
| **Global time-range filter** | S | Shared time window across dashboard/traces/metrics. |
| **Agent-graph view** | M | Graph visualization for agent runs (nodes = observations, edges = parent links). |

## Suggested next slices

1. ~~**Comments** + **Tags/facets**~~ — done.
2. ~~**Score configs**~~ — done.
3. ~~**Batch actions** + **saved table views**~~ — done.
4. ~~**MCP server**~~ — done.

Larger bets (organizations, multimodal media) are scoped separately when prioritized.
