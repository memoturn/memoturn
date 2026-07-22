---
title: Roadmap
description: What memoturn has shipped and the prioritized backlog of candidate features.
---

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
(DLQ depth, insert latency, error counters, one-click replay) · **semantic trace search**
(find-similar via exact cosine k-NN in Doris) · **trace compare** (side-by-side content diff +
per-observation diff) · **prompt A/B experiments** (weighted sticky split + per-arm score
compare + promote) · **cost attribution by prompt version** · **head-based ingest sampling** ·
**metric anomaly detection** (rolling-baseline z-score alerts) · MCP server (stdio + remote
Streamable HTTP with OAuth + per-tool RBAC; **`query_traces` / `get_trace` / `get_metrics`
/ `list_scores` reads + `run_evaluator` write**; **`mcp.method.name` / `mcp.session.id`
semconv ingestion**) · provider gateway (Anthropic, OpenAI, **Gemini, Bedrock, Azure,
OpenAI-compatible** for vLLM/Ollama/OpenRouter) · TypeScript + Python + **Go** SDKs (tracing,
OpenAI, LangChain, prompts, OTel exporter, **LlamaIndex (Python)**).

## Horizon 2 — differentiators (launch wave)

| Feature | Effort | Notes |
| --- | --- | --- |
| **Volume-based usage metering** | M | Meter cloud billing by GB ingested, not per-observation — agent workloads emit 40–75 spans per interaction and unit pricing punishes them. Blob-first ingest makes byte-accurate metering cheap. Cloud-billing dependency. |
| **Agent-graph v2** | S | Collapse/expand subgraphs, highlight failed paths. |

## Horizon 3 — enterprise & monetization (post-launch)

The paid tier mirrors the line the market accepts: compliance, not product features.
**Monetization is deliberately deferred until there are paying customers** — these ship
ungated as OSS until the `/ee` gate is justified.

| Feature | Effort | Notes |
| --- | --- | --- |
| **SCIM provisioning** | L | The enterprise half of the existing SSO story (directory sync, deprovisioning). Composes with the org + admin plugins. |
| **Extended audit retention + export** | M | Auth-lifecycle audit logs exist; retention tiers and bulk export are the paid part. |
| **License-key gating (`/ee`)** | M | Same codebase/schema across OSS, enterprise self-host, and cloud; a key unlocks the compliance modules. **Not built until a customer needs a paid tier** — no premature paywall infra. |
| **Data residency** | L | Region pinning for cloud (EU first). Multi-region HA deferred. |
| **Tail sampling at ingest** | M | Head-based sampling shipped (per-project keep-rate, stable per trace, blob keeps everything for replay). Tail sampling — keep-on-error / keep-on-high-cost regardless of the head decision — is the remaining piece; it needs a per-trace buffering/decision window to stay orphan-free. |

## Improvements to existing features

| Feature | Effort | Notes |
| --- | --- | --- |
| **Trace → dataset / fine-tuning** | M | One-click trace→dataset-item; export datasets as fine-tuning JSONL (OpenAI/Anthropic formats). |
| **Inter-rater agreement** | M | Agreement metrics on review queues; keyboard-driven review UI. |
| **More SDK integrations** | M | LlamaIndex + Vercel AI SDK (JS), Pydantic AI (Python) — framework breadth is a cited decision factor. (TS/Python/Go core SDKs shipped.) |
| **Project-wide cost-by-prompt** | S | Per-*version* cost shipped; a project-wide "spend per prompt" ranking on the prompts list is the small remaining half. |

## Suggested next slices

1. **Trace → dataset / fine-tuning** + **project-wide cost-by-prompt** — small, high-value loop closers on infra that already exists.
2. **Tail sampling** + **volume-based metering** — the cloud cost-control pair, one ingest-path change (head sampling already shipped).
3. **More SDK integrations** (LlamaIndex, Vercel AI, Pydantic AI) + **agent-graph v2** — framework breadth and the last launch-wave polish.
4. **Compliance layer** (SCIM, extended audit, `/ee` gating) — scoped when cloud pricing lands and a customer needs it.
