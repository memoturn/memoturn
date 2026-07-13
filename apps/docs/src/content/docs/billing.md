---
title: Usage metering & billing
description: Meter LLM tokens, agent turns, compute-seconds, and storage; enforce per-tenant plan limits; and report usage to Stripe metered billing.
---

Memoturn separates **metering** (open-source core) from **billing** (Enterprise Edition). The core
emits structured usage to a swappable sink and asks a provider for per-tenant limits; the
`memoturn-enterprise` package persists that usage, rolls it up, reports it to Stripe, and enforces
each tenant's plan. A pure open-source build meters to a log and applies one global limit.

## What gets metered

Every signal is tenant-attributable. Four meters, emitted by the core:

| Meter | Unit | Emitted from |
| --- | --- | --- |
| `tokens` | LLM input + output + cache tokens per turn | the WebSocket turn loop, on `TurnCompleted` |
| `turn` | one agent turn | the WebSocket turn loop, on `TurnCompleted` |
| `compute_s` | sandbox/shell execution wall-clock seconds | the `exec_code` and `run_shell` tools |
| `storage_bytes` | per-agent on-disk bytes (a gauge) | the hibernation reaper, when an agent flushes |

The per-kind token split (input / output / cache read / cache write — each priced differently)
rides in the event metadata; cache reads/writes typically bill at a lower rate than fresh tokens.

## The usage sink (open-source)

The core emits `UsageEvent`s through a `UsageSink` (`memoturn.usage`). The default sink writes JSON
lines to the `memoturn.usage` logger — useful for self-hosters and local debugging. Token and turn
usage flows through `app.state.usage_sink`; compute and storage emit through the process-global
sink (`memoturn.usage.set_usage_sink`), so deep call sites need no wiring.

## Plans & limits

Per-tenant limits are resolved through a `TenantLimitsProvider`. The open-source core uses one
global limit for every tenant (`MEMOTURN_RATE_LIMIT_PER_MINUTE`, `MEMOTURN_QUOTA_TURNS_PER_DAY`,
`MEMOTURN_QUOTA_TOKENS_PER_DAY`). The Enterprise plan catalog overrides this per tenant:

| Plan | requests/min | turns/day | tokens/day |
| --- | --- | --- | --- |
| `free` | 20 | 200 | 1,000,000 |
| `pro` | 120 | 10,000 | 100,000,000 |
| `enterprise` | unlimited | unlimited | unlimited |
| `suspended` | throttled to zero | — | — |

A tenant whose Stripe subscription is cancelled or past-due is automatically moved to `suspended`
by the webhook handler.

## Enabling billing (Enterprise Edition)

Install `memoturn-enterprise` and set:

```bash
MEMOTURN_BILLING_ENABLED=true
# Store: empty = SQLite under DATA_DIR; or a postgresql+asyncpg DSN for multi-replica aggregation
MEMOTURN_BILLING_DSN=
MEMOTURN_BILLING_DEFAULT_PLAN=free
# Stripe: empty key = persist + roll up locally without reporting (dev/CI)
STRIPE_API_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
```

With billing enabled the runtime:

1. buffers usage in memory (sync emit on the hot path),
2. drains it to the store and folds it into **idempotent hourly rollups** (tokens accumulate;
   storage is a last-value gauge),
3. reports unreported rollups to **Stripe Billing Meter Events** (one meter per dimension,
   idempotent per `tenant:kind:hour`),
4. enforces each tenant's plan through the rate limiter.

Create the matching Billing Meters + metered Prices once per Stripe account with the bundled
script:

```bash
STRIPE_API_KEY=sk_live_... uv run python -m memoturn_enterprise.billing.stripe_setup
```

It creates a meter per dimension (`memoturn_tokens`, `memoturn_turns`, `memoturn_compute_seconds`,
`memoturn_storage_bytes`) and a metered monthly price each, then prints a ready-to-paste
`MEMOTURN_BILLING_PLAN_PRICES` suggestion.

To attach subscriptions automatically, map each plan to a Stripe metered Price via
`MEMOTURN_BILLING_PLAN_PRICES` (e.g. `{"pro":"price_123"}`). When a tenant is provisioned on a
plan that has a price, the runtime creates the Stripe customer **and** a subscription to that
price.

## Self-serve signup (zero operator touch)

A brand-new customer signs themselves up end-to-end:

1. `POST /v1/billing/signup` (opt-in via `MEMOTURN_BILLING_SELF_SIGNUP_ENABLED`) returns a Stripe
   Checkout URL; the new tenant name is validated and must not already exist.
2. The customer pays. The `checkout.session.completed` webhook provisions the tenant **and mints a
   one-time bootstrap admin API key**.
3. The Checkout success page calls `POST /v1/billing/checkout/complete` with the `session_id` from
   the success URL and receives that key **once** — the tenant's first credential. From there it
   issues its own [API keys](/api-keys/) and manages billing via the Customer Portal.

The public `signup` and `checkout/complete` endpoints are rate-limited per client IP
(`MEMOTURN_BILLING_PUBLIC_RATE_LIMIT_PER_MINUTE`, default 10) to blunt abuse and bootstrap-key
enumeration, and the bootstrap key is single-use and TTL-pruned. Before releasing the key,
`checkout/complete` re-verifies with Stripe that the session is paid.

Webhook events are signature-verified, then persisted to a durable inbox keyed on the Stripe event
id (so redeliveries dedupe) and processed by a background loop. A processing failure is retried
with exponential backoff up to `MEMOTURN_BILLING_WEBHOOK_MAX_ATTEMPTS` (default 8) before the event
is dead-lettered — visible in `GET /v1/admin/billing/health` and replayable via the admin API.

Under scale-out, set `MEMOTURN_REDIS_URL` (Valkey or any Redis-protocol store) so the per-IP limit
holds across replicas (otherwise it is per-replica, and the runtime logs a warning when self-serve
signup is enabled without it).

## Endpoints

Mounted only when billing is enabled. Tenant provisioning and the global tenant list are
cross-tenant platform-operator actions and require **superadmin**; usage readout requires `admin`
and is scoped to the caller's own tenant (a superadmin may read any tenant's usage).

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `POST` | `/v1/admin/tenants` | superadmin | Provision a tenant (creates a Stripe customer/subscription when configured) |
| `GET` | `/v1/admin/tenants` | superadmin | List tenants and their plan/status |
| `GET` | `/v1/admin/usage?tenant=<t>` | admin (own tenant) | Hourly usage rollups |
| `POST` | `/v1/billing/checkout` | admin (own tenant) | Start a self-serve Checkout for a paid plan; returns the redirect `url` |
| `POST` | `/v1/billing/portal` | admin (own tenant) | Open the Stripe Customer Portal; returns the `url` |
| `POST` | `/v1/billing/signup` | public (opt-in) | Self-serve signup for a **new** tenant; returns a Checkout `url`. Enabled by `MEMOTURN_BILLING_SELF_SIGNUP_ENABLED` |
| `POST` | `/v1/billing/checkout/complete` | public (session id) | Exchange a completed signup session for its one-time bootstrap admin `key` |
| `GET` | `/v1/admin/billing/health` | superadmin | Ops snapshot: buffered queue depth, dropped events, webhook inbox, Stripe/store status |
| `GET` | `/v1/admin/billing/webhooks/dead` | superadmin | List dead-lettered Stripe events (retries exhausted) |
| `POST` | `/v1/admin/billing/webhooks/{event_id}/replay` | superadmin | Requeue a dead-lettered event and process it now |
| `POST` | `/v1/billing/stripe/webhook` | Stripe signature | `checkout.session.completed` provisions the tenant; `customer.subscription.*` suspends/resumes |

**Self-serve flow:** a tenant admin calls `POST /v1/billing/checkout` (the console's "Upgrade"
button), is redirected to Stripe Checkout, pays, and the `checkout.session.completed` webhook
provisions/updates the tenant from the session metadata. "Manage billing" opens the Customer Portal.

## Retention & ops

Raw usage events are pruned after `MEMOTURN_BILLING_RETENTION_DAYS` (default 30; `0` keeps them)
once they've been folded into rollups — the rollups, which are the billing record, are kept. The
usage sink is a bounded in-memory buffer that drops (and counts) events under sustained overload
rather than blocking turns; alarm on the `dropped`/`queue_depth` fields from
`GET /v1/admin/billing/health`.

## Without Stripe

Billing degrades gracefully: with no `STRIPE_API_KEY`, usage is still persisted and rolled up and
plan limits are still enforced — nothing is pushed to Stripe. This is the dev/CI path and needs no
Stripe account or external database (SQLite default).
