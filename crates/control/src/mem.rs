use crate::{ControlError, LeaseManager, NodeIdentity, Owner, Ownership, Result};
use async_trait::async_trait;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

#[derive(Default)]
struct TableInner {
    owners: HashMap<String, Ownership>,
    /// Epochs are monotonic per database and survive ownership loss.
    epochs: HashMap<String, u64>,
    /// Canonical name→uuid mapping; the shared-table analogue of the etcd
    /// catalog, so concurrent first-ingests agree on one uuid.
    uuids: HashMap<String, String>,
    /// name→deletion-time (unix-ms), monotonic; the token revocation list.
    tombstones: HashMap<String, i64>,
}

/// Shared lease table: one per "cluster" (process). Clone freely.
#[derive(Clone, Default)]
pub struct MemLeaseTable(Arc<Mutex<TableInner>>);

impl MemLeaseTable {
    pub fn new() -> Self {
        Self::default()
    }
}

pub struct MemLeases {
    table: MemLeaseTable,
    identity: NodeIdentity,
}

impl MemLeases {
    pub fn new(table: MemLeaseTable, identity: NodeIdentity) -> Self {
        Self { table, identity }
    }

    /// Single-node convenience: private table, fixed identity.
    pub fn standalone(addr: &str) -> Self {
        Self::new(
            MemLeaseTable::new(),
            NodeIdentity {
                node_id: "node-0".into(),
                addr: addr.to_string(),
            },
        )
    }
}

#[async_trait]
impl LeaseManager for MemLeases {
    fn identity(&self) -> &NodeIdentity {
        &self.identity
    }

    async fn lookup(&self, key: &str) -> Result<Option<Ownership>> {
        let inner = self
            .table
            .0
            .lock()
            .map_err(|e| ControlError::Corrupt(e.to_string()))?;
        Ok(inner.owners.get(key).cloned())
    }

    async fn resolve_owner(&self, key: &str) -> Result<Owner> {
        let mut inner = self
            .table
            .0
            .lock()
            .map_err(|e| ControlError::Corrupt(e.to_string()))?;
        if let Some(o) = inner.owners.get(key) {
            return Ok(if o.node_id == self.identity.node_id {
                Owner::Local {
                    epoch: o.epoch,
                    acquired: false,
                }
            } else {
                Owner::Remote(o.clone())
            });
        }
        let epoch = inner.epochs.get(key).copied().unwrap_or(0) + 1;
        inner.epochs.insert(key.to_string(), epoch);
        inner.owners.insert(
            key.to_string(),
            Ownership {
                node_id: self.identity.node_id.clone(),
                addr: self.identity.addr.clone(),
                epoch,
            },
        );
        Ok(Owner::Local {
            epoch,
            acquired: true,
        })
    }

    async fn resolve_uuid(&self, key: &str, proposed: &str) -> Result<String> {
        let mut inner = self
            .table
            .0
            .lock()
            .map_err(|e| ControlError::Corrupt(e.to_string()))?;
        Ok(inner
            .uuids
            .entry(key.to_string())
            .or_insert_with(|| proposed.to_string())
            .clone())
    }

    async fn tombstone(&self, key: &str, at_ms: i64) -> Result<()> {
        let mut inner = self
            .table
            .0
            .lock()
            .map_err(|e| ControlError::Corrupt(e.to_string()))?;
        let e = inner.tombstones.entry(key.to_string()).or_insert(at_ms);
        *e = (*e).max(at_ms);
        Ok(())
    }

    async fn deleted_at(&self, key: &str) -> Result<Option<i64>> {
        let inner = self
            .table
            .0
            .lock()
            .map_err(|e| ControlError::Corrupt(e.to_string()))?;
        Ok(inner.tombstones.get(key).copied())
    }

    async fn release(&self, key: &str) -> Result<()> {
        let mut inner = self
            .table
            .0
            .lock()
            .map_err(|e| ControlError::Corrupt(e.to_string()))?;
        if inner
            .owners
            .get(key)
            .map(|o| o.node_id == self.identity.node_id)
            == Some(true)
        {
            inner.owners.remove(key);
        }
        Ok(())
    }

    async fn release_all(&self) -> Result<()> {
        let mut inner = self
            .table
            .0
            .lock()
            .map_err(|e| ControlError::Corrupt(e.to_string()))?;
        inner
            .owners
            .retain(|_, o| o.node_id != self.identity.node_id);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn node(table: &MemLeaseTable, id: &str) -> MemLeases {
        MemLeases::new(
            table.clone(),
            NodeIdentity {
                node_id: id.into(),
                addr: format!("http://{id}"),
            },
        )
    }

    #[tokio::test]
    async fn resolve_uuid_converges_across_nodes() {
        // Two nodes sharing one cluster table — the multi-node harness shape.
        let table = MemLeaseTable::new();
        let a = node(&table, "a");
        let b = node(&table, "b");

        // Each node proposes its own uuid for the same profile; both must agree.
        let ua = a.resolve_uuid("acme--alice", "uuid-from-a").await.unwrap();
        let ub = b.resolve_uuid("acme--alice", "uuid-from-b").await.unwrap();
        assert_eq!(ua, ub, "concurrent first-ingest must converge on one uuid");
        assert_eq!(ua, "uuid-from-a", "the first writer wins");

        // A different profile gets its own uuid.
        let uc = a.resolve_uuid("acme--bob", "uuid-c").await.unwrap();
        assert_ne!(uc, ua);
    }

    #[tokio::test]
    async fn tombstone_is_monotonic_and_visible_across_nodes() {
        let table = MemLeaseTable::new();
        let a = node(&table, "a");
        let b = node(&table, "b");

        assert_eq!(a.deleted_at("acme--alice").await.unwrap(), None);
        a.tombstone("acme--alice", 1000).await.unwrap();
        // Visible from another node sharing the cluster table.
        assert_eq!(b.deleted_at("acme--alice").await.unwrap(), Some(1000));
        // Only moves forward — an older delete time never weakens the watermark.
        b.tombstone("acme--alice", 500).await.unwrap();
        assert_eq!(a.deleted_at("acme--alice").await.unwrap(), Some(1000));
        a.tombstone("acme--alice", 2000).await.unwrap();
        assert_eq!(a.deleted_at("acme--alice").await.unwrap(), Some(2000));
    }
}
