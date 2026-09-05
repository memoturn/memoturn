---
title: Security hardening
description: A go-live security checklist for self-hosted Memoturn — secrets, TLS, rate limits, network exposure, and account hardening.
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
- [ ] **`ENCRYPTION_KEY`** — AES-256-GCM key (scrypt-derived) for every secret stored at rest:
  provider API keys, automation secrets, analytics-sink keys, webhook signing secrets. Must be
  *distinct* from `BETTER_AUTH_SECRET`. **Rotatable** without losing anything:
  `ENCRYPTION_KEYS=new,old` → restart → `bun run rotate-secrets` → `ENCRYPTION_KEYS=new`
  (see [Runbooks](/runbooks/#rotate-encryption_key)).
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
- [ ] Tell Memoturn how many proxies it sits behind: `RATE_LIMIT_TRUSTED_PROXIES` (default `1`,
  matching the shipped Caddy deploy) controls how the real client IP is derived from the right of
  `X-Forwarded-For`. Set `0` if the API is directly internet-exposed — otherwise a spoofed XFF
  prefix could evade per-IP limits.
- [ ] Behind a CDN or non-standard proxy, also set `AUTH_IP_HEADERS` (e.g. `cf-connecting-ip`)
  so the auth rate limiter keys on the genuine client IP instead of a spoofable
  `x-forwarded-for`.

## Rate limits

- [ ] `RATE_LIMIT_PER_MINUTE` — per-project API request budget, **on by default (600/min)**;
  `0` disables (the API warns at boot in production). Also enforced on the remote MCP
  endpoint once the key/user resolves.
- [ ] `INGEST_EVENTS_PER_MINUTE` — per-project ingest **event** budget, on by default
  (60000/min). The request limit alone is bypassable by packing up to 1000 events into one
  POST; this meters actual event volume.
- [ ] **Hard cost cap** — a project's monthly budget (Settings → Alerts) can be a *cap*: with
  "Hard cap" on, the playground, assistant, evaluators, and experiments refuse to spend
  (HTTP 402) once month-to-date cost reaches the budget. Without it the budget only notifies.
- [ ] `PLAYGROUND_MAX_TOKENS` — ceiling on a single playground/assistant completion (default
  `32768`). The playground and assistant spend the project's provider key, so they are
  write-gated (VIEWERs get 403) and every request is validated against this cap.
- [ ] `MCP_RATE_LIMIT_PER_MINUTE` — per-IP throttle on the remote MCP endpoint. **On by default
  (120/min)** because the route performs a credential lookup before auth resolves; keep it on.
- [ ] Better Auth's built-in limiter throttles auth routes (60 s window, max 30, with a stricter
  sign-in sub-limit) — on by default, Redis-backed so the counter is shared across API replicas,
  and degrades to per-replica in-memory counting during a Redis outage rather than switching
  off. `AUTH_RATE_LIMIT_DISABLED` exists for test suites only — never set it in production.
- [ ] Request body sizes are capped on `/v1/*` (1 MB default; 12 MB for `/v1/ingest`,
  `/v1/otel/*`, `/v1/media`, and `/v1/mcp/*`). The `/auth/*` routes are **not** yet capped
  in-app — set a body limit for them at your proxy (Caddy `request_body { max_size 256KB }`).
  If your proxy adds its own limit elsewhere, keep it at or above the in-app values.

## Ingest sampling & usage

Per-project settings (`/v1/sampling`, `/v1/usage`, or the console **Settings** page), not env vars:

- [ ] **Head sampling** — `rate` (0–100) keeps that percent of traces in the query store, decided
  by a stable per-trace hash so whole traces are kept or dropped consistently. 100 (default) keeps
  everything. The raw batch always lands in blob regardless — sampling trims what's *queryable* to
  control Doris/Postgres volume and cost, it never loses data (blob is the replay source).
- [ ] **Tail keep-rules** — below 100%, a trace is kept regardless of the head dice when it looks
  worth debugging: `keepOnError` (an error-level span), `keepLatencyMs` (a span at/over that
  latency), `keepMinCostUsd` (total cost at/over that spend). So a low rate sheds routine volume
  while always preserving the interesting traces. *Limitation:* keep-rules evaluate against each
  batch as it arrives; if a keep-signal (e.g. an error span) lands in a **later** batch than
  already-dropped spans of the same trace, the kept trace is partial — rare in practice (SDKs flush
  a trace's spans together; terminal errors land with the trace), and blob replay is the
  full-fidelity recovery path.
- [ ] **Usage metering** (`/v1/usage`) records bytes/events/traces ingested per day, measured on the
  raw batch **before** sampling — so it reflects everything you send. Always on; no configuration.

## Accounts & sign-in

- [ ] `AUTH_MIN_PASSWORD_LENGTH` — 12-character floor for new passwords (length over
  complexity, per NIST).
- [ ] The breached-password check (have-i-been-pwned, k-anonymity) is **on by default and fails
  closed**: if `api.pwnedpasswords.com` is unreachable, signup/password-change return 500.
  Airgapped installs must set `AUTH_HIBP_DISABLED=true` — everyone else should leave it on.
- [ ] `AUTH_REQUIRE_EMAIL_VERIFICATION` — require a verified email before sign-in. **Default
  on in production whenever an email transport is configured** (off in dev, and on installs
  with no mailer); set `false` to opt out.
- [ ] Brute-force guards: password sign-in is limited to `AUTH_SIGNIN_MAX_PER_15M` (10)
  attempts per IP per 15 min on top of the generic auth window; 2FA code checks have fixed
  sub-limits. An organization can **require 2FA** for every member by setting
  `{"requireTwoFactor": true}` in its metadata (`authClient.organization.update`) — members
  without 2FA enrolled get 403 until they enrol.
- [ ] API keys can carry a default lifetime (`API_KEY_DEFAULT_EXPIRY_DAYS`); unknown org roles
  from an IdP mapping now resolve to VIEWER (read-only), never to a writing role.
- [ ] `AUTH_DISABLE_PASSWORD_SIGNUP=true` — once your IdP/SSO (or social sign-in) is live,
  disable **new** email/password signups; existing password logins keep working.
- [ ] **API keys act as MEMBER, not OWNER.** A key with the default `read`/`write`/`ingest`
  scopes can write telemetry and project data but cannot reach admin-only routes (project
  delete/rename, membership, key management, DLQ replay). Only a key minted with the explicit
  `admin` scope acts as OWNER — and only an OWNER/ADMIN can mint or list keys. Treat `admin`
  keys like root credentials: short expiry, one per automation, revoke on rotation.
- [ ] `SUPERADMIN_USER_IDS` — platform-admin override (list/ban users, impersonate). Keep it
  empty unless you operate a multi-tenant install and need it; audit whoever is on it.
- [ ] Password resets revoke all other sessions automatically, and auth events land in the
  audit log — nothing to configure, but worth knowing during incident response.

## Network exposure

- [ ] **Never expose Doris without a root password.** While root's password is empty the FE
  HTTP query API (8030) accepts *any* credentials — anyone who can reach it can run SQL
  (★ the prod compose keeps Doris internal-only and always sets `DORIS_PASSWORD`).
- [ ] API `/metrics` is off by default (404). To scrape it, set `API_METRICS_TOKEN` and send
  `Authorization: Bearer <token>` — don't front it with an unauthenticated path. It serves
  Prometheus text exposition when the scraper asks for it (`Accept: text/plain`, which
  Prometheus sends, or `?format=prometheus`) and JSON otherwise; the worker's `/metrics`
  does the same. `GET /ready` (API + worker) is a public readiness probe that reports
  only ok/latency per dependency — never error details.
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
  genuinely need LAN/`http://` targets, and understand what that opens up. In production the
  startup guard **refuses to boot** with it set unless `ALLOW_PRIVATE_WEBHOOK_TARGETS_ACK=1`
  is also present — the dev `.env.example` ships it on, and this stops that file from being
  copied to a server unnoticed. `AUTH_RATE_LIMIT_DISABLED` is refused outright.

## Images & supply chain

- [ ] Pin the image tag you deploy (`ghcr.io/memoturn/api:<version>`), never `latest`, and
  verify provenance: every published image carries an SBOM and SLSA provenance attestation
  (`docker buildx imagetools inspect <image> --format '{{json .Provenance}}'`).
- [ ] The published images are Trivy-scanned weekly (Security tab of the repo); re-pull on a
  new patch release rather than patching inside a running container.
- [ ] Prefer `NODE_ENV=production` explicitly — the startup guard now refuses a public https
  `AUTH_BASE_URL` without it, because every production protection keys on that variable.

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
