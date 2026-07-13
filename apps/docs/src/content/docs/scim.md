---
title: SCIM provisioning
description: IdP-driven user and group lifecycle over SCIM 2.0 — tokens, supported operations, role mapping, and deactivation semantics.
---

The runtime exposes a SCIM 2.0 (RFC 7643/7644) provisioning surface at `/scim/v2`, so your IdP
creates, updates, deactivates, and groups users automatically. Provisioned records live in the
control-plane database and drive [OIDC login resolution](/sso/): explicit user roles and group
grants take precedence over token claims, and deactivated users are rejected at the door.

```sh
MEMOTURN_SCIM_ENABLED=true
```

## Tokens

SCIM authenticates with **per-tenant bearer tokens**, not the normal principal pipeline:

```sh
memoturn scim-token create --tenant acme --label okta
```

The raw token is printed exactly once (only its SHA-256 is stored). Paste it into your IdP's
SCIM connector with base URL `https://<runtime>/scim/v2`. `memoturn scim-token list|revoke`
manage the lifecycle, and the same operations are available over REST for the admin console:
`GET|POST /v1/admin/scim-tokens` and `DELETE /v1/admin/scim-tokens/{id}` (admin role,
tenant-scoped; a superadmin targets other tenants with `?tenant=`).

A SCIM token is hard-scoped to its tenant — it can never read or touch another tenant's users —
and every mutation is [audited](/security/#audit-logging) as `scim:<label>`. SCIM bypasses RBAC
by design (the IdP is the authority); treat tokens as secrets of the same grade as admin keys.
Because provisioning is tenant-scoped, the `superadmin` platform role cannot be assigned
through SCIM (writes carrying it are rejected with `400 invalidValue`); platform operators
authenticate through an unbound OIDC issuer instead.

## Supported operations

| Area | Supported |
| --- | --- |
| Resources | `/Users`, `/Groups`, `/ServiceProviderConfig`, `/ResourceTypes`, `/Schemas` |
| Methods | GET, POST, PUT, PATCH, DELETE |
| Filtering | `userName eq "…"`, `externalId eq "…"` (Users); `displayName eq "…"`, `externalId eq "…"` (Groups) — the lookup-before-create subset IdPs use. Anything else: `400 invalidFilter`. |
| Pagination | `startIndex` / `count` (capped by `MEMOTURN_SCIM_MAX_PAGE_SIZE`, default 200) |
| PATCH | Whole-resource `replace`; attribute paths `active`, `userName`, `displayName`, `externalId`, `roles`; group `members` add/remove/replace including `members[value eq "…"]` removal. String booleans (`"True"`/`"False"`) are coerced. |
| DELETE | Soft-deactivates (`active=false`) by default; `MEMOTURN_SCIM_HARD_DELETE=true` destroys. |

Errors use the SCIM `Error` schema (`status`, `scimType`, `detail`); responses are
`application/scim+json`.

## Role mapping

Two complementary paths:

- A user's SCIM `roles` attribute (`[{"value": "admin"}]`) sets **explicit roles** — the highest
  precedence at login.
- Group membership grants the **group's roles**: set them per group on the runtime side (groups
  are created by the IdP; roles are operator policy, e.g. via the identity store) — a user with
  no explicit roles inherits the union of their groups' roles.

Token-claim roles apply only when neither is set. See [SSO](/sso/#claim-mapping).

## Deactivation semantics

`active=false` (via PATCH or default DELETE) immediately stops the user's OIDC logins — even
with a valid, unexpired IdP token — because resolution checks the record on every request.
History stays attributable to the userName. Hard delete removes the record entirely; prefer
soft-deactivation for auditability.

## Linking to OIDC logins

IdPs provision by `userName` (usually the email) before the user ever signs in. On first OIDC
login the runtime links the token's subject to the matching record via `preferred_username` /
`email`, then resolves by subject from there on. For SCIM-managed deployments set
`MEMOTURN_AUTH_OIDC_REQUIRE_PROVISIONED=true` so deprovisioned (or never-provisioned) subjects
cannot authenticate at all.

## Related

- [SSO (OIDC)](/sso/) — token verification and login resolution.
- [Security](/security/) — threat model, tenancy, audit.
- [Configuration](/configuration/#scim-provisioning) — every SCIM setting.
