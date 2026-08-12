# Roadmap

What Memoturn has shipped, and a prioritized backlog of candidate features. Effort is
rough (S = hours, M = a day or two, L = multi-day). Items are independent unless noted.

## Shipped

Observability (traces / observations / scores, waterfall, sessions, OTel) · metrics &
dashboards · custom widgets (v2: score/error-rate metrics, cost-by-user/session
breakdowns, per-widget filters, multiple named dashboards) · prompt registry + channels ·
playground (multi-provider, streaming, trace-linked, tools + structured output,
**multi-model side-by-side comparison**) · datasets & experiments + comparison matrix · **trace→dataset (bulk + per-observation) + fine-tuning JSONL export (OpenAI + Anthropic)** ·
**dataset CI quality gates** (gate API + GitHub Action + Python SDK) · evaluators (offline
+ online, **template library + version history**, **deterministic code checks**, **LLM juries**,
**whole-conversation thread scope**) · human review queues + assignments ·
score configs · scores on traces · comments + **@mentions with email delivery, per-user
opt-out, and a "mentions me" view** · tags + facets · webhooks + automations
(Slack, **retries + delivery log**) · **alert rules engine** (error-rate / latency-p95 /
cost / ingest-volume / DLQ-depth triggers, firing→resolved lifecycle, email + PagerDuty) ·
**cost budgets** (per-project thresholds + over-budget flag) · auth (sessions + API keys,
social, passwordless, 2FA, passkeys) · organizations + SSO (OIDC + SAML, IdP→org/role
mapping) + RBAC (org **and project-level**) + project switcher · admin plugin ·
auth-lifecycle audit log · data retention · **volume-based usage metering** (bytes / events /
traces per project per UTC day, measured pre-sampling) · rate limiting · NDJSON/CSV/**Parquet** export
+ scheduled blob exports · saved views · batch actions · multimodal media · custom model
prices · **runtime guardrails** (PII / prompt-injection / content-policy endpoint) ·
event sink / CDP forwarding · ⌘K palette · global time range · **agent-graph view
(aggregated mode + failed-path highlighting)** ·
**tool-call analytics** (calls / error rate / latency by tool) · **ingest health console**
(DLQ depth, insert latency, error counters, one-click replay) · **retrieval diagnostics** (cross-trace similarity histogram, weakest retrievals, per-document stats) · **semantic trace search**
(find-similar via exact cosine k-NN) · **trace compare** (side-by-side content diff +
per-observation diff) · **prompt A/B experiments** (weighted sticky split + per-arm score
compare + promote) · **cost attribution by prompt version** · **head + tail ingest sampling** (per-project keep-rate
plus keep-on-error / latency / cost rules) ·
**metric anomaly detection** (rolling-baseline z-score alerts) · MCP server (stdio + remote
Streamable HTTP with OAuth + per-tool RBAC; **`query_traces` / `get_trace` / `get_metrics`
/ `list_scores` reads + `run_evaluator` write**; **`mcp.method.name` / `mcp.session.id`
semconv ingestion**) · provider gateway (Anthropic, OpenAI, **Gemini, Bedrock, Azure,
OpenAI-compatible** for vLLM/Ollama/OpenRouter) · TypeScript + Python + **Go** SDKs (tracing,
OpenAI, LangChain, prompts, OTel exporter, **LlamaIndex (Python)**) · **score-value + score-category
filters** (level-agnostic `scores.<name>` pseudo-columns) · **span-level explorer** (observations
as first-class filterable rows, `GET /v1/observations`) · **evaluator targeting** (judge-prompt
**variable mapping** to trace / named-span / dataset sources, **observation scope**, and
**backfill** over already-ingested traces with a pre-run match count) · **score analytics**
(distribution, timeline, and two-score agreement: correlation / MAE / RMSE, agreement rate,
Cohen's Kappa, per-label F1, confusion matrix) · **SDK build identity on ingest**
(optional `sdk` on the wire, per-project version inventory at `GET /v1/usage/sdks`) ·
**structured evaluator output** (a judge declares numeric / categorical / boolean, so it can
return a label; majority-vote juries for labels) · **remote dataset runs** (register a runner
per dataset; a signed pointer trigger, results reported back via `POST /v1/dataset-run-items`) · **prompt composability**
(`@@@memoturnPrompt:…@@@` includes resolved server-side, cycles refused at save) · **chat
placeholders** (a runtime-filled message-list slot, plus `POST /v1/prompts/{name}/compile`) ·
**dataset item contracts + CSV import** (declared item schema with per-field errors; RFC 4180
import with an explicit column mapping) · **prompt CI/CD automations** (`prompt.created` /
`prompt.updated` / `prompt.label.moved` triggers + a GitHub `repository_dispatch` action).

## Up next — triage workflow

The daily loop is "something looks wrong → find the traces → decide if it's real". Score filters,
the span explorer, evaluator targeting, and score analytics have shipped; this is what's left.

| Feature | Effort | Notes |
| --- | --- | --- |
| **Real full-text search** | M–L | Trace/observation search compiles to `LIKE '%…%'` — a table scan that also misses payloads offloaded to blob (> 256 KB). Needs a Doris inverted index (`MATCH_ANY` / `MATCH_PHRASE`) plus `tsvector`/GIN on the Postgres tier, both behind the existing store method, and a searchable digest indexed at offload time so large bodies stop being a silent hole. Validate the inverted-index-vs-merge-on-write interaction before committing to the design. |

## Adoption blockers

Things that decide whether a team with existing tooling can adopt Memoturn without rewriting it.

| Feature | Effort | Notes |
| --- | --- | --- |
| **Public API breadth** | M | Three remaining holes (the top-level `GET /v1/observations` shipped with the span explorer): org-scoped **provisioning** endpoints (create project, rotate project API keys, manage org/project memberships) so self-hosters can automate tenant setup; **LLM-connection** CRUD so provider credentials can be managed programmatically; and an explicit `DELETE /v1/traces/{id}` for right-to-erasure — the store method exists, only the console bulk path is wired. |

## Improvements to existing features

| Feature | Effort | Notes |
| --- | --- | --- |
| **Project-level default judge model** | S | Every evaluator re-specifies provider + model. A project default (overridable per evaluator) removes the most common setup step and makes template instantiation one click. |
| **Protected prompt labels** | S | Mark a label (`production`) as protected so moving it requires a higher role. Small, and immediately relevant to anyone serving prompts from the registry in production. |
| **Platform-failure notifications** | S | Alert rules cover telemetry conditions; platform failures (a scheduled export that failed, an evaluator blocked on a bad provider key) are only visible if you go looking. Route them to a per-project channel using the existing automation dispatcher. |
| **Webhook auto-disable + failure banner** | S | Deliveries retry and are logged, but a permanently-broken endpoint retries forever and silently. Disable after a failure streak and surface it in the console. |
| **Histogram + pivot-table widgets** | M | The chart set is `line / bar / horizontal_bar / big_number / pie / table`. A latency/cost **histogram** and a **pivot table** (group rows × columns with subtotals) are the two shapes people rebuild by hand today. |
| **Media on dataset items** | S–M | Dataset items are JSON only. Attaching an image or audio file to an item is the remaining piece of the CSV/schema work — multimodal evals can't be expressed without it, and the media-offload path already exists for traces. |
| **Portable dashboard JSON** | M | Export a dashboard (with its widgets inlined) as a versioned JSON envelope, import it into another project or instance. Makes dashboards shareable artifacts and turns "starter dashboards" into content rather than code. |
| **Nested folders for prompts and datasets** | S–M | `Prompt.folder` is a flat string and datasets have none. Path-based folders with breadcrumbs, plus rename/duplicate/delete at the folder level. |
| **Query-language search bar** | L | A keyboard-driven query bar (`level:(ERROR OR WARNING) -env:dev latency:>2 scores.accuracy:<0.5`) as a second controlled editor over the same filter state the facet sidebar owns — never a second source of truth. Score filters have landed, so its most valuable predicates now have something to compile to. A natural-language→filter compiler on top of the provider gateway is a small follow-on, and we'd ship it ungated on self-host. |
| **Public share links** | S–M | `TraceRow.public` exists but nothing reads it. A read-only shared trace (and dashboard) link is the cheapest way for someone to hand a bug report to a colleague who doesn't have an account. |
| **More SDK integrations** | M | Vercel AI SDK (JS), Pydantic AI (Python), Mastra (JS). (TS/Python/Go core SDKs shipped; LlamaIndex, LangChain/LangGraph, CrewAI, Haystack, LiteLLM, Bedrock, vector stores done.) |
| **Project-wide cost-by-prompt** | S | Per-*version* cost shipped; a project-wide "spend per prompt" ranking on the prompts list is the small remaining half. |

## Bigger bets

| Feature | Effort | Notes |
| --- | --- | --- |
| **Durable in-product agent** | XL | The assistant is a bounded, read-only, in-request tool loop today: close the tab and the work is gone. The shape worth building is a **durable** run — executed in the worker against an append-only event log, observed by the browser as a resumable tail, so closing the panel detaches rather than cancels — with **write** tools gated by human-in-the-loop approval on top of RBAC (the model never sees a tool the signed-in user couldn't call manually). A code sandbox for analysis over exported data is the third stage. Needs a design pass before any of it is scheduled. |
| **MCP registry breadth** | M–L | The registry is read-heavy (~20 tools). Agents doing real work need CRUD across dashboards/widgets, review queues, comments, model prices, alerts, and evaluators — plus **schema-introspection** tools (list filterable columns, list metric definitions) so an agent can discover the query grammar instead of guessing it. |
| **Helm chart + Terraform modules** | L | Kubernetes is documented but we publish neither a chart nor infra modules for AWS/GCP/Azure. This is the difference between "self-hostable" and "self-hosted by a platform team on a Friday". |

## Enterprise

Enterprise features (SSO, SAML, RBAC, audit logging, PII guardrails) ship ungated in the
Apache-2.0 core. The items below extend that surface.

| Feature | Effort | Notes |
| --- | --- | --- |
| **SCIM provisioning** | L | The enterprise half of the existing SSO story (directory sync, deprovisioning). Composes with the org + admin plugins. |
| **Verified email domains** | M | Prove ownership of a domain via a DNS TXT record, then auto-join matching users to the org at the right role. The self-serve companion to SSO, and the piece that makes SSO usable without an admin inviting every user by hand. |
| **UI customization** | M | Per-instance logo, accent color, and documentation links, so a platform team can present Memoturn as an internal product. |
| **Extended audit retention + export** | M | Auth-lifecycle audit logs exist; retention tiers and bulk export are the remaining piece. |
| **Data residency** | L | Region pinning for hosted deployments (EU first). Multi-region HA deferred. |
