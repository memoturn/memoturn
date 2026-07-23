# Architecture Decision Records

Short, durable records of significant architecture decisions — the context, the choice, and
the consequences — so the reasoning survives past the conversation that produced it.

Each ADR is immutable once accepted; supersede it with a new one rather than editing history.

| # | Title | Status |
|---|-------|--------|
| [0001](0001-storage-roles-and-mutable-state.md) | Storage roles: Doris as analytical mirror, Postgres authoritative for mutable state | Accepted (implementation trigger-gated) |
| [0002](0002-postgres-telemetry-tier.md) | A Postgres telemetry tier for small installs, Doris for scale | Accepted, implemented (#178–#181) |
| [0003](0003-edge-deployment-profile.md) | An edge deployment profile (serverless runtimes, Cloudflare Workers reference target) | Proposed (trigger-gated, depends on 0002 — now met) |
| [0004](0004-telemetry-graduation-path.md) | Telemetry graduation path: migrating an install from Postgres to Doris | Accepted, partially implemented (scanRows shipped; CLI open) |
| [0005](0005-managed-cloud-architecture.md) | Managed cloud: multi-tenant architecture on the self-host codebase | Proposed (trigger-gated, depends on 0002/0003) |
