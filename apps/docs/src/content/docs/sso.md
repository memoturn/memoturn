---
title: Single sign-on (OIDC)
description: Verify IdP-issued tokens with auth mode "oidc" — JWKS, claim mapping, per-tenant issuers, JIT provisioning, and the console login flow.
---

Auth mode `oidc` verifies RS256/ES256 bearer tokens minted by your identity provider against its
published JWKS. The runtime never runs a login flow for API calls — it validates what the IdP
issued, then maps verified claims (and, when [provisioned](/scim/), your user records) to a
principal. Requires the `oidc` extra:

```sh
pip install "memoturn[oidc]"
```

## Minimal setup

```sh
MEMOTURN_AUTH_MODE=oidc
MEMOTURN_AUTH_OIDC_ISSUER=https://login.example.com/realms/acme
MEMOTURN_AUTH_OIDC_CLIENT_ID=memoturn-console
```

The issuer's JWKS endpoint is discovered via `/.well-known/openid-configuration` (override with
`MEMOTURN_AUTH_OIDC_JWKS_URL`). Discovery and JWKS must be served over `https` (localhost is
exempt for development). Keys are cached and refreshed on rotation; a hard TTL
(`MEMOTURN_AUTH_OIDC_JWKS_TTL_SECONDS`, default 1h) bounds how long a revoked key lingers.

Verification is strict by default:

- only `RS256`/`ES256` are accepted (`MEMOTURN_AUTH_OIDC_ALGORITHMS`); `alg=none` and symmetric
  algorithms are rejected unconditionally (no key-confusion downgrades);
- `iss` must match a registered issuer; `aud` must match `MEMOTURN_AUTH_OIDC_AUDIENCE`
  (falls back to the client id);
- `exp`/`nbf` are enforced with 30s leeway.

## Claim mapping

| Setting | Default | Maps |
| --- | --- | --- |
| `MEMOTURN_AUTH_OIDC_SUBJECT_CLAIM` | `sub` | → principal subject |
| `MEMOTURN_AUTH_OIDC_TENANT_CLAIM` | — | → tenant (else the default tenant) |
| `MEMOTURN_AUTH_OIDC_ROLES_CLAIM` | `roles` | → roles |
| `MEMOTURN_AUTH_OIDC_GROUPS_CLAIM` | `groups` | → roles via the group→role map |
| `MEMOTURN_AUTH_OIDC_GROUP_ROLE_MAP` | `{}` | e.g. `{"platform-admins": "admin"}` |
| `MEMOTURN_AUTH_OIDC_DEFAULT_ROLE` | `member` | when no role claim resolves |

When the [identity store](/scim/) holds a user record for the token's subject, the record wins:
explicit user roles take precedence over group-granted roles, which take precedence over token
claims. Deactivated users are rejected regardless of what their token says.

## Per-tenant issuers

A multi-org deployment registers one issuer per tenant — an issuer is **hard-bound** to its
tenant, so its tokens can never mint principals anywhere else:

```sh
memoturn oidc-provider add \
  --issuer https://login.acme.example.com \
  --tenant acme \
  --client-id memoturn \
  --group-role-map '{"acme-platform": "admin"}'
```

Registrations live in the control-plane database and reach running replicas within
`MEMOTURN_AUTH_OIDC_PROVIDER_REFRESH_SECONDS` (default 60) — no restart. `memoturn
oidc-provider list|remove` manage them, as do the REST equivalents used by the admin console:
`GET|PUT|DELETE /v1/admin/oidc-providers`. Over REST a tenant admin's registration is always
pinned to its own tenant — only a superadmin can bind an issuer to another tenant or register
a claim-driven (unbound) issuer.

## Provisioning policies

- `MEMOTURN_AUTH_OIDC_JIT_PROVISION=true` — create a user record on first login
  (subject, userName from `preferred_username`/`email`, display name, emails).
- `MEMOTURN_AUTH_OIDC_REQUIRE_PROVISIONED=true` — reject logins whose subject has no user
  record (the right default for SCIM-managed deployments).
- Neither — unknown subjects fall back to pure claim mapping.

## Console login

The bundled console reads `GET /v1/auth/config` and, when OIDC is on, offers **Sign in with
SSO** — an Authorization Code + PKCE flow:

- **Backend exchange** (recommended): set `MEMOTURN_AUTH_OIDC_CLIENT_SECRET` (or mount
  `/run/secrets/MEMOTURN_AUTH_OIDC_CLIENT_SECRET`). The console sends the code to
  `POST /v1/auth/callback`; the runtime exchanges it as a confidential client (PKCE still
  applies) and verifies the resulting ID token through the same authenticator that guards the
  API before handing it back.
- **Public client**: with no client secret, the console performs the PKCE exchange directly
  against the IdP's token endpoint. Allow your console origin as a public client redirect
  (`https://<runtime>/console/`).

Manual token paste remains available whenever OIDC is off.

## Service credentials alongside SSO

Run both with `MEMOTURN_AUTH_MODES='["api_key", "oidc"]'` — service integrations keep static
API keys while humans sign in through the IdP. Each authenticator is tried in order; the first
success wins.

## SAML

The runtime is OIDC-native and does not terminate SAML itself. SAML-only identity stacks
integrate in one of two ways:

1. **Bridge at the IdP** (recommended): Okta, Microsoft Entra ID, and Ping can all front a SAML
   directory while issuing OIDC tokens to applications — register the runtime as an OIDC app and
   the SAML federation stays inside the IdP.
2. **Gateway translation**: deploy an SSO proxy that speaks SAML upstream and OIDC downstream
   (e.g. Dex) and point `MEMOTURN_AUTH_OIDC_ISSUER` at it.

Native SAML SP support is tracked as a follow-up; the XML signature stack it drags in is a
recurring CVE source, so it ships only when bridging genuinely can't work.

## Related

- [SCIM provisioning](/scim/) — IdP-driven user/group lifecycle.
- [Security](/security/) — auth modes, RBAC, tenancy.
- [Configuration](/configuration/#authentication--authorization) — every setting.
