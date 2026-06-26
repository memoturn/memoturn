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
| ~~**Annotation assignments**~~ | Done | Assign review items to a user (`/items/{id}/assign`); "assigned to me only" filter on the review page. |

## Evaluation depth

| Feature | Effort | Notes |
| --- | --- | --- |
| ~~**Experiment comparison view**~~ | Done | `GET /v1/datasets/{name}/comparison` items × runs matrix (output + scores per cell); rendered on the dataset page. |
| ~~**Generalized automations**~~ | Done | Trigger→action rules (`/v1/automations`): triggers score.created/trace.created/eval.completed, actions webhook + Slack. |
| ~~**Playground tools + structured output**~~ | Done | Playground modes for JSON-schema structured output (generateObject) and tool calling (surfaces tool calls). |

## Data platform

| Feature | Effort | Notes |
| --- | --- | --- |
| ~~**Custom model definitions**~~ | Done | Per-project model price overrides (`/v1/model-prices`); the worker applies them over the built-in registry at ingest. |
| ~~**Batch actions**~~ | Done | Multi-select on the trace table → bulk delete / add-to-dataset / enqueue-for-review (`POST /v1/traces/batch`). |
| ~~**Scheduled blob exports**~~ | Done | Daily worker cron writes per-project traces (NDJSON) to blob (`/v1/scheduled-exports`, plus run-now). |
| ~~**Saved table views**~~ | Done | Persist named filter sets per table (`/v1/saved-views`), applied from the trace explorer. |
| ~~**Multimodal media**~~ | Done | Inline base64 data URIs offloaded to blob at ingest (`memoturn-media://`), served via `/v1/media`, rendered in the trace view. |

## Tenancy & enterprise

| Feature | Effort | Notes |
| --- | --- | --- |
| ~~**Organizations**~~ | Done | Tenancy via the Better Auth organization plugin (org/member/invitation); projects scoped to an org, role-mapped to our RBAC, console org management. |
| ~~**SSO**~~ | Done | Better Auth `@better-auth/sso` plugin (OIDC/SAML IdPs mapped by email domain → org); register/manage from the Organizations page. Full IdP sign-in needs a real provider. |
| ~~**API rate limiting**~~ | Done | Per-project Redis fixed-window limiter on `/v1` (`RATE_LIMIT_PER_MINUTE`), 429 + `X-RateLimit-*`/`Retry-After`. |
| ~~**Worker health/metrics endpoint**~~ | Done | `node:http` server on the worker (`WORKER_PORT`, default 3002) — `/health` liveness + `/metrics` BullMQ queue depths. |

## Integrations & SDKs

| Feature | Effort | Notes |
| --- | --- | --- |
| ~~**MCP server**~~ | Done | Stdio MCP server (`apps/mcp`) exposing prompts / datasets / review queues as tools for agent IDEs. |
| **More OTel coverage** | M | Richer GenAI semconv mapping done (model params, log level, session/user, deployment env, newer `gen_ai.*.messages`). OTLP/protobuf decode still pending (JSON only). |
| ~~**Product-analytics export**~~ | Done | Per-project PostHog sink (`/v1/analytics-sink`); the worker forwards trace.created/score.created to PostHog's capture API. |

## UX

| Feature | Effort | Notes |
| --- | --- | --- |
| ~~**Command-K menu**~~ | Done | ⌘K palette: fuzzy nav + open-trace-by-id. |
| ~~**Global time-range filter**~~ | Done | Topbar 24h/7d/30d/90d selector shared by dashboard/metrics + traces. |
| ~~**Agent-graph view**~~ | Done | Timeline/Graph toggle on the trace page; SVG graph layered by parent-chain depth. |

## Suggested next slices

1. ~~**Comments** + **Tags/facets**~~ — done.
2. ~~**Score configs**~~ — done.
3. ~~**Batch actions** + **saved table views**~~ — done.
4. ~~**MCP server**~~ — done.

Larger bets (organizations, multimodal media) are scoped separately when prioritized.
