---
title: Data model
description: The entities memoturn stores — traces, observations, scores, prompts, datasets, evaluators — and how they relate.
---

## Entities & relationships

```
Organization (Workspace)
├── Membership ── User          (role: OWNER / ADMIN / MEMBER / VIEWER)
└── Project
    ├── ApiKey
    ├── Prompt
    │   ├── PromptVersion       (immutable versions)
    │   └── PromptChannel       (movable deployment pointers)
    ├── Dataset
    │   ├── DatasetItem
    │   └── DatasetRun ── DatasetRunItem   (links an item to its trace)
    ├── Evaluator
    └── ReviewQueue ── ReviewItem

Trace                            (telemetry, in Apache Doris)
├── Observation                  (steps; nest via parentObservationId)
└── Score
```

Relational metadata (workspaces, projects, prompts, datasets, …) lives in **Postgres**;
high-volume **Trace / Observation / Score** telemetry lives in **Apache Doris** and is
linked by `trace_id` / `project_id`.

## Tenancy

- **Organization** → **Project** (the data model still names it `Workspace` in places).
  All telemetry and config is scoped to a project; tenancy is the Better Auth organization
  plugin (`organization`/`member`/`invitation`).
- **Membership** binds a user to an organization with a **role**: `OWNER`, `ADMIN`,
  `MEMBER`, `VIEWER`. Viewers are read-only.
- **API keys** are per-project (`pk-mt-…` public, `sk-mt-…` secret); mint and revoke them
  from the console or `POST`/`DELETE /v1/api-keys`.
- **SSO** — customers can sign in with their own OIDC/SAML IdP (Better Auth SSO plugin),
  mapped to an organization by email domain.

## Observability

- **Trace** — one logical request/run. Has a name, optional `userId`, `sessionId`,
  `release`, `version`, `environment`, tags, metadata, input, output.
- **Observation** — a step inside a trace. Three kinds:
  - **span** — generic unit of work
  - **generation** — an LLM call (model, provider, token usage, cost, latency)
  - **event** — a point-in-time marker

  Observations nest via `parentObservationId`, rendered as a **waterfall timeline** in the
  console's trace detail view:

  ![Trace detail — waterfall timeline with scores and payloads](../../assets/screenshots/trace-detail.png)
- **Score** — a numeric/categorical/boolean measurement attached to a trace (or
  observation). `source` is one of:
  - `API` — sent via SDK/API (e.g. user feedback)
  - `EVAL` — produced by an evaluator (LLM-as-judge)
  - `ANNOTATION` — produced by a human review
- **Session** — traces sharing a `sessionId` (a conversation/thread). Sessions roll up
  trace counts and cost.
- **Environment** — free-form label (e.g. `production`, `staging`, `playground`) for
  separating and filtering telemetry.

Cost is computed by the worker from the model + token usage using the registry in
`packages/core` (extend `MODEL_PRICES` to add models).

## Metrics

Cost, tokens, counts, and latency percentiles (p50/p95/p99, via `PERCENTILE_APPROX`) are
aggregated on the fly from the `observations` table in Doris — per project, environment,
and model, grouped by day. The dashboard and `GET /v1/metrics` run these aggregations
directly; there is no precomputed rollup to drift out of date.

## Prompt management

- **Prompt** — named, optionally foldered. **Versions** are immutable; each save creates
  a new version.
- **Channel** — a movable deployment pointer (e.g. `production`, `latest`, or custom).
  `latest` always tracks the newest version. SDKs fetch by channel.

See [Prompts](/prompts/).

## Datasets & experiments

- **Dataset** — a set of **items** (`input`, optional `expectedOutput`, metadata).
- **Run** (experiment) — links each dataset item to the trace produced by running a task
  on it; scores on those traces are the experiment's results.

## Evaluators

LLM-as-judge **evaluators** (judge prompt + provider/model) score traces and write an
`EVAL` score. They run two ways:

- **Offline** — over a dataset/experiment.
- **Online** — the worker samples incoming production traces and scores them
  automatically (per-evaluator sampling rate + optional trace-name filter).

## Review queues

Human-in-the-loop annotation. A **review queue** holds traces to score manually;
submitting a review writes an `ANNOTATION` score and marks the item done.

See [Evaluation](/evaluation/) for all three modes.

## Score configs

A **score config** defines an allowed score name and shape (numeric range, categorical
options, or boolean) so manual and automated scores stay consistent across a project.

## Automations & webhooks

- **Webhook** — POSTs to a URL on an event (`score.created` supports a low-score threshold).
- **Automation** — a trigger→action rule: trigger (`score.created` / `trace.created` /
  `eval.completed`) → action (`webhook` or `slack`).
- **Event sink** — optionally forwards trace/score events to a product-analytics/CDP endpoint (PostHog-compatible capture API) for funnels/retention.

## PII masking

An optional per-project **masking policy** redacts trace input/output at ingest using
built-in and custom patterns, so sensitive data never lands in Doris or the blob log.

## Audit log & retention

- **Audit log** — records who did what (prompt/dataset/provider/evaluator/review/retention
  mutations) per project.
- **Retention policy** — optional per-project max age; a daily worker job deletes
  telemetry older than the policy (0 = keep forever).
