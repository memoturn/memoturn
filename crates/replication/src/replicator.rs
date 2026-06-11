use crate::manifest::{Manifest, ParentRef, SnapshotRef};
use crate::segment::{self, Segment, SegmentRef};
use crate::{ReplicationError, Result};
use bytes::Bytes;
use futures::TryStreamExt;
use memoturn_engine::DbHandle;
use object_store::path::Path as ObjPath;
use object_store::{ObjectStore, PutPayload};
use std::path::Path;
use std::sync::Arc;

/// Ship a compaction snapshot after this many segments — bounds restore cost
/// (≤ COMPACT_EVERY segment GETs + one snapshot GET).
const COMPACT_EVERY: usize = 16;

/// Manifest CAS retry budget on transient conflict (concurrent ship / lease
/// churn). Reload-and-reapply keeps a lost race from dropping the write.
const COMMIT_RETRIES: usize = 5;

/// What a ship uploaded, for live fan-out to replica subscribers.
pub enum ShipPayload {
    Segment {
        bytes: Vec<u8>,
        min_txid: u64,
        max_txid: u64,
    },
    /// Full image (branch base or compaction) — replicas replace their copy.
    Snapshot { bytes: Vec<u8>, txid: u64 },
}

pub struct ShipOutcome {
    pub manifest: Manifest,
    pub payload: Option<ShipPayload>,
}

/// Storage-side operations: ship snapshots, load/store manifests, restore,
/// fork, checkpoint, rewind. Stateless — all state lives in object storage.
pub struct Replicator {
    store: Arc<dyn ObjectStore>,
    root: String,
}

impl Replicator {
    pub fn new(store: Arc<dyn ObjectStore>, root: &str) -> Self {
        Self {
            store,
            root: root.trim_matches('/').to_string(),
        }
    }

    fn manifest_key(&self, uuid: &str, branch: &str) -> ObjPath {
        ObjPath::from(format!(
            "{}/{uuid}/branches/{branch}/manifest.json",
            self.root
        ))
    }

    fn snapshot_key(&self, uuid: &str, txid: u64) -> String {
        let nonce = &uuid::Uuid::new_v4().simple().to_string()[..8];
        format!("{}/{uuid}/snapshots/{txid:020}-{nonce}.db", self.root)
    }

    fn segment_key(&self, uuid: &str, min: u64, max: u64) -> String {
        let nonce = &uuid::Uuid::new_v4().simple().to_string()[..8];
        format!("{}/{uuid}/ltx/{min:020}-{max:020}-{nonce}.mltx", self.root)
    }

    // ---- manifests ----

    pub async fn load_manifest(&self, uuid: &str, branch: &str) -> Result<Option<Manifest>> {
        Ok(self
            .load_manifest_versioned(uuid, branch)
            .await?
            .map(|(m, _)| m))
    }

    /// Manifest plus its object version, for CAS updates.
    pub async fn load_manifest_versioned(
        &self,
        uuid: &str,
        branch: &str,
    ) -> Result<Option<(Manifest, object_store::UpdateVersion)>> {
        match self.store.get(&self.manifest_key(uuid, branch)).await {
            Ok(r) => {
                let version = object_store::UpdateVersion {
                    e_tag: r.meta.e_tag.clone(),
                    version: r.meta.version.clone(),
                };
                let bytes = r.bytes().await?;
                let m = serde_json::from_slice(&bytes)
                    .map_err(|e| ReplicationError::Corrupt(e.to_string()))?;
                Ok(Some((m, version)))
            }
            Err(object_store::Error::NotFound { .. }) => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    /// Conditional manifest write (ADR-0004 fencing): create-if-absent or
    /// update-if-unchanged. A zombie's CAS can never land because the version
    /// it read is gone. Backends without conditional-put support (some local
    /// filesystems) fall back to plain put — fencing still holds at the epoch
    /// check in `ship_snapshot`.
    pub async fn store_manifest(
        &self,
        uuid: &str,
        m: &Manifest,
        prev: Option<object_store::UpdateVersion>,
    ) -> Result<()> {
        let body =
            serde_json::to_vec_pretty(m).map_err(|e| ReplicationError::Corrupt(e.to_string()))?;
        let key = self.manifest_key(uuid, &m.branch);
        let payload = PutPayload::from(Bytes::from(body));
        let mode = match prev {
            Some(v) => object_store::PutMode::Update(v),
            None => object_store::PutMode::Create,
        };
        let opts = object_store::PutOptions {
            mode,
            ..Default::default()
        };
        match self.store.put_opts(&key, payload.clone(), opts).await {
            Ok(_) => Ok(()),
            Err(object_store::Error::Precondition { .. })
            | Err(object_store::Error::AlreadyExists { .. }) => Err(ReplicationError::CasConflict),
            Err(object_store::Error::NotSupported { .. })
            | Err(object_store::Error::NotImplemented) => {
                self.store.put(&key, payload).await?;
                Ok(())
            }
            Err(e) => Err(e.into()),
        }
    }

    /// Append a freshly-uploaded segment to the manifest and commit it, retrying
    /// the CAS on transient conflict. On conflict the manifest is reloaded,
    /// re-fenced, and the (already-uploaded, idempotent) segment re-appended —
    /// so a lost CAS race against a concurrent ship does not drop the write or
    /// require re-capturing the WAL. The uploaded object is content-addressed by
    /// txid range; if the chain has moved past it the object is simply left for
    /// GC to reclaim as unreferenced.
    async fn commit_segment(
        &self,
        uuid: &str,
        branch: &str,
        epoch: u64,
        mut manifest: Manifest,
        mut prev: Option<object_store::UpdateVersion>,
        seg_ref: SegmentRef,
    ) -> Result<Manifest> {
        for attempt in 0..=COMMIT_RETRIES {
            let mut m = manifest.clone();
            m.segments.push(seg_ref.clone());
            m.head_txid = seg_ref.max_txid;
            match self.store_manifest(uuid, &m, prev.clone()).await {
                Ok(()) => return Ok(m),
                Err(ReplicationError::CasConflict) if attempt < COMMIT_RETRIES => {
                    let (mut fresh, v) = self
                        .load_manifest_versioned(uuid, branch)
                        .await?
                        .ok_or_else(|| ReplicationError::BranchNotFound(branch.to_string()))?;
                    Self::fence(&mut fresh, epoch)?;
                    if fresh.head_txid == seg_ref.max_txid {
                        return Ok(fresh); // our delta already landed
                    }
                    if fresh.head_txid != seg_ref.min_txid {
                        // The chain advanced elsewhere; our captured delta no
                        // longer applies contiguously. Surface the conflict —
                        // the WAL cursor is unadvanced, so the next ship recaptures.
                        return Err(ReplicationError::CasConflict);
                    }
                    manifest = fresh;
                    prev = Some(v);
                }
                Err(e) => return Err(e),
            }
        }
        Err(ReplicationError::CasConflict)
    }

    /// Append a freshly-uploaded snapshot and commit it, retrying the CAS on
    /// conflict (reload + re-fence + re-append). Abandons if the branch head has
    /// already advanced past this snapshot's txid (the object is left for GC).
    async fn commit_snapshot(
        &self,
        uuid: &str,
        branch: &str,
        epoch: u64,
        mut manifest: Manifest,
        mut prev: Option<object_store::UpdateVersion>,
        snap_ref: SnapshotRef,
    ) -> Result<Manifest> {
        for attempt in 0..=COMMIT_RETRIES {
            let mut m = manifest.clone();
            m.snapshots.push(snap_ref.clone());
            m.head_txid = snap_ref.txid;
            match self.store_manifest(uuid, &m, prev.clone()).await {
                Ok(()) => return Ok(m),
                Err(ReplicationError::CasConflict) if attempt < COMMIT_RETRIES => {
                    let (mut fresh, v) = self
                        .load_manifest_versioned(uuid, branch)
                        .await?
                        .ok_or_else(|| ReplicationError::BranchNotFound(branch.to_string()))?;
                    Self::fence(&mut fresh, epoch)?;
                    if fresh.snapshots.iter().any(|s| s.txid == snap_ref.txid) {
                        return Ok(fresh); // already landed
                    }
                    if fresh.head_txid > snap_ref.txid {
                        return Err(ReplicationError::CasConflict); // head moved on
                    }
                    manifest = fresh;
                    prev = Some(v);
                }
                Err(e) => return Err(e),
            }
        }
        Err(ReplicationError::CasConflict)
    }

    // ---- shipping ----

    fn fence(manifest: &mut Manifest, epoch: u64) -> Result<()> {
        if manifest.epoch > epoch {
            return Err(ReplicationError::ZombieFenced {
                manifest_epoch: manifest.epoch,
                writer_epoch: epoch,
            });
        }
        manifest.epoch = epoch;
        Ok(())
    }

    /// Ship the branch's unshipped state: a page-delta segment in the common
    /// case, a full snapshot for the first ship of a branch, when the WAL
    /// capture cursor was lost, or as periodic compaction (every
    /// `COMPACT_EVERY` segments). Epoch-fenced + CAS like all manifest
    /// writes.
    pub async fn ship(
        &self,
        h: &DbHandle,
        uuid: &str,
        branch: &str,
        epoch: u64,
    ) -> Result<Manifest> {
        Ok(self.ship_outcome(h, uuid, branch, epoch).await?.manifest)
    }

    /// `ship` plus the bytes that were uploaded, so callers can fan them out
    /// to live replica subscribers.
    pub async fn ship_outcome(
        &self,
        h: &DbHandle,
        uuid: &str,
        branch: &str,
        epoch: u64,
    ) -> Result<ShipOutcome> {
        let loaded = self.load_manifest_versioned(uuid, branch).await?;
        let (mut manifest, prev) = match loaded {
            Some((m, v)) => (m, Some(v)),
            None => (Manifest::new(branch), None),
        };
        Self::fence(&mut manifest, epoch)?;
        if manifest.head_txid == h.txid() && !manifest.snapshots.is_empty() {
            return Ok(ShipOutcome {
                manifest,
                payload: None,
            }); // clean
        }

        let needs_snapshot = manifest.snapshots.is_empty() || manifest.chain_len() >= COMPACT_EVERY;
        if !needs_snapshot {
            if let Some((capture, end_txid)) = h.capture_wal().await? {
                if end_txid == manifest.head_txid {
                    return Ok(ShipOutcome {
                        manifest,
                        payload: None,
                    });
                }
                if !capture.pages.is_empty() && capture.db_size_pages > 0 {
                    let seg = Segment {
                        page_size: capture.page_size,
                        min_txid: manifest.head_txid,
                        max_txid: end_txid,
                        db_size_pages: capture.db_size_pages,
                        pages: capture.pages,
                    };
                    let bytes = segment::encode(&seg)?;
                    let key = self.segment_key(uuid, seg.min_txid, seg.max_txid);
                    self.store
                        .put(
                            &ObjPath::from(key.clone()),
                            PutPayload::from(Bytes::from(bytes.clone())),
                        )
                        .await?;
                    let seg_ref = SegmentRef {
                        min_txid: seg.min_txid,
                        max_txid: seg.max_txid,
                        key,
                        db_size_pages: seg.db_size_pages,
                    };
                    let manifest = self
                        .commit_segment(uuid, branch, epoch, manifest, prev, seg_ref)
                        .await?;
                    return Ok(ShipOutcome {
                        manifest,
                        payload: Some(ShipPayload::Segment {
                            bytes,
                            min_txid: seg.min_txid,
                            max_txid: seg.max_txid,
                        }),
                    });
                }
                // txid moved but no committed frames surfaced — fall through
                // to the snapshot path rather than ship a hole in the chain.
            }
            // Cursor lost (unexpected WAL reset): full snapshot resyncs.
        }
        self.snapshot_into_manifest(h, uuid, manifest, prev).await
    }

    /// Force a full snapshot ship (also used directly by tests/benches).
    pub async fn ship_snapshot(
        &self,
        h: &DbHandle,
        uuid: &str,
        branch: &str,
        epoch: u64,
    ) -> Result<Manifest> {
        let loaded = self.load_manifest_versioned(uuid, branch).await?;
        let (mut manifest, prev) = match loaded {
            Some((m, v)) => (m, Some(v)),
            None => (Manifest::new(branch), None),
        };
        Self::fence(&mut manifest, epoch)?;
        if manifest.head_snapshot().map(|s| s.txid) == Some(h.txid()) {
            return Ok(manifest);
        }
        Ok(self
            .snapshot_into_manifest(h, uuid, manifest, prev)
            .await?
            .manifest)
    }

    async fn snapshot_into_manifest(
        &self,
        h: &DbHandle,
        uuid: &str,
        manifest: Manifest,
        prev: Option<object_store::UpdateVersion>,
    ) -> Result<ShipOutcome> {
        // Layout-faithful image with the WAL cursor skipped to the snapshot
        // point, so the next segment carries only frames newer than this.
        let (bytes, txid) = h.snapshot_bytes().await?;
        let key = self.snapshot_key(uuid, txid);
        self.store
            .put(
                &ObjPath::from(key.clone()),
                PutPayload::from(Bytes::from(bytes.clone())),
            )
            .await?;
        let branch = manifest.branch.clone();
        let epoch = manifest.epoch;
        let manifest = self
            .commit_snapshot(
                uuid,
                &branch,
                epoch,
                manifest,
                prev,
                SnapshotRef { txid, key },
            )
            .await?;
        Ok(ShipOutcome {
            manifest,
            payload: Some(ShipPayload::Snapshot { bytes, txid }),
        })
    }

    // ---- restore ----

    /// Materialize a branch locally at its head (cold wake) or at a specific
    /// txid (rewind/PITR — must be a shipped boundary). Restores the latest
    /// snapshot ≤ target, then replays the contiguous segment chain up to the
    /// target. Returns the restored txid, or None when the branch has no
    /// manifest yet (fresh database — caller opens an empty file).
    pub async fn restore(
        &self,
        uuid: &str,
        branch: &str,
        at_txid: Option<u64>,
        dest_file: &Path,
    ) -> Result<Option<u64>> {
        let Some(manifest) = self.load_manifest(uuid, branch).await? else {
            return Ok(None);
        };
        let target = at_txid.unwrap_or(manifest.head_txid);
        let snap = manifest
            .snapshot_at(target)
            .ok_or(ReplicationError::NoSnapshot(target))?;
        let mut image = self
            .store
            .get(&ObjPath::from(snap.key.clone()))
            .await?
            .bytes()
            .await?
            .to_vec();

        // Replay the chain (snap.txid, target].
        let mut current = snap.txid;
        for sref in manifest
            .segments
            .iter()
            .filter(|s| s.min_txid >= snap.txid && s.max_txid <= target)
        {
            if sref.min_txid != current {
                return Err(ReplicationError::Corrupt(format!(
                    "segment chain gap: at txid {current}, next segment starts at {}",
                    sref.min_txid
                )));
            }
            let bytes = self
                .store
                .get(&ObjPath::from(sref.key.clone()))
                .await?
                .bytes()
                .await?;
            let seg = segment::decode(&bytes)?;
            let ps = seg.page_size as usize;
            let new_len = seg.db_size_pages as usize * ps;
            if image.len() < new_len {
                image.resize(new_len, 0);
            }
            for (pgno, img) in &seg.pages {
                let at = (*pgno as usize - 1) * ps;
                if at + ps > image.len() {
                    image.resize(at + ps, 0);
                }
                image[at..at + ps].copy_from_slice(img);
            }
            image.truncate(new_len);
            current = sref.max_txid;
        }
        if current != target {
            return Err(ReplicationError::NoSnapshot(target));
        }

        if let Some(parent) = dest_file.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }
        // Clear any stale sidecar files before laying down the image.
        for suffix in ["", "-wal", "-shm"] {
            let p = dest_file.with_file_name(format!("main.db{suffix}"));
            let _ = tokio::fs::remove_file(&p).await;
        }
        tokio::fs::write(dest_file, &image).await?;
        Ok(Some(current))
    }

    // ---- branch operations (manifest CoW, ADR-0004) ----

    /// Fork `parent_branch` at its current head into `child`. The parent must
    /// have been shipped first (callers ship-if-dirty); the child shares the
    /// parent's head snapshot object — no data is copied.
    pub async fn fork(
        &self,
        uuid: &str,
        parent_branch: &str,
        child: &str,
        ttl_at: Option<i64>,
    ) -> Result<Manifest> {
        let parent = self
            .load_manifest(uuid, parent_branch)
            .await?
            .ok_or_else(|| ReplicationError::BranchNotFound(parent_branch.to_string()))?;
        if parent.snapshots.is_empty() {
            return Err(ReplicationError::NoSnapshot(parent.head_txid));
        }
        let fork_txid = parent.head_txid;
        // CoW: the child references the parent's chain objects up to the fork
        // point — no data is copied, the objects are shared (GC refcounts by
        // referencing manifests).
        let manifest = Manifest {
            branch: child.to_string(),
            parent: Some(ParentRef {
                branch: parent_branch.to_string(),
                fork_txid,
            }),
            epoch: 1,
            head_txid: fork_txid,
            snapshots: parent
                .snapshots
                .iter()
                .filter(|s| s.txid <= fork_txid)
                .cloned()
                .collect(),
            segments: parent
                .segments
                .iter()
                .filter(|s| s.max_txid <= fork_txid)
                .cloned()
                .collect(),
            checkpoints: Default::default(),
            ttl_at,
        };
        self.store_manifest(uuid, &manifest, None).await?;
        Ok(manifest)
    }

    /// Name the current head as a checkpoint (snapshot must be current —
    /// callers ship-if-dirty first).
    pub async fn checkpoint(&self, uuid: &str, branch: &str, name: &str) -> Result<Manifest> {
        let (mut m, version) = self
            .load_manifest_versioned(uuid, branch)
            .await?
            .ok_or_else(|| ReplicationError::BranchNotFound(branch.to_string()))?;
        m.checkpoints.insert(name.to_string(), m.head_txid);
        self.store_manifest(uuid, &m, Some(version)).await?;
        Ok(m)
    }

    /// Move the branch head back to a checkpoint name or txid. Snapshots
    /// after the target are dropped from this branch's view (the objects
    /// remain until GC). The manifest `epoch` is writer-ownership state and
    /// is not touched here — rewinds route through the current owner.
    pub async fn rewind(&self, uuid: &str, branch: &str, to: &str) -> Result<Manifest> {
        let (mut m, version) = self
            .load_manifest_versioned(uuid, branch)
            .await?
            .ok_or_else(|| ReplicationError::BranchNotFound(branch.to_string()))?;
        let target = match m.checkpoints.get(to) {
            Some(t) => *t,
            None => to
                .parse::<u64>()
                .map_err(|_| ReplicationError::BranchNotFound(format!("checkpoint {to}")))?,
        };
        // The target must be a restorable boundary (every checkpoint is one:
        // checkpoints ship first).
        if !m.is_boundary(target) {
            return Err(ReplicationError::NoSnapshot(target));
        }
        m.snapshot_at(target)
            .ok_or(ReplicationError::NoSnapshot(target))?;
        m.snapshots.retain(|s| s.txid <= target);
        m.segments.retain(|s| s.max_txid <= target);
        m.head_txid = target;
        self.store_manifest(uuid, &m, Some(version)).await?;
        Ok(m)
    }

    pub async fn delete_branch(&self, uuid: &str, branch: &str) -> Result<()> {
        match self.store.delete(&self.manifest_key(uuid, branch)).await {
            Ok(()) | Err(object_store::Error::NotFound { .. }) => Ok(()),
            Err(e) => Err(e.into()),
        }
    }

    /// Reclaim snapshot/segment objects no longer referenced by *any* live
    /// branch manifest of this database — the refcount GC (ADR-0004). Building
    /// the referenced set across every branch is what makes it safe under
    /// copy-on-write forks: a child manifest that shares a parent's objects
    /// keeps them referenced, so a leaf-branch delete never strands a parent.
    /// Orphans from a failed manifest CAS (segment uploaded, commit lost) are
    /// unreferenced and collected here too.
    ///
    /// `grace` shields objects written very recently (uploaded but not yet
    /// committed to a manifest, or committed on another node whose manifest we
    /// have not observed) from deletion. Returns the number of objects removed.
    pub async fn gc(&self, uuid: &str, grace: std::time::Duration) -> Result<usize> {
        use std::collections::HashSet;

        // 1) Referenced set: every snapshot/segment key in every branch manifest.
        let branches_prefix = ObjPath::from(format!("{}/{uuid}/branches", self.root));
        let manifest_keys: Vec<ObjPath> = self
            .store
            .list(Some(&branches_prefix))
            .map_ok(|m| m.location)
            .try_collect()
            .await?;
        let mut referenced: HashSet<String> = HashSet::new();
        for mk in manifest_keys {
            let bytes = self.store.get(&mk).await?.bytes().await?;
            let m: Manifest = serde_json::from_slice(&bytes)
                .map_err(|e| ReplicationError::Corrupt(e.to_string()))?;
            for s in &m.snapshots {
                referenced.insert(s.key.clone());
            }
            for s in &m.segments {
                referenced.insert(s.key.clone());
            }
        }

        // 2) Delete unreferenced data objects older than the grace window.
        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        let cutoff_ms = now_ms - grace.as_millis() as i64;
        let mut deleted = 0;
        for sub in ["snapshots", "ltx"] {
            let prefix = ObjPath::from(format!("{}/{uuid}/{sub}", self.root));
            let metas: Vec<object_store::ObjectMeta> =
                self.store.list(Some(&prefix)).try_collect().await?;
            for meta in metas {
                let key = meta.location.to_string();
                if referenced.contains(&key) {
                    continue;
                }
                if meta.last_modified.timestamp_millis() >= cutoff_ms {
                    continue; // too fresh — may be mid-commit
                }
                self.store.delete(&meta.location).await?;
                deleted += 1;
            }
        }
        Ok(deleted)
    }

    /// Delete every object under a database prefix (database deletion).
    pub async fn delete_db(&self, uuid: &str) -> Result<()> {
        let prefix = ObjPath::from(format!("{}/{uuid}", self.root));
        let keys: Vec<ObjPath> = self
            .store
            .list(Some(&prefix))
            .map_ok(|m| m.location)
            .try_collect()
            .await?;
        for key in keys {
            self.store.delete(&key).await?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::manifest::Manifest;
    use crate::segment::SegmentRef;
    use object_store::memory::InMemory;
    use std::time::Duration;

    async fn put(store: &Arc<dyn ObjectStore>, key: &str) {
        store
            .put(
                &ObjPath::from(key.to_string()),
                PutPayload::from(Bytes::from_static(b"x")),
            )
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn gc_keeps_referenced_and_shared_objects_collects_orphans() {
        let store: Arc<dyn ObjectStore> = Arc::new(InMemory::new());
        let r = Replicator::new(store.clone(), "v1");
        let uuid = "u1";

        let snap_key = format!("v1/{uuid}/snapshots/{:020}-aaaa.db", 5u64);
        let seg_key = format!("v1/{uuid}/ltx/{:020}-{:020}-bbbb.mltx", 5u64, 6u64);
        let orphan_key = format!("v1/{uuid}/ltx/{:020}-{:020}-cccc.mltx", 9u64, 9u64);
        put(&store, &snap_key).await;
        put(&store, &seg_key).await;
        put(&store, &orphan_key).await; // unreferenced (e.g. failed CAS)

        // main references snap+seg; a forked child shares the same snapshot
        // object (copy-on-write) — so it must survive a delete of either branch.
        let mut main = Manifest::new("main");
        main.snapshots.push(SnapshotRef {
            txid: 5,
            key: snap_key.clone(),
        });
        main.segments.push(SegmentRef {
            min_txid: 5,
            max_txid: 6,
            key: seg_key.clone(),
            db_size_pages: 1,
        });
        main.head_txid = 6;
        r.store_manifest(uuid, &main, None).await.unwrap();
        let mut child = Manifest::new("child");
        child.snapshots.push(SnapshotRef {
            txid: 5,
            key: snap_key.clone(),
        });
        child.head_txid = 5;
        r.store_manifest(uuid, &child, None).await.unwrap();

        // Age the objects past the (zero) grace window.
        tokio::time::sleep(Duration::from_millis(25)).await;
        let deleted = r.gc(uuid, Duration::ZERO).await.unwrap();

        assert_eq!(deleted, 1, "only the orphan is collected");
        assert!(
            store.get(&ObjPath::from(snap_key)).await.is_ok(),
            "shared snapshot kept"
        );
        assert!(
            store.get(&ObjPath::from(seg_key)).await.is_ok(),
            "referenced segment kept"
        );
        assert!(
            store.get(&ObjPath::from(orphan_key)).await.is_err(),
            "orphan reclaimed"
        );
    }

    #[tokio::test]
    async fn gc_grace_window_shields_fresh_objects() {
        let store: Arc<dyn ObjectStore> = Arc::new(InMemory::new());
        let r = Replicator::new(store.clone(), "v1");
        let orphan = "v1/u2/ltx/00000000000000000001-00000000000000000001-dddd.mltx";
        put(&store, orphan).await;
        r.store_manifest("u2", &Manifest::new("main"), None)
            .await
            .unwrap();
        // A generous grace keeps the just-written (uncommitted) object.
        let deleted = r.gc("u2", Duration::from_secs(3600)).await.unwrap();
        assert_eq!(deleted, 0, "fresh objects survive the grace window");
        assert!(store.get(&ObjPath::from(orphan)).await.is_ok());
    }
}
