//! Manifest v2 — the engine's native catalog (docs/architecture/09), an
//! evolution of the replication crate's manifest: `snapshots[]` is gone
//! (a "snapshot" is just a full-coverage Lmax run), segments are MVCC runs
//! with keyspace ranges, and the WAL tail above `wal_floor_seq` completes
//! the catalog. CAS + epoch fencing port unchanged from ADR-0004.

use crate::{Result, StrataError, Txid};
use bytes::Bytes;
use object_store::path::Path as ObjPath;
use object_store::{ObjectStore, PutPayload};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::sync::Arc;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ParentRef {
    pub branch: String,
    pub fork_txid: Txid,
}

/// One immutable MVCC run. Runs may overlap in keyspace; entry txids decide
/// visibility. `level` 0 = flush output, 1 = merged, 2 = full-coverage (Lmax).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SegmentRef {
    pub min_txid: Txid,
    pub max_txid: Txid,
    /// Object key relative to the store root (shared across branches).
    pub key: String,
    pub level: u8,
    pub key_min: Vec<u8>,
    pub key_max: Vec<u8>,
    pub entry_count: u64,
    pub bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Manifest {
    pub format: u32,
    pub branch: String,
    pub parent: Option<ParentRef>,
    /// Writer-ownership epoch; every update is fenced against it.
    pub epoch: u64,
    pub head_txid: Txid,
    /// WAL chunks with seq ≤ this are absorbed into segments (GC-deletable);
    /// chunks above it are the live tail that completes the catalog.
    pub wal_floor_seq: u64,
    /// Live runs: the union covers all live versions.
    #[serde(default)]
    pub segments: Vec<SegmentRef>,
    /// Snapshot-grained PITR tier: full-coverage runs replaced by compaction,
    /// retained as coarse restore points until the snapshot window lapses.
    #[serde(default)]
    pub retained: Vec<SegmentRef>,
    /// Named checkpoints: name → txid.
    #[serde(default)]
    pub checkpoints: BTreeMap<String, Txid>,
    /// Burner branches: unix-ms expiry for GC.
    #[serde(default)]
    pub ttl_at: Option<i64>,
}

impl Manifest {
    pub fn new(branch: &str) -> Self {
        Self {
            format: 2,
            branch: branch.to_string(),
            parent: None,
            epoch: 1,
            head_txid: 0,
            wal_floor_seq: 0,
            segments: Vec::new(),
            retained: Vec::new(),
            checkpoints: BTreeMap::new(),
            ttl_at: None,
        }
    }

    /// Fence a writer epoch against the manifest (ported verbatim): an older
    /// epoch is a zombie; an equal-or-newer epoch claims the manifest.
    pub fn fence(&mut self, epoch: u64) -> Result<()> {
        if self.epoch > epoch {
            return Err(StrataError::ZombieFenced {
                manifest_epoch: self.epoch,
                writer_epoch: epoch,
            });
        }
        self.epoch = epoch;
        Ok(())
    }
}

// ---- object keys ----

pub fn manifest_key(root: &str, uuid: &str, branch: &str) -> ObjPath {
    ObjPath::from(format!("{root}/{uuid}/branches/{branch}/manifest.json"))
}

pub fn segment_key(root: &str, uuid: &str, min: Txid, max: Txid, level: u8) -> String {
    let nonce = &uuid::Uuid::new_v4().simple().to_string()[..8];
    format!("{root}/{uuid}/seg/{min:020}-{max:020}-L{level}-{nonce}.mseg")
}

/// WAL chunk key: sequence-deterministic (the conditional-create fence), with
/// the first txid embedded for the erasure-listing proof. The sequence is
/// monotone across rewinds; txids are not.
pub fn wal_chunk_key(root: &str, uuid: &str, branch: &str, seq: u64, first_txid: Txid) -> String {
    format!("{root}/{uuid}/wal/{branch}/{seq:020}-{first_txid:020}.mwal")
}

/// Parse `(seq, first_txid)` off a wal chunk key.
pub fn parse_wal_key(key: &str) -> Option<(u64, Txid)> {
    let name = key.rsplit('/').next()?.strip_suffix(".mwal")?;
    let (seq, txid) = name.split_once('-')?;
    Some((seq.parse().ok()?, txid.parse().ok()?))
}

/// Leading txid of a segment object name (`{min:020}-…`), for the erasure
/// listing proof (ported from the replication crate).
pub fn key_leading_txid(key: &str) -> Option<Txid> {
    let name = key.rsplit('/').next()?;
    name.split('-').next()?.parse().ok()
}

// ---- CAS load/store (ported shape: replication::Replicator) ----

pub async fn load_versioned(
    store: &Arc<dyn ObjectStore>,
    root: &str,
    uuid: &str,
    branch: &str,
) -> Result<Option<(Manifest, object_store::UpdateVersion)>> {
    match store.get(&manifest_key(root, uuid, branch)).await {
        Ok(r) => {
            let version = object_store::UpdateVersion {
                e_tag: r.meta.e_tag.clone(),
                version: r.meta.version.clone(),
            };
            let bytes = r.bytes().await?;
            let m = serde_json::from_slice(&bytes)
                .map_err(|e| StrataError::Corrupt(format!("manifest decode: {e}")))?;
            Ok(Some((m, version)))
        }
        Err(object_store::Error::NotFound { .. }) => Ok(None),
        Err(e) => Err(e.into()),
    }
}

pub async fn load(
    store: &Arc<dyn ObjectStore>,
    root: &str,
    uuid: &str,
    branch: &str,
) -> Result<Option<Manifest>> {
    Ok(load_versioned(store, root, uuid, branch)
        .await?
        .map(|(m, _)| m))
}

/// Conditional manifest write: create-if-absent or update-if-unchanged. A
/// zombie's CAS can never land because the version it read is gone. Backends
/// without conditional puts fall back to plain put — fencing still holds at
/// the epoch check.
pub async fn store_manifest(
    store: &Arc<dyn ObjectStore>,
    root: &str,
    uuid: &str,
    m: &Manifest,
    prev: Option<object_store::UpdateVersion>,
) -> Result<()> {
    let body = serde_json::to_vec_pretty(m)
        .map_err(|e| StrataError::Corrupt(format!("manifest encode: {e}")))?;
    let key = manifest_key(root, uuid, &m.branch);
    let payload = PutPayload::from(Bytes::from(body));
    let mode = match prev {
        Some(v) => object_store::PutMode::Update(v),
        None => object_store::PutMode::Create,
    };
    let opts = object_store::PutOptions {
        mode,
        ..Default::default()
    };
    match store.put_opts(&key, payload.clone(), opts).await {
        Ok(_) => Ok(()),
        Err(object_store::Error::Precondition { .. })
        | Err(object_store::Error::AlreadyExists { .. }) => Err(StrataError::CasConflict),
        Err(object_store::Error::NotSupported { .. })
        | Err(object_store::Error::NotImplemented) => {
            store.put(&key, payload).await?;
            Ok(())
        }
        Err(e) => Err(e.into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wal_key_round_trips() {
        let k = wal_chunk_key("v1", "u1", "main", 7, 42);
        assert_eq!(parse_wal_key(&k), Some((7, 42)));
        assert!(k.contains("/u1/wal/main/"));
    }

    #[test]
    fn segment_key_leads_with_min_txid() {
        let k = segment_key("v1", "u1", 5, 9, 0);
        assert_eq!(key_leading_txid(&k), Some(5));
        assert!(k.ends_with(".mseg"));
    }

    #[test]
    fn fence_rejects_zombies_and_claims_for_newer() {
        let mut m = Manifest::new("main");
        m.epoch = 5;
        assert!(matches!(
            m.fence(4),
            Err(StrataError::ZombieFenced {
                manifest_epoch: 5,
                writer_epoch: 4
            })
        ));
        m.fence(6).unwrap();
        assert_eq!(m.epoch, 6);
    }
}
