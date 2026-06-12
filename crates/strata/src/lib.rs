//! `memoturn-strata`: the ground-up object-native typed storage engine
//! prototype (ADR-0011, docs/architecture/09).
//!
//! A database is a per-branch logical LSM whose immutable sorted runs in
//! object storage *are* the database: typed operations stage into puts/deletes
//! on one ordered keyspace, commit as group-commit log records, ship as WAL
//! chunks, and fold into MVCC segments referenced by a CAS-fenced manifest.
//! Branching, rewind, PITR, GC, and verifiable erasure are manifest and
//! compaction operations — there is no capture/ship layer and no SQL.
//!
//! Standalone by design: nothing here links `memoturn-engine` or
//! `memoturn-replication`; proven logic (manifest CAS shape, refcount GC,
//! RRF fusion, filter grammar) is ported in with its tests.

pub mod codec {
    pub mod key;
    pub mod record;
}

mod core {
    pub mod compact;
    pub mod logrec;
    pub mod manifest;
    pub mod memtable;
    pub mod ops;
    pub mod segment;
    pub mod store;
    pub mod view;
    pub mod wal;
}

pub mod surface {
    pub mod docfilter;
    pub mod docs;
    pub mod fts;
    pub mod kv;
    pub mod memory;
    pub mod transcript;
    pub mod vector;
}

pub mod fuse;

pub use core::manifest::{Manifest, ParentRef, SegmentRef};
pub use core::ops::{Durability, WriteOutput, WriteRequest};
pub use core::store::{Db, ErasureEvidence, PruneBeforeOutcome, Replica, Store};
pub use surface::memory::{IngestOutcome, MemoryInput, MemoryRules, MemoryType, RecallQuery};

pub type Txid = u64;
pub type Key = Vec<u8>;

/// A staged low-level operation on the keyspace. `RangeDel` is expanded at
/// staging time in the prototype (the production design journals it as a
/// range tombstone — see 09 § transcripts).
#[derive(Debug, Clone, PartialEq)]
pub enum Op {
    Put { key: Key, value: Vec<u8> },
    Del { key: Key },
}

impl Op {
    pub fn key(&self) -> &[u8] {
        match self {
            Op::Put { key, .. } | Op::Del { key } => key,
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum StrataError {
    #[error("invalid input: {0}")]
    Invalid(String),
    #[error("corrupt data: {0}")]
    Corrupt(String),
    #[error("branch not found: {0}")]
    BranchNotFound(String),
    #[error("manifest CAS conflict")]
    CasConflict,
    #[error("writer fenced: manifest epoch {manifest_epoch} > writer epoch {writer_epoch}")]
    ZombieFenced {
        manifest_epoch: u64,
        writer_epoch: u64,
    },
    #[error("erasure blocked by checkpoints: {0:?}")]
    ErasureBlocked(Vec<String>),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("object store error: {0}")]
    ObjectStore(#[from] object_store::Error),
}

pub type Result<T> = std::result::Result<T, StrataError>;

pub(crate) fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
