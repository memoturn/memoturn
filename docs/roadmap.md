# Roadmap

A prioritized backlog of candidate features, benchmarked against the broader
LLM-engineering-platform category (July 2026 competitive analysis). Effort is rough
(S = hours, M = a day or two, L = multi-day). Items are independent unless noted.

**Strategy:** close the gaps that lose head-to-head evaluations (alerting, cost
budgets, provider breadth, dashboards), deepen the two differentiators nobody else
owns (trustworthy ingest, MCP-native platform), and build the enterprise compliance
layer as the paid surface — everything else stays Apache-2.0.

## Shipped

Observability (traces / observations / scores, waterfall, sessions, OTel) · metrics &
dashboards · custom widgets · prompt registry + channels · playground (multi-provider,
streaming, trace-linked, tools + structured output) · datasets & experiments +
comparison matrix · evaluators (offline + online) · human review queues + assignments ·
score configs · scores on traces · comments · tags + facets · webhooks + automations
(Slack) · auth (sessions + API keys) · organizations + SSO + RBAC + project switcher ·
audit log · data retention · rate limiting · NDJSON/CSV export + scheduled blob
exports · saved views · batch actions · multimodal media · custom model prices ·
product-analytics sink (PostHog) · ⌘K palette · global time range · agent-graph view ·
MCP server (stdio + remote Streamable HTTP with OAuth + per-tool RBAC) ·
TypeScript + Python SDKs (tracing, OpenAI, LangChain, prompts).

## Horizon 1 — gap closers (pre-cloud-launch)

Items where an evaluation against Langfuse / Braintrust / LangSmith hits a wall today.

| Feature | Effort | Notes |
| --- | --- | --- |
| **Alert rules engine** | L | Extend automations (trigger→action) into stateful alerts: error-rate / latency-p95 / cost-per-day / ingest-volume / DLQ-depth triggers evaluated by a worker cron (reuse `withLock`), firing→resolved lifecycle, email + PagerDuty channels alongside webhook/Slack. Weakest area vs. every competitor. |
| **Cost budgets** | M | Per-project monthly budget with 50/80/100% threshold alerts (via alert engine) and a soft over-budget flag on traces. Builds on existing cost rollups; no hard caps (we're not a gateway). |
| **Provider breadth** | M | Add Gemini, Bedrock, Azure OpenAI, and a generic OpenAI-compatible base-URL provider (covers vLLM/Ollama/OpenRouter) to `packages/llm`. Pays off 3×: playground, LLM-as-judge evaluators, trace replay. |
| **Dashboard flexibility** | L | Widget builder v2: score/error-rate metrics, cost-by-user/session breakdowns, per-widget filters (env, model, tags), multiple named dashboards per project. Stop short of a free-form query builder. |
| **SDK OTel exporter** | M | First-party SDKs speak the native batch protocol; add an OTel exporter/processor helper (span → GenAI semconv → existing OTLP endpoint) so OTel-standardized teams keep first-party DX. Track GenAI + MCP semconv releases (still Development status). |

## Horizon 2 — differentiators (launch wave)

| Feature | Effort | Notes |
| --- | --- | --- |
| **MCP trace-query + eval tools** | M | Add `query_traces` / `get_trace` / `get_metrics` / `list_scores` read tools and a `run_evaluator` write tool to the shared registry — agents debug and evaluate themselves from the IDE. Per-tool RBAC gate already supports the read/write split. |
| **MCP semconv ingestion** | M | Map `mcp.method.name` / `mcp.session.id` (OTel v1.39+) at ingest; surface MCP tool calls as first-class in the trace view. |
| **Tool-call analytics** | M | Error rate + latency by tool name across traces — the top agent-debugging question. |
| **Ingest health console** | M | Productize the CLI-only DLQ: console page with DLQ depth, insert latency, error counters (all already in worker `/metrics`), one-click batch replay, blob replay for a time range. Converts the ingest-trust architecture into a demo. |
| **Volume-based usage metering** | M | Meter cloud billing by GB ingested, not per-observation — agent workloads emit 40–75 spans per interaction and unit pricing punishes them. Blob-first ingest makes byte-accurate metering cheap. |
| **Agent-graph v2** | S | Collapse/expand subgraphs, highlight failed paths. |

## Horizon 3 — enterprise & monetization (post-launch)

The paid tier mirrors the line the market accepts (Langfuse's post-MIT gating):
compliance, not product features.

| Feature | Effort | Notes |
| --- | --- | --- |
| **SCIM provisioning** | L | The enterprise half of the existing SSO story (directory sync, deprovisioning). |
| **Project-level RBAC** | L | Roles are org-level today; per-project role assignment. |
| **Extended audit retention + export** | M | Audit logs exist; retention tiers and export are the paid part. |
| **License-key gating (`/ee`)** | M | Same codebase/schema across OSS, enterprise self-host, and cloud; a key unlocks the compliance modules — preserving the friction-free tier switch. |
| **Runtime guardrails** | L | PII blocking (runtime sibling of the existing ingest masking patterns), prompt-injection detection, content-policy checks as an SDK-callable endpoint. |
| **Data residency** | L | Region pinning for cloud (EU first). Multi-region HA deferred. |

## Improvements to existing features

| Feature | Effort | Notes |
| --- | --- | --- |
| **Prompt A/B experiments** | L | Traffic-split two versions on a channel, auto-compare scores/cost; one-click rollback. Channels infra already supports it. |
| **Evaluator template library** | M | Prebuilt judges (hallucination, relevance, toxicity, …) + evaluator versioning so score drift is attributable. |
| **Trace → dataset / fine-tuning** | M | One-click trace→dataset-item; export datasets as fine-tuning JSONL (OpenAI/Anthropic formats). |
| **Inter-rater agreement** | M | Agreement metrics on review queues; keyboard-driven review UI. |
| **Session/user cost rollups** | S | "Cost per user" breakdowns — columns already in Doris. |
| **Playground model comparison** | M | Side-by-side multi-model runs (reuse the experiment comparison-matrix UI). |
| **Parquet export** | S | Alongside JSONL/CSV for BI/notebook use. |
| **Webhook retries** | S | Retry with backoff + delivery-log UI on top of existing delivery tracking. |
| **More SDK integrations** | M | LlamaIndex + Vercel AI SDK (JS), Pydantic AI (Python) — framework breadth is a cited decision factor. |

## Suggested next slices

1. **Alert rules engine** + **cost budgets** — the two loudest gaps, one shared foundation.
2. **Provider breadth** — one gateway change, three features improved.
3. **MCP trace-query tools** + **ingest health console** — the launch-announcement differentiators.
4. **Compliance layer** (SCIM, project RBAC, extended audit, `/ee` gating) — scoped when cloud pricing lands.
