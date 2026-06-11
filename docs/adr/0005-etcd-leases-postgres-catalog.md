# ADR-0005: etcd for writer leases; Postgres for the catalog

**Status:** accepted · 2026-06

**Decision:** single-writer ownership lives in **etcd** — one lease per *node* (databases attach
to their owner node's session, keeping etcd load flat at millions of DBs), epoch counter per
database, lazy ownership for cold DBs. Correctness does not rest on etcd alone: every manifest
update is an epoch-carrying CAS against object storage, so zombie writers are harmless
(ADR-0004). The tenant/database/branch/token/usage **catalog is Postgres** — transactional,
boring, managed flavors on every cloud, CloudNativePG for self-hosted.

**Alternatives rejected:**
- *Consensus per database (Raft groups)*: massive overkill for single-writer tiny DBs.
- *Leases in Postgres*: no session/TTL primitives or watch; etcd is K8s-native and proven.
- *Catalog in etcd*: wrong shape for relational catalog queries and billing joins.
- *Dogfooding Memoturn as its own catalog*: attractive later; circular-dependency risk at v1.

**Update (2026-06):** the lease layer now also drives **token revocation via deletion
tombstones**: deleting a database records a monotonic tombstone (etcd `/memoturn/tombstone/` key,
or the in-process lease table), and the auth middleware rejects write-scoped tokens whose `iat`
predates it — a stale token cannot resurrect a re-created database of the same name. A
control-lookup failure falls open, since a partitioned control plane already blocks the lease the
write needs. The in-process fallback is also guarded: without `MEMOTURN_ETCD`, a node that looks
multi-node (auth on, or a non-loopback advertise) refuses to start unless `MEMOTURN_SINGLE_NODE=1`.
