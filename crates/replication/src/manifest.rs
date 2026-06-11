use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// One immutable snapshot of a database at a transaction boundary.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SnapshotRef {
    pub txid: u64,
    /// Object key relative to the replicator root (shared across branches).
    pub key: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ParentRef {
    pub branch: String,
    pub fork_txid: u64,
}

/// The branch manifest — the unit of copy-on-write (ADR-0004). A fork is a
/// new manifest referencing the parent's chain; rewind moves the head; every
/// update carries the writer's epoch for fencing.
///
/// Branch state = latest snapshot ≤ head + the contiguous segment chain
/// above it (ADR-0003). Restore granularity is segment boundaries; every
/// shipped txid is a boundary.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Manifest {
    pub branch: String,
    pub parent: Option<ParentRef>,
    pub epoch: u64,
    pub head_txid: u64,
    /// Full snapshots (base + periodic compactions), txid ascending.
    pub snapshots: Vec<SnapshotRef>,
    /// Page-delta segments, txid ascending and contiguous
    /// (`seg[i].min_txid == seg[i-1].max_txid`).
    #[serde(default)]
    pub segments: Vec<crate::segment::SegmentRef>,
    /// Named checkpoints: name → txid (always a shipped boundary).
    #[serde(default)]
    pub checkpoints: BTreeMap<String, u64>,
    /// Burner branches: unix-ms expiry for GC.
    #[serde(default)]
    pub ttl_at: Option<i64>,
}

impl Manifest {
    pub fn new(branch: &str) -> Self {
        Self {
            branch: branch.to_string(),
            parent: None,
            epoch: 1,
            head_txid: 0,
            snapshots: Vec::new(),
            segments: Vec::new(),
            checkpoints: BTreeMap::new(),
            ttl_at: None,
        }
    }

    pub fn head_snapshot(&self) -> Option<&SnapshotRef> {
        self.snapshots.last()
    }

    /// Latest snapshot at or before `txid` (rewind/PITR resolution).
    pub fn snapshot_at(&self, txid: u64) -> Option<&SnapshotRef> {
        self.snapshots.iter().rev().find(|s| s.txid <= txid)
    }

    /// Segments since the last snapshot — the chain a head restore replays,
    /// and the compaction trigger.
    pub fn chain_len(&self) -> usize {
        let base = self.head_snapshot().map(|s| s.txid).unwrap_or(0);
        self.segments.iter().filter(|s| s.max_txid > base).count()
    }

    /// Is `txid` a restorable point (snapshot or segment boundary)?
    pub fn is_boundary(&self, txid: u64) -> bool {
        self.snapshots.iter().any(|s| s.txid == txid)
            || self.segments.iter().any(|s| s.max_txid == txid)
    }
}
