---
title: Security
description: Authentication modes, RBAC, hard multi-tenancy, rate limits and quotas, secrets, and encryption at rest.
---

Every `/v1` operation is authenticated, authorized via RBAC, scoped to the caller's tenant
(hard isolation), audited, and — when configured — rate-limited and quota-checked.

## Authentication

Set with [`MEMOTURN_AUTH_MODE`](/configuration/#authentication--authorization):

| Mode | Behavior |
| --- | --- |
| `none` (default) | Dev only — every caller is an admin of the default tenant. No credentials. The server warns loudly when bound beyond loopback; `MEMOTURN_REQUIRE_AUTH=true` refuses to start. |
| `api_key` | Static API keys mapped to principals via `MEMOTURN_AUTH_API_KEYS` (JSON: `key`, `tenant`, `subject`, `roles`). |
| `jwt` | HS256 bearer tokens from your SSO/identity gateway, verified against `MEMOTURN_AUTH_JWT_SECRET`. |
| `oidc` | IdP-issued RS256/ES256 tokens verified against the issuer's JWKS — see [SSO](/sso/). Needs the `oidc` extra. |

An unrecognized mode **fails closed** at startup — a typo can never silently disable
authentication. Several modes can run side by side with `MEMOTURN_AUTH_MODES`
(e.g. `["api_key", "oidc"]`: service keys + human SSO); each is tried in order.

Credentials are presented as `Authorization: Bearer <token>` or an `x-api-key` header. The
[WebSocket](/api-websocket/) additionally accepts the `memoturn.bearer.<token>` subprotocol or a
first-message auth frame; the legacy `?token=` query parameter still works but is **deprecated**
(URLs leak into access logs) and can be disabled with `MEMOTURN_AUTH_WS_ALLOW_QUERY_TOKEN=false`.

### JWT claims & key rotation

Claim names are configurable: `MEMOTURN_AUTH_JWT_TENANT_CLAIM` (default `tenant`),
`…_SUBJECT_CLAIM` (`sub`), `…_ROLES_CLAIM` (`roles`). Tokens are validated for signature, `exp`,
`nbf`, and optional `iss` / `aud` (`MEMOTURN_AUTH_JWT_ISSUER`, `…_AUDIENCE`) with 30s leeway.
HS256 verification is implemented in the standard library — no PyJWT dependency.

Rotate without downtime via `MEMOTURN_AUTH_JWT_SECRETS` — a `kid`→secret map of additional
active secrets. Add the new secret, roll issuance to it, then remove the old one.

## Roles & permissions (RBAC)

| Role | Capabilities |
| --- | --- |
| `viewer` | Read-only — sessions, fibers, memories. |
| `member` | Read + `chat` + manage sessions/fibers/memories. |
| `admin` | All permissions within its tenant. |
| `superadmin` | Cross-tenant admin — may target any tenant via `?tenant=`. |

Permissions enforced per endpoint: `CHAT`, `READ_SESSIONS`, `MANAGE_SESSIONS`, `READ_FIBERS`,
`MANAGE_FIBERS`, `READ_MEMORIES`, `MANAGE_MEMORIES`, `ADMIN`. A denied permission returns `403`.
The [REST API](/api-rest/) lists the permission each route requires.

## Hard multi-tenancy

The effective tenant is derived from the authenticated principal, **never** from client input. A
caller may pass `?tenant=` only to confirm its own tenant; only a `superadmin` may target a
different one. Any mismatch returns `403`. Agents, sessions, fibers, memories, rate limits, and
quotas are all isolated per tenant.

## Rate limits & quotas

Per-tenant, disabled by default:

- `MEMOTURN_RATE_LIMIT_PER_MINUTE` — sliding-window requests per minute (`0` = off).
- `MEMOTURN_QUOTA_TURNS_PER_DAY` — daily turn quota (`0` = off).

In-process by default; set `MEMOTURN_REDIS_URL` (the `redis` extra) to enforce limits across all
replicas from one shared store — **required** under [scale-out](/scaling/), otherwise each replica
keeps its own counters. The recommended store is **Valkey** (BSD-3, Redis-protocol-compatible — the
`redis-py` client and `redis://` URLs are unchanged). Exceeding a limit yields an `error` event
with code `rate_limited`.

State-changing REST routes (forks, fibers, memory writes) carry an additional **per-principal**
limit — `MEMOTURN_REST_RATE_LIMIT_PER_MINUTE` (falls back to the per-tenant value; both `0` =
off). Exceeding it returns `429` with `Retry-After`.

## Secrets

Secrets resolve through a chain — file-mounted secrets (`/run/secrets/<name>`, i.e. Docker/K8s
secrets) take precedence over environment variables. This covers `MEMOTURN_AUTH_JWT_SECRET`,
`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, etc. Prefer mounted secrets over env vars in production.

## Audit logging

Every state-changing and read operation emits a structured audit event (actor, tenant, action,
resource, outcome, plus request context: `request_id`, `source_ip`, `user_agent`, `ts`) as JSON
lines to the `memoturn.audit` logger — route it to your SIEM, or enable
[OpenTelemetry](/observability/) to ship each event to your OTLP collector as a structured log
record. Logged actions include `ws_connect`, `fork_session`, `start_fiber`, all memory/profile
operations, and — with the Enterprise Edition — `api_key_create`/`api_key_revoke`,
`tenant_provision`, `tenant_status_change`, the billing flows (`billing_signup`,
`billing_checkout`, `billing_portal`), `auth_failure`, and `oidc_provider_add`/`remove`.

Every HTTP response carries an `X-Request-ID` header (an incoming one from a trusted proxy is
honored), correlating responses with their audit events. `source_ip` honors the first
`x-forwarded-for` hop and is only trustworthy behind a trusted proxy.

### Persistent audit trail (Enterprise)

With `MEMOTURN_AUDIT_PERSIST_ENABLED=true`, audit events are additionally buffered off the hot
path and persisted to a queryable store — SQLite under the data dir by default, or Postgres via
`MEMOTURN_AUDIT_DSN` (falls back to `MEMOTURN_POSTGRES_DSN`). Retention is governed by
`MEMOTURN_AUDIT_RETENTION_DAYS` (default 90; `0` keeps forever).

Read it back via `GET /v1/admin/audit` (filters: `actor`, `action`, `from_ts`, `to_ts`;
paginated with `limit`/`offset`). Access requires the `read_audit` permission — granted to
`admin`/`superadmin` in core and to the enterprise `auditor`, `owner`, and `billing_admin` roles.
Superadmin may read any tenant via `?tenant=`; everyone else is hard-scoped to their own.
`GET /v1/admin/audit/health` (superadmin) reports queue depth and dropped-event counts — alarm on
`dropped`.

## Encryption at rest

Set `MEMOTURN_BLOB_ENCRYPTION_KEY` to transparently encrypt [workspace](/workspace/) blob contents
at rest (the `crypto` extra). Agent SQLite databases rely on the encryption of the underlying
volume / snapshot store.

## Transport security

Defense-in-depth response headers (`X-Content-Type-Options`, `X-Frame-Options`,
`Referrer-Policy`, a frame-blocking CSP) are on by default. Once TLS terminates in front of the
runtime, opt into `MEMOTURN_HSTS_ENABLED=true` and `MEMOTURN_TLS_REQUIRED=true` (rejects plain
HTTP, honoring `X-Forwarded-Proto`; `/health` stays exempt for probes).

## Sanitized errors

Unexpected exceptions return an opaque `500` with a request id; full details — which can carry
secrets, paths, or provider internals — go only to the server log. WebSocket turn failures
likewise send a generic `internal` error event.

## SCIM provisioning

The [SCIM surface](/scim/) authenticates with per-tenant bearer tokens and **bypasses RBAC by
design** (the IdP is the provisioning authority). It is hard-scoped to the token's tenant and
fully audited; treat SCIM tokens as admin-grade secrets.

## Internal trust (scale-out)

`MEMOTURN_INTERNAL_TOKEN` is a shared secret for trusted replica-to-replica calls (e.g.
owner-routed profile writes). Set the same value on every replica and keep it on the internal
network. See [scaling out](/scaling/). Owner-proxied WebSockets forward client credentials in
headers — never in the proxied URL.

## Related

- [SSO (OIDC)](/sso/) and [SCIM provisioning](/scim/) — enterprise identity.
- [REST API](/api-rest/) — per-route permissions.
- [Operations](/operations/) — production hardening checklist.
- [Configuration](/configuration/#authentication--authorization) — every auth/limit setting.
