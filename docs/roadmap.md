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
OpenAI, LangChain, prompts, OTel exporter, **LlamaIndex (Python)**).

## Up next — triage workflow

The daily loop is "something looks wrong → find the traces → decide if it's real". These are
the gaps in that loop, ordered by how often they block it.

| Feature | Effort | Notes |
| --- | --- | --- |
| **Filter traces by score value** | M | "Show me traces my judge scored below 0.5" is the most common triage question and the console can't answer it — `TRACE_FILTER_COLUMNS` has no score column and the filter compiler has no score join. Needs a `scores.<name>` pseudo-column that resolves level-agnostically (a score attached to the trace *or* to one of its observations), in both engine dialects, plus the facet/autocomplete plumbing to offer observed score names. |
| **Span-level explorer** | M | Today you can only reach an observation through its trace. There's no way to ask "every `retriever` span over 2s this week" or "every generation on model X that errored". The `observations` analytics view already exists in the store, so this is mostly a console table + filter registry over rows we already index. |
| **Evaluator targeting & mapping** | L | One tranche, because the pieces are useless apart: (a) **variable mapping** — bind each judge-prompt variable to a chosen source (trace field, a *named* observation's input/output, dataset item field, metadata path) instead of the hard-coded `{input, output, expectedOutput}`; (b) **observation scope** — score individual spans, not just whole traces or threads; (c) **backfill** — run a new evaluator over *existing* matching traces, with a live "this matches N items" count, instead of only over new ingest. Today `filterName` (a substring on trace name) is the entire targeting model. |
| **Score analytics** | L | A dedicated surface per score: distribution (numeric histogram / categorical / boolean), timeline, and summary statistics — plus a **two-score comparison** mode with a confusion-matrix heatmap and real agreement statistics (correlation, MAE/RMSE, Cohen's Kappa, F1, agreement rate). The valuable framing is comparing any two score *sources*: human vs judge, judge vs judge, v1 vs v2 of a judge. That's how a team proves a judge is trustworthy, and it subsumes the older "inter-rater agreement on review queues" idea. Estimate result size and sample above a threshold — this query shape scans a lot of rows. |
| **Real full-text search** | M–L | Trace/observation search compiles to `LIKE '%…%'` — a table scan that also misses payloads offloaded to blob (> 256 KB). Needs a Doris inverted index (`MATCH_ANY` / `MATCH_PHRASE`) plus `tsvector`/GIN on the Postgres tier, both behind the existing store method, and a searchable digest indexed at offload time so large bodies stop being a silent hole. Validate the inverted-index-vs-merge-on-write interaction before committing to the design. |

## Adoption blockers

Things that decide whether a team with existing tooling can adopt Memoturn without rewriting it.

| Feature | Effort | Notes |
| --- | --- | --- |
| **Remote dataset runs** | M | Register a webhook per dataset so "Run experiment" in the console POSTs to *the customer's* service, which executes the run in their own infra and reports results back through the API. Today experiments only run in-platform through our provider gateway, which locks out every team whose eval harness already exists. Pairs with a `POST /v1/dataset-run-items` endpoint so external runs can attach arbitrary traces to a run. |
| **Chat message placeholders + prompt composability** | M | Two registry gaps that block managing real agent prompts: a **placeholder** message slot filled at runtime with a *list* of messages (chat history, few-shot examples), and **composability** — embedding one prompt inside another by name+label, resolved server-side with a dependency graph and cycle detection. Without these, chat and agent prompts get templated by hand outside the registry. |
| **Dataset CSV import + item schema** | M | Upload a CSV with column→field mapping, and let a dataset declare a JSON schema its items are validated against (with per-field errors on bulk insert). Turns a dataset from a bag of JSON into a contract. Media attachments on dataset items are the third piece. |
| **Prompt-change automations** | M | Automation triggers are telemetry-only (`score.created` / `trace.created` / `eval.completed`). Add a **prompt** trigger source (created / updated / label moved) and a **GitHub `repository_dispatch`** action, so promoting a prompt label can kick a CI workflow. That's the prompt CI/CD loop, and it composes with the existing dataset gate action. |
| **Public API breadth** | M | Four concrete holes: a top-level `GET /v1/observations` (observations are only reachable nested inside a trace); org-scoped **provisioning** endpoints (create project, rotate project API keys, manage org/project memberships) so self-hosters can automate tenant setup; **LLM-connection** CRUD so provider credentials can be managed programmatically; and an explicit `DELETE /v1/traces/{id}` for right-to-erasure — the store method exists, only the console bulk path is wired. |
| **SDK version on the ingest contract** | S | We don't record which SDK version emitted an event, so we can't warn "this feature needs a newer SDK", can't scope a bug report to a version, and can't measure upgrade rollout. Cheap to add to the wire contract now; expensive later because it needs a backfill. |

## Improvements to existing features

| Feature | Effort | Notes |
| --- | --- | --- |
| **Structured evaluator output** | S–M | Judges parse a fixed `{score: 0..1, reasoning}`. Let an evaluator declare the score name and data type it emits (numeric / categorical / boolean) so a judge can return a label, not just a number. The `Evaluator.outputSchema` column already exists and is currently unread — wire it or drop it. |
| **Project-level default judge model** | S | Every evaluator re-specifies provider + model. A project default (overridable per evaluator) removes the most common setup step and makes template instantiation one click. |
| **Protected prompt labels** | S | Mark a label (`production`) as protected so moving it requires a higher role. Small, and immediately relevant to anyone serving prompts from the registry in production. |
| **Platform-failure notifications** | S | Alert rules cover telemetry conditions; platform failures (a scheduled export that failed, an evaluator blocked on a bad provider key) are only visible if you go looking. Route them to a per-project channel using the existing automation dispatcher. |
| **Webhook auto-disable + failure banner** | S | Deliveries retry and are logged, but a permanently-broken endpoint retries forever and silently. Disable after a failure streak and surface it in the console. |
| **Histogram + pivot-table widgets** | M | The chart set is `line / bar / horizontal_bar / big_number / pie / table`. A latency/cost **histogram** and a **pivot table** (group rows × columns with subtotals) are the two shapes people rebuild by hand today. |
| **Portable dashboard JSON** | M | Export a dashboard (with its widgets inlined) as a versioned JSON envelope, import it into another project or instance. Makes dashboards shareable artifacts and turns "starter dashboards" into content rather than code. |
| **Nested folders for prompts and datasets** | S–M | `Prompt.folder` is a flat string and datasets have none. Path-based folders with breadcrumbs, plus rename/duplicate/delete at the folder level. |
| **Query-language search bar** | L | A keyboard-driven query bar (`level:(ERROR OR WARNING) -env:dev latency:>2 scores.accuracy:<0.5`) as a second controlled editor over the same filter state the facet sidebar owns — never a second source of truth. Worth doing only after score filters land, since score predicates are most of the value. A natural-language→filter compiler on top of the provider gateway is a small follow-on, and we'd ship it ungated on self-host. |
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
