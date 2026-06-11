//! Single-writer ownership (docs/architecture/03): per-database writer leases
//! with monotonic epochs. Two implementations behind one trait:
//!
//! - [`MemLeases`]: in-process shared table — the single-node default and the
//!   multi-node test harness.
//! - [`EtcdLeases`]: production path — one etcd lease per *node* (databases
//!   attach to the node session), epoch counters that outlive leases, lazy
//!   ownership on first write.
//!
//! Leases make split-brain unlikely; epoch-fenced manifest CAS in the
//! replication layer makes it harmless (ADR-0004/0005).

mod etcd;
mod mem;

pub use etcd::EtcdLeases;
pub use mem::{MemLeaseTable, MemLeases};

use async_trait::async_trait;

#[derive(Debug, thiserror::Error)]
pub enum ControlError {
    #[error("etcd error: {0}")]
    Etcd(String),
    #[error("lease state corrupt: {0}")]
    Corrupt(String),
}

pub type Result<T> = std::result::Result<T, ControlError>;

#[derive(Debug, Clone)]
pub struct NodeIdentity {
    pub node_id: String,
    /// Advertised base URL other nodes use to forward requests, e.g.
    /// `http://10.0.3.7:8080`.
    pub addr: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct Ownership {
    pub node_id: String,
    pub addr: String,
    pub epoch: u64,
}

/// Outcome of a write-path ownership resolution.
#[derive(Debug, Clone)]
pub enum Owner {
    /// This node owns the database; `acquired` is true when ownership was
    /// taken just now (caller must reconcile local state with object storage
    /// before serving writes).
    Local {
        epoch: u64,
        acquired: bool,
    },
    Remote(Ownership),
}

#[async_trait]
pub trait LeaseManager: Send + Sync {
    fn identity(&self) -> &NodeIdentity;
    async fn lookup(&self, key: &str) -> Result<Option<Ownership>>;
    /// Resolve ownership for a write: return the current owner, lazily
    /// acquiring (epoch+1) when the database is unowned.
    async fn resolve_owner(&self, key: &str) -> Result<Owner>;
    /// Resolve the canonical uuid for database `key`, atomically creating the
    /// mapping with `proposed` when the shared catalog has none. Concurrent
    /// first-ingests to the same memory profile across nodes therefore converge
    /// on a single uuid instead of each node minting a divergent one (which
    /// would split the profile's storage — ADR-0009). Returns the agreed uuid.
    async fn resolve_uuid(&self, key: &str, proposed: &str) -> Result<String>;
    /// Drop the canonical name→uuid mapping for `key` (database deletion).
    /// Without this a re-created database of the same name would resolve to
    /// the deleted uuid — whose object-storage prefix is gone — and a node
    /// that re-created it locally would diverge from the catalog.
    async fn forget_uuid(&self, key: &str) -> Result<()>;
    /// Record that database `key` was deleted at `at_ms` (unix-ms). The
    /// recorded time only moves forward. This is the revocation list for
    /// stateless tokens: a write token minted before this time must not be
    /// allowed to resurrect or mutate the (re-created) database.
    async fn tombstone(&self, key: &str, at_ms: i64) -> Result<()>;
    /// The most recent deletion time for `key` (unix-ms), or None if never
    /// deleted. The auth layer rejects tokens whose `iat` precedes it.
    async fn deleted_at(&self, key: &str) -> Result<Option<i64>>;
    async fn release(&self, key: &str) -> Result<()>;
    /// Drop every lease this node holds (shutdown / simulated node death).
    async fn release_all(&self) -> Result<()>;
}
