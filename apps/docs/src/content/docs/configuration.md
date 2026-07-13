---
title: Configuration
description: Every Memoturn setting — environment variables, defaults, and what they do.
---

Memoturn is configured through environment variables (prefix `MEMOTURN_`) or a `.env` file in the
working directory. `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` are read **without** the prefix to
match the official SDKs. Unknown variables are ignored.

List/object settings (`MEMOTURN_MCP_SERVERS`, `MEMOTURN_A2A_REMOTE_AGENTS`,
`MEMOTURN_AUTH_API_KEYS`) take **JSON** in the environment variable.

## Server

| Variable | Default | Description |
| --- | --- | --- |
| `MEMOTURN_HOST` | `0.0.0.0` | Listen address. |
| `MEMOTURN_PORT` | `8080` | Listen port. |
| `MEMOTURN_DEFAULT_TENANT` | `default` | Tenant used when none is asserted. |

## LLM provider

See [Providers](/providers/).

| Variable | Default | Description |
| --- | --- | --- |
| `MEMOTURN_LLM_PROVIDER` | `anthropic` | `anthropic` · `openai` · `ollama` · `bedrock` · `vertex`. |
| `MEMOTURN_MODEL` | `claude-sonnet-4-6` | Model id / name for the chosen provider. |
| `ANTHROPIC_API_KEY` | — | Anthropic API key (no prefix). |
| `OPENAI_API_KEY` | — | OpenAI API key (no prefix). |
| `MEMOTURN_OPENAI_BASE_URL` | `https://api.openai.com/v1` | OpenAI endpoint. |
| `MEMOTURN_OLLAMA_BASE_URL` | `http://localhost:11434/v1` | Ollama endpoint (OpenAI-compatible). |
| `MEMOTURN_BEDROCK_REGION` | `us-east-1` | AWS region for Bedrock. |
| `MEMOTURN_VERTEX_PROJECT_ID` | `""` | GCP project for Vertex (auto-detect if empty). |
| `MEMOTURN_VERTEX_REGION` | `us-east5` | GCP region for Vertex. |

## Storage & persistence

See [Agents & actors](/agents/) and [Workspace](/workspace/).

| Variable | Default | Description |
| --- | --- | --- |
| `MEMOTURN_DATA_DIR` | `./data` | Root for per-agent and profile databases (`agents/`, `profiles/`, `snapshots/`). |
| `MEMOTURN_HIBERNATE_AFTER_SECONDS` | `30` | Idle seconds before an actor hibernates. |
| `MEMOTURN_SNAPSHOT_BACKEND` | `none` | Durable backing: `none` · `file` · `s3`. |
| `MEMOTURN_SNAPSHOT_DIR` | `./data/snapshots` | Directory for the `file` backend. |
| `MEMOTURN_SNAPSHOT_EVICT_LOCAL` | `true` | Drop the local DB after a successful snapshot. |
| `MEMOTURN_POSTGRES_DSN` | — | Postgres DSN (shared control plane; required for [scale-out](/scaling/)). |
| `MEMOTURN_S3_ENDPOINT` | — | S3 / MinIO endpoint (snapshots + workspace blobs). |
| `MEMOTURN_S3_ACCESS_KEY` | — | S3 access key. |
| `MEMOTURN_S3_SECRET_KEY` | — | S3 secret key. |
| `MEMOTURN_S3_BUCKET` | `memoturn-workspaces` | S3 bucket. |

The object-store client uses these access/secret keys directly; it does **not** fall back to a
cloud credential chain, so pod identity (IRSA / GKE Workload Identity) does not cover the object
store — set explicit keys. On GKE the shipped [Terraform module](/deployment/) provisions a static
GCS HMAC key for exactly this. (Model providers such as Bedrock/Vertex do read the ambient cloud
chain — that's independent of object-store auth.)

## Fibers (durable execution)

See [Durable execution](/fibers/).

| Variable | Default | Description |
| --- | --- | --- |
| `MEMOTURN_FIBER_POLL_SECONDS` | `2` | Scheduler sweep interval. |
| `MEMOTURN_FIBER_STALE_AFTER_SECONDS` | `60` | Heartbeat age before a running fiber is treated as crashed and recovered. |

## Guardrails & turn control

See [Guardrails & approvals](/guardrails/).

| Variable | Default | Description |
| --- | --- | --- |
| `MEMOTURN_MODEL_RETRY_ATTEMPTS` | `0` | Retry a model call that fails before any output streamed (0 disables). |
| `MEMOTURN_MODEL_RETRY_BACKOFF_SECONDS` | `1.0` | Base backoff between retries (exponential). |
| `MEMOTURN_MODEL_FALLBACK` | `""` | Fallback model (same provider backend) after retries are exhausted. |
| `MEMOTURN_TOOL_CALL_LIMIT_PER_TURN` | `0` | Max calls per tool per turn (0 disables). |
| `MEMOTURN_PII_REDACTION_ENABLED` | `false` | Redact well-formatted PII from model input (history untouched). |
| `MEMOTURN_HITL_TOOLS` | `[]` | Tools that pause for human approval before running. |
| `MEMOTURN_DOUBLE_TEXTING_DEFAULT` | `enqueue` | `enqueue` · `reject` · `interrupt` · `rollback` when a message arrives mid-turn. |
| `MEMOTURN_EVENT_JOURNAL_SIZE` | `1024` | Per-agent replay window for [stream resumption](/api-websocket/#stream-resumption). |

## Webhooks

See [Webhooks](/webhooks/).

| Variable | Default | Description |
| --- | --- | --- |
| `MEMOTURN_WEBHOOKS` | `[]` | JSON list of receivers: `{url, secret?, headers?, events?}`. |
| `MEMOTURN_WEBHOOK_MAX_ATTEMPTS` | `3` | Delivery attempts (5xx/network only; exponential backoff). |
| `MEMOTURN_WEBHOOK_TIMEOUT_SECONDS` | `10` | Per-delivery timeout. |
| `MEMOTURN_WEBHOOK_RETRY_BACKOFF_SECONDS` | `1.0` | Base retry backoff. |
| `MEMOTURN_WEBHOOK_ALLOW_HTTP` | `false` | Allow plain-http receivers beyond loopback (dev only). |
| `MEMOTURN_WEBHOOK_DLQ_ENABLED` | `true` | Keep undeliverable events in the [dead-letter queue](/webhooks/#dead-letters). |
| `MEMOTURN_WEBHOOK_DLQ_MAX_ENTRIES` | `1000` | DLQ retention cap (oldest evicted). |

## Context & memory

See [Sessions](/sessions/) and [Memory](/memory/).

| Variable | Default | Description |
| --- | --- | --- |
| `MEMOTURN_COMPACTION_THRESHOLD_TOKENS` | `12000` | Compact the thread above this; `0` disables. |
| `MEMOTURN_COMPACTION_KEEP_RECENT_TURNS` | `4` | Recent turns kept uncompacted. |
| `MEMOTURN_MEMORY_ENABLED` | `true` | Enable long-term memory. |
| `MEMOTURN_MEMORY_EMBEDDER` | `none` | `none` · `openai` · `ollama` · `sentence_transformers` · `bedrock` · `vertex`. |
| `MEMOTURN_MEMORY_EMBEDDING_MODEL` | `text-embedding-3-small` | Embedding model name. |
| `MEMOTURN_MEMORY_AUTO_INGEST` | `true` | Extract memories from turns at compaction. |
| `MEMOTURN_MEMORY_EXTRACTION_PASSES` | `2` | Extraction passes. |
| `MEMOTURN_MEMORY_EXTRACTION_VERIFY` | `true` | Verify extracted memories against the source. |
| `MEMOTURN_MEMORY_AUTO_RECALL` | `false` | Inject recalled memories into the system prompt each turn. |
| `MEMOTURN_MEMORY_AUTO_RECALL_LIMIT` | `5` | Max memories auto-recalled per turn. |
| `MEMOTURN_MEMORY_RECALL_DEFAULT_LIMIT` | `8` | Default limit for explicit recall. |
| `MEMOTURN_MEMORY_RRF_K` | `60` | Reciprocal Rank Fusion constant. |
| `MEMOTURN_MEMORY_FACT_WEIGHT` | `1.3` | Score multiplier for `fact` memories. |
| `MEMOTURN_MEMORY_MAX_ACTIVE` | `0` | Cap on active memories per store (`0` = unlimited). |
| `MEMOTURN_MEMORY_HISTORY_RETENTION_DAYS` | `0` | Retain superseded/forgotten versions N days (`0` = forever). |
| `MEMOTURN_MEMORY_HISTORY_MAX_PER_TOPIC` | `0` | Keep at most N inactive versions per topic (`0` = unlimited). |
| `MEMOTURN_MEMORY_VECTOR_INDEX` | `brute_force` | `brute_force` · `sqlite_vec`. |
| `MEMOTURN_PROFILE_BACKEND` | `sqlite` | Cross-agent profile store: `sqlite` · `postgres`. |
| `MEMOTURN_PROFILE_POSTGRES_DSN` | `""` | Postgres DSN for profiles (falls back to `MEMOTURN_POSTGRES_DSN`). |
| `MEMOTURN_PROFILE_EMBEDDING_DIM` | `1536` | pgvector column dimension; match your embedder. |

## Sandbox & execution

See [Sandboxing](/sandboxing/) and the [execution ladder](/execution-ladder/).

| Variable | Default | Description |
| --- | --- | --- |
| `MEMOTURN_SANDBOX_BACKEND` | `subprocess` | `subprocess` · `docker` · `k8s`. |
| `MEMOTURN_SANDBOX_TIMEOUT_SECONDS` | `30` | Per-execution timeout. |
| `MEMOTURN_SANDBOX_MEMORY_MB` | `256` | Memory limit. |
| `MEMOTURN_SANDBOX_CPUS` | `1.0` | CPU limit (Docker/K8s). |
| `MEMOTURN_SANDBOX_MAX_PROCESSES` | `128` | PID limit (Docker). |
| `MEMOTURN_SANDBOX_WARM_POOL_SIZE` | `0` | Pre-started single-use containers ([warm pools](/sandboxing/#warm-pools); Docker; 0 disables). |
| `MEMOTURN_SANDBOX_WARM_MAX_IDLE_SECONDS` | `3600` | Idle warm container self-expiry (leak protection). |
| `MEMOTURN_SANDBOX_HTTP_ENABLED` | `false` | Grant `http_fetch` ([credential-injecting egress](/sandboxing/#http-egress-with-credential-injection)). |
| `MEMOTURN_SANDBOX_HTTP_ALLOW_HOSTS` | `[]` | Egress allowlist (exact hosts or `*.suffix`); empty = any public host. |
| `MEMOTURN_SANDBOX_HTTP_TIMEOUT_SECONDS` | `20` | Egress request timeout. |
| `MEMOTURN_SANDBOX_HTTP_MAX_RESPONSE_BYTES` | `262144` | Response body cap returned to the sandbox. |
| `MEMOTURN_EGRESS_CREDENTIALS` | `[]` | JSON list: `{host, header?, value? \| secret? \| oauth_provider?}` injected by host match (HTTPS only). |
| `MEMOTURN_SANDBOX_IMAGE` | `memoturn-sandbox:latest` | Sandbox image (Docker/K8s). |
| `MEMOTURN_SANDBOX_FULL_IMAGE` | `memoturn-sandbox-full:latest` | Tier 4 full-OS image. |
| `MEMOTURN_SANDBOX_ALLOW_DEPENDENCIES` | `true` | Allow Tier 2 dependency resolution. |
| `MEMOTURN_SANDBOX_SHELL_TIMEOUT_SECONDS` | `60` | Tier 4 shell timeout. |
| `MEMOTURN_SANDBOX_SHELL_NETWORK` | `true` | Allow network in the shell container. |
| `MEMOTURN_SANDBOX_ENABLE_LOCAL_SHELL` | `false` | Allow the un-isolated local shell (dev only). |
| `MEMOTURN_SANDBOX_K8S_NAMESPACE` | `default` | Namespace for exec pods. |
| `MEMOTURN_SANDBOX_K8S_RUNTIME_CLASS` | `gvisor` | RuntimeClass for exec pods (`""` = cluster default). |
| `MEMOTURN_SANDBOX_K8S_BRIDGE_ENABLED` | `false` | Enable the capability bridge for K8s pods. |
| `MEMOTURN_SANDBOX_K8S_BRIDGE_PORT` | `8077` | Bridge TCP port. |
| `MEMOTURN_SANDBOX_K8S_BRIDGE_HOST` | `""` | Advertised bridge host (defaults to `POD_IP`). |
| `MEMOTURN_WORKSPACE_INLINE_MAX_BYTES` | `65536` | Inline-vs-blob threshold for workspace files. |
| `MEMOTURN_BROWSER_ENABLED` | `false` | Enable the Tier 3 browser. |
| `MEMOTURN_BROWSER_TIMEOUT_SECONDS` | `30` | Browser fetch/screenshot timeout. |

## MCP

See [MCP](/mcp/).

| Variable | Default | Description |
| --- | --- | --- |
| `MEMOTURN_MCP_SERVERS` | `[]` | External MCP servers to mount as tools (JSON). |
| `MEMOTURN_MCP_STRICT` | `false` | Fail startup if a server fails to connect (else skip). |
| `MEMOTURN_MCP_SERVER_ENABLED` | `false` | Expose each agent as an MCP server under `/mcp/{agent}`. |
| `MEMOTURN_MCP_SERVER_STATELESS` | `true` | Stateless transport (scale-out friendly) vs. in-memory sessions. |
| `MEMOTURN_MCP_SERVER_EXPOSE_RESOURCES` | `false` | Expose agent memories as read-only MCP resources. |

## A2A

See [A2A](/a2a/).

| Variable | Default | Description |
| --- | --- | --- |
| `MEMOTURN_A2A_ENABLED` | `false` | Expose each agent as an A2A server under `/a2a/{agent}`. |
| `MEMOTURN_A2A_PUBLIC_BASE_URL` | `""` | External base URL advertised in agent cards. |
| `MEMOTURN_A2A_REMOTE_AGENTS` | `[]` | Remote A2A agents to mount as tools (JSON). |

## Authentication & authorization

See [Security](/security/).

| Variable | Default | Description |
| --- | --- | --- |
| `MEMOTURN_AUTH_MODE` | `none` | `none` (dev) · `api_key` · `jwt` · `oidc`. Unknown values fail closed. |
| `MEMOTURN_AUTH_MODES` | `[]` | Run several modes side by side (JSON list; overrides `AUTH_MODE`). |
| `MEMOTURN_REQUIRE_AUTH` | `false` | Refuse to start while `auth_mode` is `none`. |
| `MEMOTURN_AUTH_API_KEYS` | `[]` | API keys → principals (JSON: `key`, `tenant`, `subject`, `roles`). |
| `MEMOTURN_AUTH_JWT_SECRET` | `""` | HS256 shared secret for JWT mode. |
| `MEMOTURN_AUTH_JWT_SECRETS` | `{}` | Additional active secrets by `kid` (zero-downtime rotation, JSON). |
| `MEMOTURN_AUTH_JWT_ISSUER` | — | Expected `iss` claim (optional). |
| `MEMOTURN_AUTH_JWT_AUDIENCE` | — | Expected `aud` claim (optional). |
| `MEMOTURN_AUTH_JWT_TENANT_CLAIM` | `tenant` | Claim mapped to the principal's tenant. |
| `MEMOTURN_AUTH_JWT_ROLES_CLAIM` | `roles` | Claim mapped to roles. |
| `MEMOTURN_AUTH_JWT_SUBJECT_CLAIM` | `sub` | Claim mapped to the subject. |
| `MEMOTURN_AUTH_WS_ALLOW_QUERY_TOKEN` | `true` | Accept the deprecated `?token=` WebSocket parameter. |
| `MEMOTURN_AUTH_WS_FIRST_MESSAGE_TIMEOUT_SECONDS` | `5` | Deadline for a first-message auth frame. |
| `MEMOTURN_INTERNAL_TOKEN` | `""` | Shared secret for trusted replica-to-replica calls. |
| `MEMOTURN_BLOB_ENCRYPTION_KEY` | `""` | Encrypt workspace blobs at rest (`""` = off). |

## OIDC (SSO)

See [SSO](/sso/). Needs the `oidc` extra.

| Variable | Default | Description |
| --- | --- | --- |
| `MEMOTURN_AUTH_OIDC_ISSUER` | `""` | IdP issuer URL (discovery at `/.well-known/openid-configuration`). |
| `MEMOTURN_AUTH_OIDC_CLIENT_ID` | `""` | OAuth client id (also the default audience). |
| `MEMOTURN_AUTH_OIDC_CLIENT_SECRET` | `""` | Enables the backend code exchange for console login. |
| `MEMOTURN_AUTH_OIDC_AUDIENCE` | `""` | Expected `aud`; falls back to the client id. |
| `MEMOTURN_AUTH_OIDC_ALGORITHMS` | `["RS256","ES256"]` | Allowed signature algorithms. |
| `MEMOTURN_AUTH_OIDC_JWKS_URL` | `""` | Explicit JWKS endpoint (skips discovery). |
| `MEMOTURN_AUTH_OIDC_JWKS_TTL_SECONDS` | `3600` | Hard TTL on cached JWKS. |
| `MEMOTURN_AUTH_OIDC_SCOPES` | `openid profile email` | Scopes the console requests. |
| `MEMOTURN_AUTH_OIDC_TENANT` | `""` | Static tenant binding for the settings issuer. |
| `MEMOTURN_AUTH_OIDC_TENANT_CLAIM` | `""` | Claim mapped to the tenant when unbound. |
| `MEMOTURN_AUTH_OIDC_SUBJECT_CLAIM` | `sub` | Claim mapped to the subject. |
| `MEMOTURN_AUTH_OIDC_ROLES_CLAIM` | `roles` | Claim mapped to roles. |
| `MEMOTURN_AUTH_OIDC_GROUPS_CLAIM` | `groups` | Claim mapped through the group→role map. |
| `MEMOTURN_AUTH_OIDC_GROUP_ROLE_MAP` | `{}` | IdP group → memoturn role (JSON). |
| `MEMOTURN_AUTH_OIDC_DEFAULT_ROLE` | `member` | Role when no claim resolves. |
| `MEMOTURN_AUTH_OIDC_JIT_PROVISION` | `false` | Create a user record on first login. |
| `MEMOTURN_AUTH_OIDC_REQUIRE_PROVISIONED` | `false` | Reject subjects without a user record. |
| `MEMOTURN_AUTH_OIDC_PROVIDER_REFRESH_SECONDS` | `60` | Re-read DB-registered issuers this often. |

## SCIM provisioning

See [SCIM](/scim/).

| Variable | Default | Description |
| --- | --- | --- |
| `MEMOTURN_SCIM_ENABLED` | `false` | Mount `/scim/v2`. |
| `MEMOTURN_SCIM_HARD_DELETE` | `false` | DELETE destroys instead of deactivating. |
| `MEMOTURN_SCIM_MAX_PAGE_SIZE` | `200` | Pagination cap. |

## Transport security

| Variable | Default | Description |
| --- | --- | --- |
| `MEMOTURN_SECURITY_HEADERS_ENABLED` | `true` | Add defense-in-depth response headers. |
| `MEMOTURN_CSP` | `frame-ancestors 'none'` | Content-Security-Policy value (`""` = omit). |
| `MEMOTURN_HSTS_ENABLED` | `false` | Send HSTS (only once TLS is in place end-to-end). |
| `MEMOTURN_HSTS_MAX_AGE` | `31536000` | HSTS max-age seconds. |
| `MEMOTURN_TLS_REQUIRED` | `false` | Reject plain-HTTP requests (`X-Forwarded-Proto` aware; `/health` exempt). |

## Rate limiting & quotas

| Variable | Default | Description |
| --- | --- | --- |
| `MEMOTURN_RATE_LIMIT_PER_MINUTE` | `0` | Per-tenant requests/minute (`0` = off). |
| `MEMOTURN_QUOTA_TURNS_PER_DAY` | `0` | Per-tenant turns/day (`0` = off). |
| `MEMOTURN_QUOTA_TOKENS_PER_DAY` | `0` | Per-tenant LLM-token budget/day, input+output+cache (`0` = off). |
| `MEMOTURN_REST_RATE_LIMIT_PER_MINUTE` | `0` | Per-principal limit on mutating REST routes (`0` = per-tenant value). |
| `MEMOTURN_REDIS_URL` | `""` | Redis-protocol URL (Valkey recommended) to enforce limits across replicas (`""` = in-process; needs the `redis` extra). |

## Scale-out

See [Scaling out](/scaling/).

| Variable | Default | Description |
| --- | --- | --- |
| `MEMOTURN_SCALEOUT_ENABLED` | `false` | Enable horizontal scale-out. |
| `MEMOTURN_REPLICA_ID` | hostname | Unique replica id. |
| `MEMOTURN_REPLICA_ADDRESS` | `http://{host}:{port}` | URL other replicas forward to. |
| `MEMOTURN_REPLICA_HEARTBEAT_SECONDS` | `5` | Heartbeat / lease-renewal cadence. |
| `MEMOTURN_REPLICA_STALE_SECONDS` | `15` | Membership staleness threshold. |
| `MEMOTURN_HASHRING_VNODES` | `100` | Virtual nodes per replica. |
| `MEMOTURN_LEASE_TTL_SECONDS` | `30` | Ownership lease TTL (`0` disables leases). |

## Runtime API keys (Enterprise Edition)

See [API keys](/api-keys/).

| Variable | Default | Description |
| --- | --- | --- |
| `MEMOTURN_API_KEY_REFRESH_SECONDS` | `30` | How often each replica refreshes its in-memory map of runtime-issued keys (revocation propagates within this window; immediate on the issuing replica). |

## OAuth token vault (Enterprise Edition)

See the [token vault](/enterprise/#oauth-token-vault). Needs `memoturn-enterprise` + the
`crypto` extra.

| Variable | Default | Description |
| --- | --- | --- |
| `MEMOTURN_OAUTH_VAULT_ENABLED` | `false` | Enable the vault (refuses to start without an encryption key). |
| `MEMOTURN_OAUTH_TOKEN_ENCRYPTION_KEY` | `""` | Fernet key for tokens at rest; falls back to `MEMOTURN_BLOB_ENCRYPTION_KEY`. |
| `MEMOTURN_OAUTH_PROVIDERS` | `[]` | JSON list: `{name, token_url, client_id?, client_secret?}` for refresh. |
| `MEMOTURN_OAUTH_REFRESH_BUFFER_SECONDS` | `300` | Refresh tokens this long before expiry. |

## Billing (Enterprise Edition)

See [Billing](/billing/). Needs `memoturn-enterprise` + the `billing` extra. The open-source core
ignores all of these.

| Variable | Default | Description |
| --- | --- | --- |
| `MEMOTURN_BILLING_ENABLED` | `false` | Persist + roll up usage, report to Stripe, and enforce per-tenant plan limits. |
| `MEMOTURN_BILLING_DSN` | `""` | Billing store DSN (`""` = SQLite under `DATA_DIR`; a `postgresql+asyncpg` DSN aggregates across replicas). |
| `STRIPE_API_KEY` | `""` | Stripe secret key (`""` = persist + roll up locally without reporting). |
| `STRIPE_WEBHOOK_SECRET` | `""` | Signing secret for the Stripe webhook endpoint. |
| `MEMOTURN_BILLING_REPORT_INTERVAL_SECONDS` | `60` | How often the reporter drains usage → rollups → Stripe meter events. |
| `MEMOTURN_BILLING_DEFAULT_PLAN` | `free` | Plan assigned to newly provisioned tenants. |
| `MEMOTURN_BILLING_PLAN_PRICES` | `{}` | Plan name → Stripe metered Price id (JSON; subscribes the tenant on provisioning). |
| `MEMOTURN_BILLING_RETENTION_DAYS` | `30` | Prune raw usage events older than this once rolled up (`0` = keep forever). |
| `MEMOTURN_BILLING_SELF_SIGNUP_ENABLED` | `false` | Allow unauthenticated self-serve signup via `POST /v1/billing/signup`. |
| `MEMOTURN_BILLING_PUBLIC_RATE_LIMIT_PER_MINUTE` | `10` | Per-IP cap on the public billing endpoints (`0` = off). |
| `MEMOTURN_BILLING_WEBHOOK_MAX_ATTEMPTS` | `8` | Webhook-inbox retries before an event is dead-lettered. |

## Audit (Enterprise Edition)

See [Security](/security/#audit-logging). The core always emits a logging audit sink; persistence
needs `memoturn-enterprise`.

| Variable | Default | Description |
| --- | --- | --- |
| `MEMOTURN_AUDIT_PERSIST_ENABLED` | `false` | Persist audit events to a queryable store behind `GET /v1/admin/audit`. |
| `MEMOTURN_AUDIT_DSN` | `""` | Audit store DSN (`""` = SQLite under `DATA_DIR`; or a `postgresql+asyncpg` DSN, falling back to `POSTGRES_DSN`). |
| `MEMOTURN_AUDIT_RETENTION_DAYS` | `90` | Delete persisted events older than this (`0` = keep forever). |
| `MEMOTURN_AUDIT_REPORT_INTERVAL_SECONDS` | `30` | How often the background drain persists buffered events. |

## Observability

See [Observability](/observability/). Needs the `otel` extra; the OTLP target is set via the
standard `OTEL_EXPORTER_OTLP_*` environment variables read by the SDK.

| Variable | Default | Description |
| --- | --- | --- |
| `MEMOTURN_OTEL_ENABLED` | `false` | Master switch for OpenTelemetry traces/metrics/logs. |
| `MEMOTURN_OTEL_SERVICE_NAME` | `memoturn` | Service name on spans/metrics. |
| `MEMOTURN_OTEL_SERVICE_VERSION` | `""` | `service.version` resource attr (`""` = package version). |
| `MEMOTURN_OTEL_DEPLOYMENT_ENVIRONMENT` | `""` | `deployment.environment` resource attr. |
| `MEMOTURN_OTEL_TRACES_ENABLED` | `true` | Gate traces (under the master switch). |
| `MEMOTURN_OTEL_METRICS_ENABLED` | `true` | Gate metrics. |
| `MEMOTURN_OTEL_LOGS_ENABLED` | `true` | Gate the audit-to-OTLP SIEM log export. |
| `MEMOTURN_METRICS_OTLP_PUSH_ENABLED` | `true` | Push metrics to the OTLP endpoint. |
| `MEMOTURN_METRICS_PROMETHEUS_ENABLED` | `false` | Mount a pull-based Prometheus `/metrics` endpoint. |
| `MEMOTURN_METRICS_AUTH_REQUIRED` | `false` | Require an admin principal to scrape `/metrics`. |
| `MEMOTURN_LOG_LEVEL` | `INFO` | Root log level. |
| `MEMOTURN_LOG_FORMAT` | `text` | Log format: `text` · `json` (adds `trace_id`/`span_id`). |

## Optional extras

Some backends require an optional dependency group installed with the package
(`pip install "memoturn[<extra>]"`): `postgres`, `storage` (S3/MinIO), `embeddings`
(sentence-transformers), `vector` (sqlite-vec), `crypto`, `browser` (Playwright), `redis`, `k8s`,
`mcp`, `a2a`, `bedrock`, `vertex`, `oidc`, and `otel`. The `enterprise` extra pulls in the
`memoturn-enterprise` distribution (SSO/SCIM/audit/billing) under the Enterprise Edition License —
see [Enterprise Edition](/enterprise/).
