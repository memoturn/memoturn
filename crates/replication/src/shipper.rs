use crate::{Replicator, Result, SegmentSink};
use memoturn_engine::{DbHandle, NodeEngine};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::Mutex;

/// Dirty-tracking + background shipping: the Standard-durability path
/// ("segments shipped within ~1 s", docs/architecture/01). Write handlers
/// mark a branch dirty (with the writer's ownership epoch) after each txid
/// bump; the loop ships dirty branches under that epoch — page-delta
/// segments in steady state, full snapshots for branch bases, compaction,
/// or capture-cursor recovery (Replicator::ship). A node that lost ownership
/// gets fenced at the manifest, never corrupting the new owner.
pub struct Shipper {
    replicator: Arc<Replicator>,
    node: Arc<NodeEngine>,
    /// Live fan-out to replica subscribers (push is best-effort; object
    /// storage remains the convergence path).
    sink: Option<Arc<dyn SegmentSink>>,
    /// key `uuid@branch` → (uuid, branch, handle, writer epoch)
    dirty: Mutex<HashMap<String, (String, String, Arc<DbHandle>, u64)>>,
}

impl Shipper {
    pub fn new(
        replicator: Arc<Replicator>,
        node: Arc<NodeEngine>,
        sink: Option<Arc<dyn SegmentSink>>,
    ) -> Self {
        Self {
            replicator,
            node,
            sink,
            dirty: Mutex::new(HashMap::new()),
        }
    }

    async fn ship_and_publish(
        &self,
        handle: &memoturn_engine::DbHandle,
        uuid: &str,
        branch: &str,
        epoch: u64,
    ) -> Result<()> {
        let outcome = self
            .replicator
            .ship_outcome(handle, uuid, branch, epoch)
            .await?;
        if let (Some(sink), Some(payload)) = (&self.sink, &outcome.payload) {
            sink.publish(uuid, branch, payload).await;
        }
        Ok(())
    }

    pub async fn mark_dirty(&self, uuid: &str, branch: &str, handle: Arc<DbHandle>, epoch: u64) {
        self.dirty.lock().await.insert(
            format!("{uuid}@{branch}"),
            (uuid.to_string(), branch.to_string(), handle, epoch),
        );
    }

    /// Ship everything currently dirty. Returns the number shipped.
    pub async fn flush(&self) -> Result<usize> {
        let drained: Vec<_> = {
            let mut d = self.dirty.lock().await;
            d.drain().map(|(_, v)| v).collect()
        };
        let mut shipped = 0;
        for (uuid, branch, handle, epoch) in drained {
            self.ship_and_publish(&handle, &uuid, &branch, epoch)
                .await?;
            shipped += 1;
        }
        Ok(shipped)
    }

    /// Ship one branch immediately (sync endpoint / branch ops).
    pub async fn flush_one(
        &self,
        uuid: &str,
        branch: &str,
        handle: &DbHandle,
        epoch: u64,
    ) -> Result<()> {
        self.dirty.lock().await.remove(&format!("{uuid}@{branch}"));
        self.ship_and_publish(handle, uuid, branch, epoch).await?;
        Ok(())
    }

    /// Background loop: ship dirty branches every `interval`.
    pub fn spawn(self: Arc<Self>, interval: Duration) -> tokio::task::JoinHandle<()> {
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(interval).await;
                if let Err(e) = self.flush().await {
                    tracing::warn!(error = %e, "segment shipping failed; will retry");
                }
            }
        })
    }

    pub fn node(&self) -> &Arc<NodeEngine> {
        &self.node
    }
}
