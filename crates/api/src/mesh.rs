//! Replica push stream: live segment fan-out between nodes.
//!
//! Owner side: nodes register as subscribers for a branch; every ship's
//! payload (segment or snapshot) is POSTed to them best-effort. Replica
//! side: lazy subscription on first read of a branch this node doesn't own,
//! and an ingest path that applies pushed state to the local copy via
//! atomic file replacement (in-flight readers finish on the old inode).
//!
//! Push is strictly an optimization: ordering is guarded by the txid chain
//! and any gap falls back to object-storage restore. These endpoints are
//! node-internal — production isolates them with NetworkPolicy/mTLS.

use memoturn_replication::{SegmentSink, ShipPayload};
use std::collections::{HashMap, HashSet};
use tokio::sync::Mutex;

pub struct Mesh {
    client: reqwest::Client,
    /// Owner side: branch key `uuid@branch` → subscriber base URLs.
    subscribers: Mutex<HashMap<String, HashSet<String>>>,
    /// Replica side: branch keys this node already subscribed to. Keyed by
    /// key only — an owner change is not re-subscribed automatically; the
    /// replica still converges via object storage + min_txid until then.
    subscribed: Mutex<HashSet<String>>,
    /// Serializes ingest applies (per-node; per-key would be finer).
    pub ingest_lock: Mutex<()>,
}

impl Mesh {
    pub fn new(client: reqwest::Client) -> Self {
        Self {
            client,
            subscribers: Mutex::new(HashMap::new()),
            subscribed: Mutex::new(HashSet::new()),
            ingest_lock: Mutex::new(()),
        }
    }

    /// Owner side: register a replica for live pushes.
    pub async fn add_subscriber(&self, key: &str, addr: &str) {
        self.subscribers
            .lock()
            .await
            .entry(key.to_string())
            .or_default()
            .insert(addr.trim_end_matches('/').to_string());
    }

    async fn remove_subscriber(&self, key: &str, addr: &str) {
        if let Some(set) = self.subscribers.lock().await.get_mut(key) {
            set.remove(addr);
        }
    }

    /// Replica side: claim first-subscription for a key. Returns false if
    /// already subscribed (or being subscribed).
    pub async fn claim_subscription(&self, key: &str) -> bool {
        self.subscribed.lock().await.insert(key.to_string())
    }

    /// Replica side: release the claim (subscribe attempt failed; retry on a
    /// later read).
    pub async fn release_subscription(&self, key: &str) {
        self.subscribed.lock().await.remove(key);
    }
}

#[async_trait::async_trait]
impl SegmentSink for Mesh {
    async fn publish(&self, uuid: &str, branch: &str, payload: &ShipPayload) {
        let key = format!("{uuid}@{branch}");
        let subs: Vec<String> = match self.subscribers.lock().await.get(&key) {
            Some(s) if !s.is_empty() => s.iter().cloned().collect(),
            _ => return,
        };
        let (kind, bytes) = match payload {
            ShipPayload::Segment { bytes, .. } => ("segment", bytes.clone()),
            ShipPayload::Snapshot { bytes, .. } => ("snapshot", bytes.clone()),
        };
        for addr in subs {
            let req = self
                .client
                .post(format!("{addr}/internal/replica/ingest"))
                .header("Memoturn-Db-Uuid", uuid)
                .header("Memoturn-Branch", branch)
                .header("Memoturn-Kind", kind)
                .body(bytes.clone());
            match req.send().await {
                Ok(resp) if resp.status().is_success() => {}
                outcome => {
                    tracing::debug!(%addr, %key, ?outcome, "dropping replica subscriber");
                    self.remove_subscriber(&key, &addr).await;
                }
            }
        }
    }
}
