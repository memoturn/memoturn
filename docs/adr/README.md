# Architecture Decision Records

Short, durable records of significant architecture decisions — the context, the choice, and
the consequences — so the reasoning survives past the conversation that produced it.

Each ADR is immutable once accepted; supersede it with a new one rather than editing history.

| # | Title | Status |
|---|-------|--------|
| [0001](0001-storage-roles-and-mutable-state.md) | Storage roles: Doris as analytical mirror, Postgres authoritative for mutable state | Accepted (implementation trigger-gated) |
| [0002](0002-postgres-telemetry-tier.md) | A Postgres telemetry tier for small installs, Doris for scale | Proposed (implementation trigger-gated) |
