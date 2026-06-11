# 03 — Control Plane, Routing, Multi-Region

## Components

| Component | Role | Backing store |
| --- | --- | --- |
| `memoturn-api` | control-plane REST: tenants, databases, branches, tokens, usage | **Postgres** (catalog) |
| `memoturn-gateway` | stateless data-path router; placement cache; auth verification | none (cache only) |
| **etcd** (3–5 nodes) | writer leases, node membership, placement map | itself |
| `memoturnd` fleet | data plane ([01](01-storage-engine.md)) | local NVMe cache + object storage |
| Assistant service | built-in AI assistant + memory extraction ([06](06-mcp-and-assistant.md)) | none |
| metering | usage events (storage-bytes, rows-read/written, segment-PUTs) | Postgres (v1) |

Postgres for the catalog ([ADR-0005](../adr/0005-etcd-leases-postgres-catalog.md)): boring,
transactional, every cloud has a managed flavor, and the chart can ship CloudNativePG for
self-hosted. Dogfooding Memoturn as its own catalog is a post-v1 trick, not a v1 risk.

## Single-writer leases

- **One etcd lease per node**, not per database — owned DBs attach to their owner node's session,
  so etcd *lease churn* stays flat regardless of database count. Attachment keys exist only for
  the active set, and each cell caps its active set (etcd comfortably holds a few million small
  keys); beyond that you add cells, never grow etcd.
- Lease record: `{db_id → node_id, epoch, ttl≈10 s}`, maintained by node heartbeat.
- **Lazy ownership:** cold databases are unowned. First write → gateway finds no owner →
  placement picks a node (locality, load) → node acquires at `epoch+1`, wakes the DB, serves.
- **Failover:** owner dies → node lease expires (≤10 s) → all its attachments release → next
  write (or a watchdog, for premium DBs) triggers re-acquisition at `epoch+1` → new owner restores
  from object storage and CAS-bumps the manifest epoch. Zombies are fenced
  ([02](02-branching.md#epoch-fencing-why-zombies-are-harmless)).
- **No etcd, no fleet:** a node started without `MEMOTURN_ETCD` falls back to an in-process lease
  table, which cannot fence across nodes — so it refuses to start when it looks multi-node (auth
  on, or a non-loopback `MEMOTURN_ADVERTISE`) unless `MEMOTURN_SINGLE_NODE=1` asserts that it
  really is alone. Misconfiguration fails at boot, not as split-brain in production.

## Routing

- Gateways hold a **placement cache** fed by an etcd watch over the *active* (owned) set only —
  cold databases are unowned and have no entry anywhere except the catalog and object storage.
  This is what makes billions of total agents cheap: every per-request data structure scales with
  concurrently-active databases (≈0.1–1 % of the population), never with the total.
- Request for `db@branch` → cache lookup → forward to owner (writes) or nearest replica (reads
  with `consistency: cached`).
- **Epoch-mismatch retry:** nodes reject requests carrying a stale epoch; the gateway refreshes
  that entry and retries once. Routing adds ≤1 ms in-region (cache hit ~µs).
- Writes arriving at any node are **forwarded over multiplexed gRPC** to the owner — clients never
  need to know placement.

## Multi-region / multi-cloud topology

- **Regions are independent cells**: each has its own etcd, gateways, data plane, and regional
  object-storage bucket. A cell failure never cascades.
- The **global control plane** (catalog, auth, assistant, dashboard) runs in one home region with
  read replicas; it is on the provisioning path (rare) not the data path (hot), so global
  round-trips never tax queries.
- A database's **primary region is chosen at creation** (data residency for enterprise — the cell
  model maps directly onto "EU data stays in the EU cluster").
- Cross-region database replication = bucket cross-region replication + remote read replicas —
  **post-v1** ([ADR deferred list](../adr/0008-deployment-not-statefulset.md)).
- Multi-cloud falls out of the cell model: a cell is "a Kubernetes cluster + an object-storage
  bucket + an etcd," whether that's EKS+S3, GKE+GCS, AKS+Blob, or self-hosted+MinIO.

## Security & tenancy

- **Per-database JWTs** (Ed25519, scoped `read`/`write`/`admin`, short-lived; minted by the
  control plane). Gateways verify statelessly with the public key.
- Platform API keys for control-plane operations. All credential comparisons are constant-time.
- **Fail-closed key handling:** `MEMOTURN_AUTH=on` refuses to boot without `MEMOTURN_PLATFORM_KEY`
  *and* a signing-key source — `MEMOTURN_AUTH_KEY` (base64 PKCS8 Ed25519, from a mounted secret)
  or opt-in `MEMOTURN_PERSIST_AUTH_KEY=1`, which persists a generated key to object storage
  (unencrypted; the secret is preferred in production). The node-internal `MEMOTURN_CLUSTER_KEY`
  must differ from the platform key; left unset, it is derived from the signing key, so a fleet
  sharing the signing key agrees on it without an extra secret.
- **Deletion tombstones revoke stale tokens:** deleting a database/profile records a deletion
  tombstone in the control plane (monotonic etcd key, or the in-process table). The auth
  middleware rejects write-scoped tokens whose `iat` predates the tombstone — `403 token revoked:
  it predates this database's deletion; mint a fresh token` — *before* any handler can
  auto-create, so a stale write token can never resurrect or mutate a re-created database of the
  same name. Reads are unaffected, and a control-lookup failure falls open: a partitioned control
  plane already blocks the lease the write needs.
- Tenant isolation: separate database files per tenant DB (the strongest cheap isolation there
  is) + per-tenant object-store prefixes; per-tenant encryption keys wrapped by cloud KMS
  (post-prototype) for enterprise.

## Failure modes

| Failure | Behavior | Recovery |
| --- | --- | --- |
| data-plane node loss | its DBs' leases expire ≤10 s; writes resume on new owners after restore | automatic, ≤15 s; RPO per durability mode |
| etcd quorum loss | **writes pause** (no new leases/failovers); existing owners keep serving until lease TTL, reads continue | restore quorum; no data loss (object storage untouched) |
| object-storage outage | Standard-mode writes continue (local WAL) with shipping backlog; Durable-mode writes fail closed; cold wakes fail | backlog drains on recovery |
| zone loss | cell keeps serving (nodes/gateways spread across zones; etcd 3×zones) | reschedule pods |
| region loss | cell down; databases recoverable in another cell from bucket CRR (post-v1) | DR runbook |
