# Configuration

All configuration is via environment variables. Copy `.env.example` to `.env`; the
defaults match `infra/docker-compose.dev.yml`.

## Postgres (OLTP)

| Var | Default | Notes |
| --- | --- | --- |
| `DATABASE_URL` | `postgresql://memoturn:memoturn@localhost:5433/memoturn?schema=public` | Host port is **5433** in dev to avoid clashing with other local Postgres |

## Telemetry engine

| Var | Default | Notes |
| --- | --- | --- |
| `TELEMETRY_ENGINE` | `doris` | `doris` (the scale engine, default) or `postgres` — the small-install tier that keeps telemetry in the `DATABASE_URL` Postgres, schema `telemetry`, with **no Doris containers at all**. Needs a pgvector-enabled image (the shipped compose files use `pgvector/pgvector:pg16`). Sizing + how to switch engines: [Deployment → Telemetry engine](./deployment.md#telemetry-engine-doris-or-postgres). |
| `TELEMETRY_DATABASE_URL` | `DATABASE_URL` | Optional separate Postgres for the `postgres` engine's telemetry tables. |
| `TELEMETRY_PG_SCHEMA` | `telemetry` | Schema holding the `postgres` engine's tables + migration ledger. |

## Apache Doris (OLAP)

Applies when `TELEMETRY_ENGINE=doris` (the default).

| Var | Default | Notes |
| --- | --- | --- |
| `DORIS_HOST` | `localhost` | Doris FE host |
| `DORIS_PORT` | `9030` | FE MySQL-protocol port |
| `DORIS_HTTP_PORT` | `8030` | FE HTTP port |
| `DORIS_USER` | `root` | |
| `DORIS_PASSWORD` | empty | Empty in dev; **required in production** (the prod compose files include a one-shot `doris-setup` service that sets the root password) |
| `DORIS_DB` | `memoturn` | |
| `DORIS_FE_XMX` | `4096m` | FE JVM heap cap, applied by the prod compose file. Raise on hosts with memory to spare (see [Deployment → Doris sizing](./deployment.md#doris-sizing)). |
| `DORIS_BE_MEM_LIMIT` | `6G` dev / `40%` prod | BE process memory cap (absolute like `8G`, or a % of host memory). Raise if analytical queries fail with `MEM_ALLOC_FAILED`. |
| `TELEMETRY_STREAM_LOAD` | `false` | Set `true`/`1` to switch worker inserts to Doris **Stream Load** (HTTP) for higher throughput. In-network deploys just work (the FE 307-redirects to a BE). |
| `DORIS_STREAM_LOAD_HOST` | `DORIS_HOST` | Override for a host-run worker that should load a BE directly instead of going through the FE redirect. |
| `DORIS_STREAM_LOAD_PORT` | `8030` | FE HTTP port by default; point at a BE webserver (`8040`) to load it directly. |
| `DORIS_STREAM_LOAD_TIMEOUT_MS` | `60000` | Per-call Stream Load timeout so a wedged BE can't pin an ingest worker slot forever. |

## Redis / Valkey

| Var | Default | Notes |
| --- | --- | --- |
| `REDIS_URL` | `redis://localhost:6380` | Host port **6380** in dev |

## Worker & background jobs

| Var | Default | Notes |
| --- | --- | --- |
| `WORKER_CONCURRENCY` | `10` | Ingest worker concurrency |
| `WORKER_PORT` | `3002` | Worker `/health` + `/metrics` HTTP endpoint |
| `WORKER_HOST` | `127.0.0.1` | Bind host for the worker health/metrics server. Loopback by default — `/metrics` is unauthenticated and leaks queue depths and per-project evaluator names. Set `0.0.0.0` only for cross-host probes on a trusted network. |
| `WORKER_METRICS_URL` | `http://127.0.0.1:3002/metrics` | Where the API fetches worker metrics for the ingest-health panel. Set it when the API and worker run on different hosts/pods; fetch failures degrade gracefully (`workerReachable: false`). |
| `STATE_RETENTION_HOURS` | `72` | Hours a mutable-entity `*State` row stays in Postgres after its last update before the hourly prune drops it (Doris keeps full history). |
| `EXPERIMENT_CONCURRENCY` | `2` | Concurrent experiment jobs per worker process. Kept low on purpose — each job fans out over dataset items and must not starve ingest. |
| `EXPERIMENT_ITEM_CONCURRENCY` | `4` | Dataset items executed in parallel within one experiment run. |
| `MAINTENANCE_CONCURRENCY` | `4` | Maintenance-queue concurrency, so the per-minute alert tick isn't blocked behind a long daily sweep (retention/export/embeddings). Each job type is lock-guarded. |
| `GUARDRAIL_EVALUATOR_TIMEOUT_MS` | `3000` | Per-evaluator timeout for synchronous guardrail checks (they sit on the request path, so a slow LLM judge must not hang the caller). |
| `ALERT_ANOMALY_BUCKETS` | `12` | Number of trailing time buckets used as the baseline for anomaly-type alert rules. |
| `ALERT_ANOMALY_MIN_BASELINE` | `5` | Minimum baseline events before an anomaly rule can fire (suppresses noise on quiet projects). |
| `EMBEDDING_PROJECTION_DAYS` | `30` | Lookback window for the daily embedding-projection reduction. |
| `EMBEDDING_PROJECTION_MAX_POINTS` | `5000` | Cap on points per projection run. |
| `EMBEDDING_PROJECTION_CLUSTERS` | `8` | k-means cluster count for the projection. |
| `SIMILAR_TRACES_SEED_CAP` | `8` | Max seed vectors compared per "find similar traces" query (each adds a distance term to the Doris SQL). |

## Blob storage (S3-compatible)

| Var | Default |
| --- | --- |
| `BLOB_ENDPOINT` | `http://localhost:9000` |
| `BLOB_REGION` | `us-east-1` |
| `BLOB_BUCKET` | `memoturn` |
| `BLOB_ACCESS_KEY_ID` | `memoturn` |
| `BLOB_SECRET_ACCESS_KEY` | `memoturn123` |
| `BLOB_FORCE_PATH_STYLE` | `true` |

## API & console

| Var | Default | Notes |
| --- | --- | --- |
| `API_PORT` | `3001` | Hono API |
| `CONSOLE_PORT` | `3000` | Vite SPA |
| `MEMOTURN_API_URL` | `http://localhost:3001` | API target for the console dev proxy |
| `RATE_LIMIT_PER_MINUTE` | `0` | Per-project global request rate limit (requests/minute); `0` disables it (per-key limits still apply) |
| `INGEST_EVENTS_PER_MINUTE` | `0` | Per-project ingest event-rate budget (events/minute; `0` = disabled). Meters actual event volume — a single POST can carry up to 1000 events, so this catches burst loads that the request-count limit would miss. Returns `429` with `Retry-After` when exceeded. |
| `MCP_RATE_LIMIT_PER_MINUTE` | `120` | Per-IP budget for the remote MCP endpoint (`/v1/mcp/:projectId`). Unlike the project limiter it defaults **on** — the route runs a credential lookup before auth resolves, so unauthenticated clients must not get unthrottled tries. `0` disables. |
| `RATE_LIMIT_TRUSTED_PROXIES` | `1` | Number of trusted reverse proxies in front of the API, used to derive the real client IP from the right of `X-Forwarded-For` (a spoofed XFF prefix can't evade per-IP limits). The shipped Caddy deploy is one proxy; set `0` if the API is directly internet-exposed. |
| `API_METRICS_TOKEN` | unset | Enables `GET /metrics` (request counts, status classes, per-route latency percentiles). Unset → `404`; set → requires `Authorization: Bearer <token>`. |

## Auth

**Production startup guard**: in production (`NODE_ENV=production`) the API and worker refuse to start if `BETTER_AUTH_SECRET`, `ENCRYPTION_KEY`, or `AUTH_TRUSTED_ORIGINS` are missing, shorter than 16 characters, or set to a known development placeholder. Generate fresh values with `openssl rand -base64 48`.

| Var | Default | Notes |
| --- | --- | --- |
| `BETTER_AUTH_SECRET` | dev placeholder | **Required in production** — signs session cookies and tokens. Use `openssl rand -base64 48`. |
| `AUTH_BASE_URL` | `http://localhost:3001` | Better Auth base URL |
| `AUTH_TRUSTED_ORIGINS` | `http://localhost:3000` | **Required in production** — comma-separated console origins for CORS + auth. |
| `ENCRYPTION_KEY` | dev placeholder | **Required in production** — AES-256-GCM key for provider API keys stored at rest. Independent of `BETTER_AUTH_SECRET`. Rotating this invalidates all stored provider keys (they must be re-entered in Settings → Providers). |
| `MCP_LOGIN_PAGE` | `<first AUTH_TRUSTED_ORIGINS>/login` | Console sign-in page the remote-MCP OAuth 2.1 flow (Better Auth `@better-auth/oauth-provider` plugin) redirects unauthenticated users to. Override only if the console login lives elsewhere. |
| `MCP_CONSENT_PAGE` | `<first AUTH_TRUSTED_ORIGINS>/consent` | Console consent page where the OAuth flow asks the signed-in user to approve the client's requested scopes. |

### Auth hardening & tuning (optional)

| Var | Default | Notes |
| --- | --- | --- |
| `AUTH_DISABLE_PASSWORD_SIGNUP` | unset | Set `true` to disable **new** email/password signups (existing password logins still work). Meant for hosted/IdP-only deployments; leave unset for self-host so the first admin can register without SMTP or an IdP. |
| `AUTH_REQUIRE_EMAIL_VERIFICATION` | unset | Set `true` to require a verified email before sign-in (needs a working email transport). Default off so self-host accounts aren't locked out. |
| `AUTH_MIN_PASSWORD_LENGTH` | `12` | Minimum length for **new** passwords (existing shorter passwords still sign in). |
| `AUTH_HIBP_DISABLED` | unset | The breached-password check (k-anonymity, `api.pwnedpasswords.com`) is on by default and **fails closed** — signup/password-change return 500 when the service is unreachable. Airgapped/offline installs must set `true`. |
| `AUTH_COOKIE_CACHE_MAX_AGE` | `300` | Session cookie cache lifetime (seconds) — `getSession` is served from a short-lived signed cookie instead of a Postgres query. Revocations/bans take up to this long to bite on issued cookies. |
| `AUTH_COOKIE_CACHE_DISABLED` | unset | Set `true` to disable the session cookie cache entirely (every `getSession` hits Postgres). |
| `AUTH_ORG_MEMBERSHIP_LIMIT` | `10000` | Max members per organization. |
| `AUTH_ORG_INVITATION_LIMIT` | `1000` | Max pending invitations per organization. |
| `AUTH_IP_HEADERS` | unset | Comma-separated header(s) carrying the real client IP behind a proxy/CDN (first match wins), e.g. `cf-connecting-ip` or `x-real-ip`. Unset, the auth rate limiter trusts `x-forwarded-for`, which is spoofable when clients can reach the origin directly. |
| `SSO_ADMIN_GROUPS` | empty | Comma-separated IdP groups/roles that map a federated user to org `admin` on auto-join (matched against the `groups`/`roles`/`role` claims). Empty → everyone joins as `member`. |
| `SUPERADMIN_USER_IDS` | empty | Comma-separated user IDs that always pass platform-admin authorization (list/ban users, impersonate), independent of the `user.role` column. Keep empty on self-host unless you need it. |
| `PASSKEY_RP_ID` | derived | WebAuthn relying-party ID (registrable domain, no scheme/port). Defaults derive from the first `AUTH_TRUSTED_ORIGINS`; set only when the console is served from a custom domain. |
| `PASSKEY_ORIGIN` | derived | Full origin users register passkeys from. Must match the console origin. |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | unset | Enable Google sign-in (button appears only when both are set). Callback: `${AUTH_BASE_URL}/auth/callback/google`. |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | unset | Enable GitHub sign-in. Callback: `${AUTH_BASE_URL}/auth/callback/github`. |

## Email

Powers the `email` alert channel **and** auth flows (password reset, org invitations, email
verification). The transport is auto-selected: an explicit `EMAIL_TRANSPORT`, else Resend when
`RESEND_API_KEY` is set, else SMTP when `SMTP_CONNECTION_URL` or `SMTP_HOST` is set, else
disabled. When disabled, auth emails are logged to stderr in development so flows stay testable
without a mail server.

| Var | Default | Notes |
| --- | --- | --- |
| `EMAIL_TRANSPORT` | auto | Force `resend` or `smtp` instead of auto-selection. |
| `EMAIL_FROM` | `memoturn <alerts@memoturn.local>` | `From` address for all outbound mail. |
| `ALERT_EMAIL_FROM` | unset | Legacy fallback for the `From` address — used only when `EMAIL_FROM` is unset. Prefer `EMAIL_FROM`. |
| `RESEND_API_KEY` | unset | Resend HTTP API key (no SMTP server needed). |
| `SMTP_CONNECTION_URL` | unset | Single connection URL (`smtp://` / `smtps://` / `ses://<region>`); wins over the discrete vars. |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_SECURE` / `SMTP_USER` / `SMTP_PASS` | unset | Discrete SMTP settings (used when no connection URL is set). |

## LLM providers (playground + evaluators)

| Var | Default | Notes |
| --- | --- | --- |
| `LLM_TIMEOUT_MS` | `60000` | Wall-clock timeout for non-streaming provider calls (evaluator/experiment judges — a hung provider would otherwise wedge a shared worker slot). |
| `LLM_STREAM_TIMEOUT_MS` | `300000` | Timeout for streaming calls (playground). |

## Security

| Var | Default | Notes |
| --- | --- | --- |
| `ALLOW_PRIVATE_WEBHOOK_TARGETS` | unset | Set to `1` to permit `http://` and private/loopback webhook, automation, and analytics-sink URLs. Blocked by default in every environment to prevent SSRF (not just production). Useful for dev/LAN self-hosted targets. |

## SDK / examples

| Var | Default | Notes |
| --- | --- | --- |
| `MEMOTURN_BASE_URL` | `http://localhost:3001` | API base used by SDKs |
| `MEMOTURN_PUBLIC_KEY` | `pk-mt-dev` | Matches the dev key from `bun run seed` |
| `MEMOTURN_SECRET_KEY` | `sk-mt-dev` | |

## Seeding

`bun run seed` creates the default organization, project, API key, and admin user. In development the credentials are the well-known dev defaults; in production the script refuses to run unless `ALLOW_SEED=1` is set, at which point it generates random credentials and prints them once.

| Var | Default | Notes |
| --- | --- | --- |
| `ALLOW_SEED` | unset | Set to `1` to allow `bun run seed` in `NODE_ENV=production`. Without it the script exits with an error (the dev credentials are public knowledge). |
| `SEED_ADMIN_EMAIL` | `admin@memoturn.dev` | Override the seeded admin email. In production a random value is generated unless this is set. |
| `SEED_ADMIN_PASSWORD` | `memoturn-dev-123` | Override the seeded admin password. In production a random value is generated unless this is set. |

## Dev tooling

| Var | Default | Notes |
| --- | --- | --- |
| `CONSOLE_URL` | `http://localhost:3000` | Console base URL for `bun run screenshots` (the docs screenshot generator). Dev tooling only — not read by any service. |

For the security-relevant subset of these variables organized as a go-live checklist, see the
[hardening guide](./hardening.md).
