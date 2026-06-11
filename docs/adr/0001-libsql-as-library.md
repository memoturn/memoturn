# ADR-0001: Embed libSQL as a library (not sqld, not the Turso rewrite)

**Status:** accepted · 2026-06

**Decision:** the data-plane node embeds **libSQL** (the C fork of SQLite) as a library behind an
internal `SqlEngine` trait. We do not run sqld, and we do not build on the Turso Rust rewrite yet.

**Context:** we need a battle-tested SQL core plus virtual-WAL hooks and native vector indexing,
with full ownership of the connection pool, cache, and VFS/WAL boundary — our differentiators
(tiering, manifests, KV fast path) live *around* the engine.

**Alternatives rejected:**
- *Vanilla SQLite*: no virtual WAL API, no native vectors — too little leverage.
- *sqld* (libSQL server): maintenance mode; its process model blocks multi-tenant density.
- *Turso Rust rewrite*: explicitly beta as of mid-2026 — too risky as the foundation of a
  commercial DBaaS holding customer data.

**Consequences:** we own more machinery (pooling, replication capture). The `SqlEngine` trait is
the hedge: the Turso rewrite shares the SQLite file format, so it can be swapped in per-database
when it stabilizes, with no storage migration. Prototype note: where the bundled libSQL build
lacks a feature (e.g., vector SQL functions), the adapter must degrade gracefully and the gap is
recorded here.
