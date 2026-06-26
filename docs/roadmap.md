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
| **Generalized automations** | M | Generalize webhooks to trigger→action rules over more events (`trace.created`, `eval.completed`) with Slack as an action. |
| **Playground tools + structured output** | M | Tool definitions and JSON-schema structured outputs in the playground (the gateway already abstracts providers). |

## Data platform

| Feature | Effort | Notes |
| --- | --- | --- |
| **Custom model definitions** | M | Per-project model pricing overrides (the cost registry is currently static in `packages/core`). |
| ~~**Batch actions**~~ | Done | Multi-select on the trace table → bulk delete / add-to-dataset / enqueue-for-review (`POST /v1/traces/batch`). |
| **Scheduled blob exports** | M | Recurring exports to a project's own S3/GCS bucket (we have on-demand NDJSON); a worker cron + destination config. |
| ~~**Saved table views**~~ | Done | Persist named filter sets per table (`/v1/saved-views`), applied from the trace explorer. |
| **Multimodal media** | L | Store image/audio/file attachments referenced in traces in blob; render in the trace view. |

## Tenancy & enterprise

| Feature | Effort | Notes |
| --- | --- | --- |
| **Organizations** | L | An org layer above workspace with org-level membership/roles (tenancy change touching auth + schema). |
| **SSO / social login** | M | Add OAuth/SAML providers to the auth layer (the auth library supports them; mostly config + UI). |
| **API rate limiting** | M | Per-project ingestion/API limits backed by Redis. |
| **Worker health/metrics endpoint** | S | A small HTTP health/metrics surface on the worker for liveness + queue depth. |

## Integrations & SDKs

| Feature | Effort | Notes |
| --- | --- | --- |
| **MCP server** | M | Expose prompts / datasets / review queues as MCP tools for agent IDEs. |
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
4. **MCP server** — high-leverage integration surface.

Larger bets (organizations, multimodal media) are scoped separately when prioritized.
