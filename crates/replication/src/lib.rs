//! Replication & branching: object storage is the source of truth.
//!
//! v0 staging per ADR-0003: segments are whole-database snapshots (correct and
//! fast for the ≤16 MB agent-DB target); page-level LTX segments slot in behind
//! the same manifest/restore semantics later. Branch/checkpoint/rewind are
//! manifest operations per ADR-0004.
//!
//! Object layout:
//! ```text
//! {root}/{db_uuid}/branches/{branch}/manifest.json
//! {root}/{db_uuid}/snapshots/{txid}-{nonce}.db     (shared across branches)
//! ```

mod manifest;
mod replicator;
pub mod segment;
mod shipper;

pub use manifest::{Manifest, ParentRef, SnapshotRef};
pub use replicator::{Replicator, ShipOutcome, ShipPayload};
pub use segment::SegmentRef;
pub use shipper::Shipper;

/// Receives shipped state for live fan-out to replicas. Push is an
/// optimization layered over object storage — replicas always converge via
/// restore even if every publish is lost.
#[async_trait::async_trait]
pub trait SegmentSink: Send + Sync {
    async fn publish(&self, uuid: &str, branch: &str, payload: &ShipPayload);
}

#[derive(Debug, thiserror::Error)]
pub enum ReplicationError {
    #[error("object store error: {0}")]
    Store(#[from] object_store::Error),
    #[error("engine error: {0}")]
    Engine(#[from] memoturn_engine::EngineError),
    #[error("branch not found: {0}")]
    BranchNotFound(String),
    #[error("no snapshot at or before txid {0}")]
    NoSnapshot(u64),
    #[error("manifest corrupt: {0}")]
    Corrupt(String),
    #[error("write fenced: manifest is at epoch {manifest_epoch}, writer holds epoch {writer_epoch}")]
    ZombieFenced { manifest_epoch: u64, writer_epoch: u64 },
    #[error("manifest CAS conflict (concurrent writer)")]
    CasConflict,
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
}

pub type Result<T> = std::result::Result<T, ReplicationError>;
