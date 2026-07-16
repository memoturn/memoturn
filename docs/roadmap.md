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
dashboards · custom widgets (v2: score/error-rate metrics, cost-by-user/session
breakdowns, per-widget filters, multiple named dashboards) · prompt registry + channels ·
playground (multi-provider, streaming, trace-linked, tools + structured output,
**multi-model side-by-side comparison**) · datasets & experiments + comparison matrix ·
**dataset CI quality gates** (gate API + GitHub Action + Python SDK) · evaluators (offline
+ online, **template library + version history**) · human review queues + assignments ·
score configs · scores on traces · comments · tags + facets · webhooks + automations
(Slack, **retries + delivery log**) · **alert rules engine** (error-rate / latency-p95 /
cost / ingest-volume / DLQ-depth triggers, firing→resolved lifecycle, email + PagerDuty) ·
**cost budgets** (per-project thresholds + over-budget flag) · auth (sessions + API keys,
social, passwordless, 2FA, passkeys) · organizations + SSO (OIDC + SAML, IdP→org/role
mapping) + RBAC (org **and project-level**) + project switcher · admin plugin ·
auth-lifecycle audit log · data retention · rate limiting · NDJSON/CSV/**Parquet** export
+ scheduled blob exports · saved views · batch actions · multimodal media · custom model
prices · **runtime guardrails** (PII / prompt-injection / content-policy endpoint) ·
event sink / CDP forwarding · ⌘K palette · global time range · agent-graph view ·
**tool-call analytics** (calls / error rate / latency by tool) · **ingest health console**
(DLQ depth, insert latency, error counters, one-click replay) · MCP server (stdio + remote
Streamable HTTP with OAuth + per-tool RBAC; **`query_traces` / `get_trace` / `get_metrics`
/ `list_scores` reads + `run_evaluator` write**; **`mcp.method.name` / `mcp.session.id`
semconv ingestion**) · provider gateway (Anthropic, OpenAI, **Gemini, Bedrock, Azure,
OpenAI-compatible** for vLLM/Ollama/OpenRouter) · TypeScript + Python SDKs (tracing,
OpenAI, LangChain, prompts, **OTel exporter**).

## Horizon 2 — differentiators (launch wave)

| Feature | Effort | Notes |
| --- | --- | --- |
| **Volume-based usage metering** | M | Meter cloud billing by GB ingested, not per-observation — agent workloads emit 40–75 spans per interaction and unit pricing punishes them. Blob-first ingest makes byte-accurate metering cheap. Cloud-billing dependency. |
| **Agent-graph v2** | S | Collapse/expand subgraphs, highlight failed paths. |
| **Semantic trace search** | M | Reuse the RAG embedding infra to search traces by meaning (nearest-neighbour over input/output embeddings), not just facet filters — "find traces like this one." Doris ANN-vs-MoW constraint applies; project onto the existing projection job. |
| **Trace diff** | M | Side-by-side diff of two traces (or two experiment runs): io, scores, cost, latency, span tree. Natural extension of the experiment comparison matrix; the top "why did this regress" question. |

## Horizon 3 — enterprise & monetization (post-launch)

The paid tier mirrors the line the market accepts (Langfuse's post-MIT gating):
compliance, not product features. **Monetization is deliberately deferred until there
are paying customers** — these ship ungated as OSS until the `/ee` gate is justified.

| Feature | Effort | Notes |
| --- | --- | --- |
| **SCIM provisioning** | L | The enterprise half of the existing SSO story (directory sync, deprovisioning). Composes with the org + admin plugins. |
| **Extended audit retention + export** | M | Auth-lifecycle audit logs exist; retention tiers and bulk export are the paid part. |
| **License-key gating (`/ee`)** | M | Same codebase/schema across OSS, enterprise self-host, and cloud; a key unlocks the compliance modules. **Not built until a customer needs a paid tier** — no premature paywall infra. |
| **Data residency** | L | Region pinning for cloud (EU first). Multi-region HA deferred. |
| **Head/tail sampling at ingest** | M | Configurable sampling (head-based rate + tail-based keep-on-error/keep-on-high-cost) so high-volume agent workloads control retained volume without losing the interesting traces. Complements blob-first metering as the enterprise cost lever. |
| **Metric anomaly detection** | M | Statistical baselines (rolling mean/stddev, seasonality) on error-rate/latency/cost so alerts fire on deviations, not just static thresholds. Extends the alert engine. |

## Improvements to existing features

| Feature | Effort | Notes |
| --- | --- | --- |
| **Prompt A/B experiments** | L | Traffic-split two versions on a channel, auto-compare scores/cost; one-click rollback. Channels infra already supports it. |
| **Trace → dataset / fine-tuning** | M | One-click trace→dataset-item; export datasets as fine-tuning JSONL (OpenAI/Anthropic formats). |
| **Inter-rater agreement** | M | Agreement metrics on review queues; keyboard-driven review UI. |
| **More SDK integrations** | M | LlamaIndex + Vercel AI SDK (JS), Pydantic AI (Python), and a **Go SDK** — framework/language breadth is a cited decision factor. |
| **Cost attribution by prompt/version** | S | Roll up spend per prompt and per prompt version — closes the loop between the prompt registry and cost rollups. |

## Suggested next slices

1. **Semantic trace search** + **trace diff** — the two launch-wave differentiators that build on infra already in the repo (RAG embeddings, experiment matrix).
2. **Prompt A/B experiments** + **cost attribution by prompt/version** — turn the prompt registry into a closed optimization loop.
3. **Head/tail sampling** + **volume-based metering** — the cloud cost-control pair, one ingest-path change.
4. **Compliance layer** (SCIM, extended audit, `/ee` gating) — scoped when cloud pricing lands and a customer needs it.
