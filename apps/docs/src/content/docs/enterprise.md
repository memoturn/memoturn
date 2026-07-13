---
title: Open-core & Enterprise Edition
description: How Memoturn splits the Apache-2.0 core from the commercial Enterprise Edition, and the runtime plugin seam that wires them together.
---

Memoturn is open-core. The runtime (`memoturn`, **Apache-2.0**) is fully functional on its own.
Commercial capabilities ship in a separate distribution (`memoturn-enterprise`) under the
**Enterprise Edition License**, discovered by the core at runtime — never imported by it.

## What's in each edition

| Capability | Edition |
| --- | --- |
| Agent runtime, sandbox, memory, durable fibers, scale-out | Core (Apache-2.0) |
| Auth modes `none` / `api_key` / `jwt`, basic 4-role RBAC | Core |
| Usage **metering** (the four meters) + audit/usage **sink seams** | Core |
| Per-tenant rate limits & quotas (one global limit) | Core |
| OpenTelemetry traces/metrics/logs + Prometheus `/metrics` | Core |
| **OIDC SSO** + console login | Enterprise |
| **SCIM 2.0** provisioning + identity store | Enterprise |
| **Persistent audit trail** + read API (`GET /v1/admin/audit`) | Enterprise |
| Fine-grained / custom RBAC roles | Enterprise |
| **Runtime API keys** (`/v1/admin/api-keys`, hashed, anti-escalation) | Enterprise |
| **Usage-metered Stripe billing** + per-tenant plan limits | Enterprise |
| **OAuth token vault** (on-behalf-of credentials, auto-refresh) | Enterprise |

## The plugin seam

The core exposes a small registry (`memoturn.plugins`). At startup it calls `load_enterprise()`,
which imports `memoturn_enterprise` **only if installed** and lets it register capabilities:

- **Authenticators by mode** — Enterprise contributes `oidc`; requesting it without the package
  fails closed with a clear error.
- **Routers** — SCIM, OIDC console-login, [API-key](/api-keys/), [audit](/security/#audit-logging),
  and [billing](/billing/) routers are mounted if registered.
- **Identity store** — provisioned users/groups/SCIM-tokens/OIDC-providers; `None` in the core.
- **Identity resolver** — maps an SSO principal onto a provisioned user; passthrough in the core.
- **Audit & usage sinks** — the core ships logging defaults (plus optional OTel SIEM export);
  Enterprise registers the persistent audit store and the Stripe-backed usage sink.
- **Tenant limits** — the Enterprise plan catalog; the core uses one global limit.
- **Custom RBAC roles** — Enterprise adds roles like `owner`, `auditor`, `billing_admin` on top
  of the core's four.
- **Token broker** — the [OAuth token vault](#oauth-token-vault); the core treats a missing
  broker as "no connection".
- **Startup hooks** — background tasks such as the OIDC provider refresh and the billing reporter.

A build without `memoturn-enterprise` registers none of these and runs as a pure open-source
control plane. See [billing](/billing/) for the metered-billing layer and [SSO](/sso/) /
[SCIM](/scim/) for the provisioning surfaces.

## OAuth token vault

With `MEMOTURN_OAUTH_VAULT_ENABLED`, users connect a provider once and agents act with live
user-authorized credentials they never hold:

- **Storage** — per-`(tenant, subject, provider)` access/refresh tokens, Fernet-encrypted at
  rest (`MEMOTURN_OAUTH_TOKEN_ENCRYPTION_KEY`; startup refuses an enabled vault without a key).
  `subject=""` is a tenant-wide connection; subject lookups fall back to it.
- **Refresh** — tokens expiring within `MEMOTURN_OAUTH_REFRESH_BUFFER_SECONDS` are exchanged at
  the provider's token endpoint (`MEMOTURN_OAUTH_PROVIDERS`), with refresh-token rotation
  handled.
- **API** — `POST /v1/oauth/tokens` (members connect for themselves; tenant-wide or other
  subjects require admin), `GET` (admin; metadata only — token values are write-only),
  `DELETE /v1/oauth/tokens/{provider}`. All audited.
- **Consumption** — core code fetches tokens through the plugin token broker; the flagship
  consumer is [sandbox egress](/sandboxing/#http-egress-with-credential-injection): an egress
  credential naming an `oauth_provider` injects a live `Bearer` token host-side, so sandboxed
  code calls user-authorized APIs with zero credential exposure.

Storage is dual-engine like the identity store: the control-plane SQLite by default, or shared
Postgres when `MEMOTURN_POSTGRES_DSN` is set — use Postgres under [scale-out](/scaling/) so every
replica sees the same connections (the runtime warns at startup otherwise).
