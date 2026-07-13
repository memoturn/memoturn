---
title: Runtime API keys
description: Issue, list, and revoke per-tenant API keys at runtime — the programmatic credentials for self-serve tenants and service-to-service access.
---

Beyond the static `auth_api_keys` in configuration, the Enterprise Edition can **issue API keys at
runtime** and validate them on every request. This is the programmatic credential for self-serve
tenants and CI/service-to-service callers.

Keys are stored as SHA-256 hashes of high-entropy random secrets (`mtk_…`); the raw key is shown
exactly once, at creation. Each replica keeps an in-memory map refreshed from the store, so the
per-request auth path stays fast — revocation propagates within
`MEMOTURN_API_KEY_REFRESH_SECONDS` (default 30s) across replicas, and immediately on the replica
that issued or revoked the key.

Enable by running `auth_mode` (or `auth_modes`) with **`api_key`** and installing
`memoturn-enterprise`; the runtime then chains a dynamic key authenticator alongside any static
configured keys (and alongside `oidc`, when you run both for service keys + human SSO).

## Endpoints

All require the `admin` permission and operate on the **caller's own tenant**. A key can never be
issued with more privilege than the issuer holds (and only a superadmin may mint superadmin keys).

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/v1/admin/api-keys` | Issue a key (`subject`, `roles`, `label`) — returns the raw `key` once |
| `GET` | `/v1/admin/api-keys` | List the tenant's keys (hashes only, never the raw secret) |
| `DELETE` | `/v1/admin/api-keys/{id}` | Revoke a key |

Present the key as `Authorization: Bearer mtk_…`, the `X-API-Key` header, or the WebSocket
`memoturn.bearer.<key>` subprotocol — exactly like a static key.
