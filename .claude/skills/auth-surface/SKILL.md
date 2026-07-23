---
name: auth-surface
description: The memoturn auth architecture — the two requireAuth paths (API key vs Better Auth session), RBAC roles and denyIfReadOnly, the organization plugin (tenancy), SSO via OIDC/SAML IdPs, and the OAuth 2.1 provider for remote MCP. Use when changing anything under apps/api/src/middleware/auth.ts, packages/server/src/betterauth.ts, sessions, orgs, SSO, or MCP OAuth.
paths: apps/api/src/middleware/auth.ts, packages/server/src/betterauth.ts, packages/server/src/auth.ts
---

# The memoturn auth surface

Two auth paths converge in `requireAuth` (`apps/api/src/middleware/auth.ts`); both set `projectId` + `role` (+ `organizationId`) on the context:

1. **API key** (Basic auth `publicKey:secretKey`, SDK/programmatic) → full access as role `OWNER`. Key hashing helpers live in `packages/db`.
2. **Better Auth session cookie** (console) → honors the `x-memoturn-project` header (project switcher) and the user's org role from the session's active organization.

**RBAC**: OWNER/ADMIN/MEMBER write, VIEWER read-only. Every mutating handler calls `denyIfReadOnly(c)` (403 for VIEWER) — enforced by `bun run rbac:check` (see the rbac-auditor agent). Session cookies are prefixed `memoturn.` (`advanced.cookiePrefix`).

## Tenancy — the organization plugin

Config + role mapping in `packages/server/src/betterauth.ts` (`organization`/`member`/`invitation` tables). Projects belong to an `Organization`; `member.role` is a lowercase string mapped via `toWorkspaceRole`. New orgs auto-provision a default project (`afterCreateOrganization` hook). **Gotcha:** org mutations (create/switch/invite via `authClient.organization.*`) require an `Origin` header — browsers send it; scripts must set a trusted one or they 403 mysteriously.

## SSO

`@better-auth/sso` plugin (`ssoProvider` table, endpoints under `/auth/sso/*`): customers sign in with their own OIDC/SAML IdP, mapped by email `domain` (optionally an `organizationId`). Register/list/delete from the Organizations page; full sign-in needs a real IdP.

## Remote MCP OAuth

`@better-auth/oauth-provider` plugin — OAuth 2.1: mandatory PKCE S256, dynamic client registration, rotating refresh tokens (tables `oauthClient`/`oauthRefreshToken`/`oauthAccessToken`/`oauthConsent` + `jwks` from the `jwt()` plugin). Access tokens are JWTs verified **statelessly** by `verifyMcpBearer` in `betterauth.ts` (issuer `${AUTH_BASE_URL}/auth`, audience = API origin). The console serves the `/login` + `/consent` pages the authorize flow bounces to — the signed query string must be **round-tripped verbatim**. The remote MCP route (`apps/api/src/mcp.ts`) must NOT get a `requireAuth` guard — its method-based scope gate can't distinguish read tools from writes (every call is a POST); it does its own per-tool RBAC.

## Settled decisions (don't relitigate)

- **`secondaryStorage` (Redis-backed sessions) was evaluated and rejected** — a Redis outage would take auth down with it. Session lookups are Postgres + `cookieCache`.
- Password sign-up is HIBP-gated; org counts/invites are limited — part of the Jul 2026 hardening pass.

## Verify

`bun run typecheck`, `bun run rbac:check`, and for session-path changes sign in against the dev stack (`admin@memoturn.dev` / `memoturn-dev-123`, remember the `Origin` header in scripts).
