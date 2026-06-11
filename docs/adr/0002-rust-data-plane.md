# ADR-0002: Rust for the data plane

**Status:** accepted · 2026-06

**Decision:** `memoturnd`, the gateway, and all data-path code are Rust.

**Why:** (1) deterministic memory with no GC pauses at millions-of-resident-objects density — the
per-node memory budget must be exact for K8s limits; (2) libSQL is Rust-first beyond the C core,
and the future engine swap (ADR-0001) is Rust-native; (3) the load-bearing ecosystem is Rust:
`tokio`, `tonic`, `moka`, `foyer`, and `object_store` (one API over S3/GCS/Azure/MinIO including
the conditional writes that fencing requires).

**Rejected:** Go — faster iteration, but GC pressure and less precise memory accounting at target
density; the Litestream-as-library advantage doesn't outweigh it.
