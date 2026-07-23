---
title: Security hardening
description: A go-live security checklist for self-hosted memoturn — secrets, TLS, rate limits, network exposure, and account hardening.
---

A go-live checklist for self-host operators. Every knob below already exists in the product —
this page collects them in one place with their defaults and failure modes. Work through it
before exposing a deployment to the internet; the single-VM prod compose stack
(`infra/docker-compose.prod.yml`) already applies the starred (★) items.

See [Configuration](/configuration/) for the full variable reference and
[Deployment](/deployment/) for the stacks themselves.

## Secrets

- [ ] **`BETTER_AUTH_SECRET`** — signs session cookies and tokens. Generate with
  `openssl rand -base64 48`.
- [ ] **`ENCRYPTION_KEY`** — AES-256-GCM key for provider API keys stored at rest. Must be
  *distinct* from `BETTER_AUTH_SECRET`; rotating it invalidates all stored provider keys.
- [ ] The startup guard is fail-closed: in `NODE_ENV=production` the API and worker **refuse to
  start** if either secret is missing, shorter than 16 characters, or a known development
  placeholder (anything containing `please-change-in-prod`), or if `AUTH_TRUSTED_ORIGINS` is
  unset. Don't work around it — fix the env.
- [ ] Datastore credentials: set `POSTGRES_PASSWORD`, `DORIS_PASSWORD`, and
  `BLOB_SECRET_ACCESS_KEY` to fresh random values (★ the prod compose aborts on missing ones
  via `${VAR:?}`).

## TLS & reverse proxy

- [ ] Terminate TLS in front of the API and console (★ Caddy with automatic Let's Encrypt in the
  prod compose; only ports 80/443 are published — every datastore stays on the internal network).
- [ ] Set `AUTH_BASE_URL` to the public API origin and `AUTH_TRUSTED_ORIGINS` to the console
  origin(s) — CORS and auth are scoped to these (★ derived from `MEMOTURN_DOMAIN`).
- [ ] Session cookies are automatically `Secure` in production, `httpOnly`, and `SameSite=Lax`
  (prefix `memoturn.`) — no action needed, but don't serve the console over plain HTTP or the
  Secure cookies won't be sent.
- [ ] Tell memoturn how many proxies it sits behind: `RATE_LIMIT_TRUSTED_PROXIES` (default `1`,
  matching the shipped Caddy deploy) controls how the real client IP is derived from the right of
  `X-Forwarded-For`. Set `0` if the API is directly internet-exposed — otherwise a spoofed XFF
  prefix could evade per-IP limits.
- [ ] Behind a CDN or non-standard proxy, also set `AUTH_IP_HEADERS` (e.g. `cf-connecting-ip`)
  so the auth rate limiter keys on the genuine client IP instead of a spoofable
  `x-forwarded-for`.

## Rate limits

- [ ] `RATE_LIMIT_PER_MINUTE` — per-project API request budget. Defaults to `0` (disabled); the
  API logs a startup warning in production when unset. Set it, or enforce limits at your edge.
- [ ] `INGEST_EVENTS_PER_MINUTE` — per-project ingest **event** budget. The request limit alone
  is bypassable by packing up to 1000 events into one POST; this meters actual event volume.
- [ ] `MCP_RATE_LIMIT_PER_MINUTE` — per-IP throttle on the remote MCP endpoint. **On by default
  (120/min)** because the route performs a credential lookup before auth resolves; keep it on.
- [ ] Better Auth's built-in limiter throttles auth routes (60 s window, max 30, with a stricter
  sign-in sub-limit) — on by default, Redis-backed so the counter is shared across API replicas,
  and degrades to per-replica in-memory counting during a Redis outage rather than switching
  off. `AUTH_RATE_LIMIT_DISABLED` exists for test suites only — never set it in production.
- [ ] Request body sizes are already capped (1 MB default; 12 MB for `/v1/ingest`, `/v1/otel/*`,
  and `/v1/media`). If your proxy adds its own limit, keep it at or above these.

## Accounts & sign-in

- [ ] `AUTH_MIN_PASSWORD_LENGTH` — 12-character floor for new passwords (length over
  complexity, per NIST).
- [ ] The breached-password check (have-i-been-pwned, k-anonymity) is **on by default and fails
  closed**: if `api.pwnedpasswords.com` is unreachable, signup/password-change return 500.
  Airgapped installs must set `AUTH_HIBP_DISABLED=true` — everyone else should leave it on.
- [ ] `AUTH_REQUIRE_EMAIL_VERIFICATION=true` — require a verified email before sign-in
  (needs a working [email transport](/configuration/#email); default off).
- [ ] `AUTH_DISABLE_PASSWORD_SIGNUP=true` — once your IdP/SSO (or social sign-in) is live,
  disable **new** email/password signups; existing password logins keep working.
- [ ] `SUPERADMIN_USER_IDS` — platform-admin override (list/ban users, impersonate). Keep it
  empty unless you operate a multi-tenant install and need it; audit whoever is on it.
- [ ] Password resets revoke all other sessions automatically, and auth events land in the
  audit log — nothing to configure, but worth knowing during incident response.

## Network exposure

- [ ] **Never expose Doris without a root password.** While root's password is empty the FE
  HTTP query API (8030) accepts *any* credentials — anyone who can reach it can run SQL
  (★ the prod compose keeps Doris internal-only and always sets `DORIS_PASSWORD`).
- [ ] API `/metrics` is off by default (404). To scrape it, set `API_METRICS_TOKEN` and send
  `Authorization: Bearer <token>` — don't front it with an unauthenticated path.
- [ ] The worker's `/health` + `/metrics` server binds to **loopback** by default
  (`WORKER_HOST=127.0.0.1`) because `/metrics` is unauthenticated and leaks queue depths and
  per-project evaluator names. Only set `WORKER_HOST=0.0.0.0` for cross-host probes on a
  network you trust (e.g. an in-cluster probe), never on a public interface.
- [ ] Keep Postgres, Redis/Valkey, and blob storage off the public internet; only the reverse
  proxy should be reachable.

## Outbound traffic (SSRF)

- [ ] `ALLOW_PRIVATE_WEBHOOK_TARGETS` — webhook, automation, and analytics-sink URLs are
  restricted to public HTTPS in every environment by default, so a project admin can't point
  a webhook at your cloud metadata endpoint or an internal service. Set `1` only when you
  genuinely need LAN/`http://` targets, and understand what that opens up.

## Seeding & data

- [ ] Do **not** run `bun run seed` in production — it refuses without `ALLOW_SEED=1`, because
  the dev credentials (`pk-mt-dev`/`sk-mt-dev`, `admin@memoturn.dev`) are public knowledge.
  Sign up the first admin through the console instead. The same guard covers `bun run seed:demo`.
- [ ] Configure per-project **PII masking** and **retention** where required (Settings), and
  schedule off-host backups (`bun run prod:backup` — see
  [Deployment → Backups](/deployment/#single-vm-production-docker-compose--caddy)).

## Verify before launch

```bash
# Startup guard: the API must boot cleanly with your production env (no warnings about
# rate limits or placeholder secrets in the logs).
bun run prod:logs

# /metrics must 404 without the token…
curl -si https://YOUR_DOMAIN/api/metrics | head -1
# …and the worker metrics port must not be reachable from outside the host.

# Doris must reject empty credentials (from a host that can reach it, which should be none).
```
