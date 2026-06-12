//! The node host: `Store` (object storage + caches), `Db` (an owned writer
//! for one branch: group-commit rounds, flush, ship, branch ops, erasure),
//! and `Replica` (a stateless reader over manifest + WAL tail). All
//! correctness state lives in object storage; the memtable and local log are
//! reconstructible caches (docs/architecture/09).

use crate::core::compact::{self, Mode};
use crate::core::logrec::LogRecord;
use crate::core::manifest::{self, key_leading_txid, segment_key, Manifest, ParentRef, SegmentRef};
use crate::core::memtable::Memtable;
use crate::core::ops::{stage, Durability, WriteOutput, WriteRequest};
use crate::core::segment::{self, DecodedSegment, Entry};
use crate::core::view::{Overlay, View};
use crate::core::wal::{self, ChunkHeader, LocalLog};
use crate::{Result, StrataError, Txid};
use bytes::Bytes;
use futures::TryStreamExt;
use object_store::path::Path as ObjPath;
use object_store::{ObjectStore, PutPayload};
use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering as AtomicOrdering};
use std::sync::{Arc, Mutex as StdMutex};
use tokio::sync::{oneshot, Mutex as AsyncMutex};

/// Group-commit round cap (ported from the libSQL engine's writer).
const ROUND_MAX: usize = 64;
/// Manifest CAS retry budget on transient conflict (ported).
const COMMIT_RETRIES: usize = 5;
/// Fence-chunk loop budget: each iteration consumes one zombie chunk.
const FENCE_RETRIES: usize = 16;

pub struct Store {
    object: Arc<dyn ObjectStore>,
    root: String,
    data_dir: std::path::PathBuf,
    seg_cache: moka::sync::Cache<String, Arc<DecodedSegment>>,
}

impl Store {
    pub fn new(
        object: Arc<dyn ObjectStore>,
        root: &str,
        data_dir: impl Into<std::path::PathBuf>,
    ) -> Arc<Self> {
        Arc::new(Self {
            object,
            root: root.trim_matches('/').to_string(),
            data_dir: data_dir.into(),
            // Immutable segments: entries never invalidate, only evict.
            seg_cache: moka::sync::Cache::new(1024),
        })
    }

    /// Provision a database: one manifest create for `main`. Idempotent.
    pub async fn create_db(&self, uuid: &str) -> Result<()> {
        match manifest::store_manifest(&self.object, &self.root, uuid, &Manifest::new("main"), None)
            .await
        {
            Ok(()) | Err(StrataError::CasConflict) => Ok(()),
            Err(e) => Err(e),
        }
    }

    async fn load_segment(&self, key: &str) -> Result<Arc<DecodedSegment>> {
        if let Some(seg) = self.seg_cache.get(key) {
            return Ok(seg);
        }
        let bytes = self
            .object
            .get(&ObjPath::from(key.to_string()))
            .await?
            .bytes()
            .await?;
        let seg = Arc::new(segment::decode(&bytes)?);
        self.seg_cache.insert(key.to_string(), seg.clone());
        Ok(seg)
    }

    async fn load_segments(&self, refs: &[SegmentRef]) -> Result<Vec<Arc<DecodedSegment>>> {
        let mut out = Vec::with_capacity(refs.len());
        for r in refs {
            out.push(self.load_segment(&r.key).await?);
        }
        Ok(out)
    }

    fn local_log_path(&self, uuid: &str, branch: &str) -> std::path::PathBuf {
        self.data_dir.join(uuid).join(format!("{branch}.log"))
    }

    // ---- ownership takeover (the fence protocol, 09 § fencing) ----

    /// Open a branch for writing: bump the epoch (manifest CAS — the single
    /// fencing point), replay the WAL tail and local log, then land a fence
    /// chunk so no zombie can extend the chain.
    pub async fn open(self: &Arc<Self>, uuid: &str, branch: &str) -> Result<Db> {
        // 1) Claim ownership: epoch := old + 1, CAS (retried on conflict).
        let mut manifest_v = None;
        for attempt in 0..=COMMIT_RETRIES {
            let Some((mut m, v)) =
                manifest::load_versioned(&self.object, &self.root, uuid, branch).await?
            else {
                return Err(StrataError::BranchNotFound(branch.to_string()));
            };
            let new_epoch = m.epoch + 1;
            m.fence(new_epoch)?;
            match manifest::store_manifest(&self.object, &self.root, uuid, &m, Some(v)).await {
                Ok(()) => {
                    manifest_v = Some(m);
                    break;
                }
                Err(StrataError::CasConflict) if attempt < COMMIT_RETRIES => continue,
                Err(e) => return Err(e),
            }
        }
        let m = manifest_v.ok_or(StrataError::CasConflict)?;
        let epoch = m.epoch;

        // 2) Replay the WAL tail (seq > floor) into a fresh memtable.
        let mut mem = Memtable::default();
        let mut head = m.head_txid;
        let mut max_seq = m.wal_floor_seq;
        let chunks = wal::list_chunks(&self.object, &self.root, uuid, branch).await?;
        for (seq, _, key) in &chunks {
            if *seq <= m.wal_floor_seq {
                continue;
            }
            let (header, records) = wal::get_chunk(&self.object, key).await?;
            if header.epoch > epoch {
                return Err(StrataError::ZombieFenced {
                    manifest_epoch: header.epoch,
                    writer_epoch: epoch,
                });
            }
            for rec in records {
                head = apply_replayed(&mut mem, head, &rec)?;
            }
            max_seq = max_seq.max(*seq);
        }

        // 3) Local log: records above the object-durable head are candidates
        //    to carry forward — NOT applied yet, because object storage wins
        //    every conflict and the fence loop below may advance the head.
        let log_path = self.local_log_path(uuid, branch);
        let mut local_pending: Vec<LogRecord> = Vec::new();
        for rec in LocalLog::replay(&log_path)? {
            if rec.txid <= head {
                continue;
            }
            let expected = local_pending.last().map_or(head, |r| r.txid) + 1;
            if rec.txid == expected {
                local_pending.push(rec);
            } else {
                break; // gap: pre-rewind generation or torn history — drop
            }
        }

        // 4) Fence-chunk loop. The fence chunk carries the surviving
        //    local-only records ahead of the fence record, upgrading them to
        //    object-durable at takeover — the chain in object storage stays
        //    contiguous even if this node's disk dies next. AlreadyExists =
        //    a zombie's chunk landed between our list and our create: replay
        //    it (its durable acks must survive; object storage wins any txid
        //    conflict with our local tail) and retry at the next sequence.
        let mut next_seq = max_seq + 1;
        let mut fenced = false;
        for _ in 0..FENCE_RETRIES {
            local_pending.retain(|r| r.txid > head);
            if local_pending.first().is_some_and(|r| r.txid != head + 1) {
                local_pending.clear(); // zombie history displaced our tail
            }
            let fence_txid = head + local_pending.len() as Txid + 1;
            let mut records = local_pending.clone();
            records.push(LogRecord::fence(epoch, fence_txid));
            let header = ChunkHeader {
                format: 1,
                branch: branch.to_string(),
                epoch,
                seq: next_seq,
                first_txid: records[0].txid,
                last_txid: fence_txid,
            };
            if wal::put_chunk(&self.object, &self.root, uuid, &header, &records).await? {
                for rec in &local_pending {
                    head = apply_replayed(&mut mem, head, rec)?;
                }
                head = fence_txid; // the fence consumes a txid (empty round)
                next_seq += 1;
                fenced = true;
                break;
            }
            // Replay the occupant and retry.
            let chunks = wal::list_chunks(&self.object, &self.root, uuid, branch).await?;
            for (seq, _, key) in &chunks {
                if *seq < next_seq {
                    continue;
                }
                let (header, records) = wal::get_chunk(&self.object, key).await?;
                if header.epoch > epoch {
                    return Err(StrataError::ZombieFenced {
                        manifest_epoch: header.epoch,
                        writer_epoch: epoch,
                    });
                }
                for rec in records {
                    head = apply_replayed(&mut mem, head, &rec)?;
                }
                next_seq = next_seq.max(*seq + 1);
            }
        }
        if !fenced {
            return Err(StrataError::CasConflict);
        }
        // Everything live is now object-durable; the local log restarts clean.
        let mut log = LocalLog::open(log_path)?;
        log.truncate()?;

        let segs = self.load_segments(&m.segments).await?;
        Ok(Db {
            shared: Arc::new(DbShared {
                store: self.clone(),
                uuid: uuid.to_string(),
                branch: branch.to_string(),
                epoch,
                fenced: AtomicBool::new(false),
                pending: StdMutex::new(VecDeque::new()),
                inner: AsyncMutex::new(DbInner {
                    mem,
                    head,
                    manifest: m,
                    segs,
                    log,
                    unshipped: Vec::new(),
                    next_seq,
                }),
            }),
        })
    }

    // ---- replica: stateless reader over manifest + wal tail ----

    pub async fn replica(self: &Arc<Self>, uuid: &str, branch: &str) -> Result<Replica> {
        let Some(m) = manifest::load(&self.object, &self.root, uuid, branch).await? else {
            return Err(StrataError::BranchNotFound(branch.to_string()));
        };
        let mut mem = Memtable::default();
        let mut head = m.head_txid;
        for (seq, _, key) in wal::list_chunks(&self.object, &self.root, uuid, branch).await? {
            if seq <= m.wal_floor_seq {
                continue;
            }
            let (_, records) = wal::get_chunk(&self.object, &key).await?;
            for rec in records {
                head = apply_replayed(&mut mem, head, &rec)?;
            }
        }
        let segs = self.load_segments(&m.segments).await?;
        Ok(Replica { mem, segs, head })
    }

    // ---- branch operations (manifest CoW, ported semantics) ----

    /// Fork `parent@head` into `child` — one manifest create, no data copied.
    /// Callers flush the parent first (`Db::fork` does).
    pub async fn fork(
        &self,
        uuid: &str,
        parent_branch: &str,
        child: &str,
        ttl_at: Option<i64>,
    ) -> Result<Manifest> {
        let parent = manifest::load(&self.object, &self.root, uuid, parent_branch)
            .await?
            .ok_or_else(|| StrataError::BranchNotFound(parent_branch.to_string()))?;
        let fork_txid = parent.head_txid;
        let m = Manifest {
            format: 2,
            branch: child.to_string(),
            parent: Some(ParentRef {
                branch: parent_branch.to_string(),
                fork_txid,
            }),
            epoch: 1,
            head_txid: fork_txid,
            wal_floor_seq: 0, // child has its own wal prefix
            segments: parent
                .segments
                .iter()
                .filter(|s| s.min_txid <= fork_txid)
                .cloned()
                .collect(),
            retained: parent.retained.clone(),
            checkpoints: Default::default(),
            ttl_at,
        };
        manifest::store_manifest(&self.object, &self.root, uuid, &m, None).await?;
        Ok(m)
    }

    pub async fn delete_branch(&self, uuid: &str, branch: &str) -> Result<()> {
        match self
            .object
            .delete(&manifest::manifest_key(&self.root, uuid, branch))
            .await
        {
            Ok(()) | Err(object_store::Error::NotFound { .. }) => Ok(()),
            Err(e) => Err(e.into()),
        }
    }

    async fn branch_manifests(&self, uuid: &str) -> Result<Vec<Manifest>> {
        let prefix = ObjPath::from(format!("{}/{uuid}/branches", self.root));
        let keys: Vec<ObjPath> = self
            .object
            .list(Some(&prefix))
            .map_ok(|m| m.location)
            .try_collect()
            .await?;
        let mut out = Vec::with_capacity(keys.len());
        for k in keys {
            let bytes = self.object.get(&k).await?.bytes().await?;
            out.push(
                serde_json::from_slice(&bytes)
                    .map_err(|e| StrataError::Corrupt(format!("manifest decode: {e}")))?,
            );
        }
        Ok(out)
    }

    // ---- GC / retention / erasure (ported invariants) ----

    /// Refcount GC: delete `seg/` objects referenced by no branch manifest
    /// (live or retained) and `wal/` chunks below their branch's floor —
    /// after `grace`. Union across all manifests keeps copy-on-write children
    /// safe; orphans from lost CAS races are reclaimed here too.
    pub async fn gc(&self, uuid: &str, grace: std::time::Duration) -> Result<usize> {
        use std::collections::{HashMap, HashSet};
        let manifests = self.branch_manifests(uuid).await?;
        let mut referenced: HashSet<String> = HashSet::new();
        let mut floors: HashMap<String, u64> = HashMap::new();
        for m in &manifests {
            for s in m.segments.iter().chain(&m.retained) {
                referenced.insert(s.key.clone());
            }
            floors.insert(m.branch.clone(), m.wal_floor_seq);
        }
        let now_ms = crate::now_ms();
        let cutoff_ms = now_ms - grace.as_millis() as i64;
        let mut deleted = 0;

        let seg_prefix = ObjPath::from(format!("{}/{uuid}/seg", self.root));
        let metas: Vec<object_store::ObjectMeta> =
            self.object.list(Some(&seg_prefix)).try_collect().await?;
        for meta in metas {
            let key = meta.location.to_string();
            if referenced.contains(&key) || meta.last_modified.timestamp_millis() >= cutoff_ms {
                continue;
            }
            self.object.delete(&meta.location).await?;
            deleted += 1;
        }

        let wal_prefix = ObjPath::from(format!("{}/{uuid}/wal", self.root));
        let metas: Vec<object_store::ObjectMeta> =
            self.object.list(Some(&wal_prefix)).try_collect().await?;
        for meta in metas {
            let key = meta.location.to_string();
            if meta.last_modified.timestamp_millis() >= cutoff_ms {
                continue;
            }
            // wal/{branch}/{seq}-{txid}.mwal — absorbed (seq ≤ floor) chunks
            // and chunks of deleted branches are unreferenced.
            let branch = key.rsplit('/').nth(1).unwrap_or_default().to_string();
            let Some((seq, _)) = manifest::parse_wal_key(&key) else {
                continue;
            };
            let absorbed = match floors.get(&branch) {
                Some(floor) => seq <= *floor,
                None => true, // branch deleted
            };
            if absorbed {
                self.object.delete(&meta.location).await?;
                deleted += 1;
            }
        }
        Ok(deleted)
    }

    /// Snapshot-grained retention: drop `retained` runs older than the
    /// snapshot window (object mtime stands in for history age, as today),
    /// keeping any run still needed by a named checkpoint. The fine window
    /// is enforced by the version-retention floor handed to `Db::compact`.
    pub async fn prune_retention(
        &self,
        uuid: &str,
        snapshot_retention: std::time::Duration,
    ) -> Result<usize> {
        let prefix = ObjPath::from(format!("{}/{uuid}/branches", self.root));
        let keys: Vec<ObjPath> = self
            .object
            .list(Some(&prefix))
            .map_ok(|m| m.location)
            .try_collect()
            .await?;
        let now_ms = crate::now_ms();
        let cutoff_ms = now_ms - snapshot_retention.as_millis() as i64;
        let mut pruned = 0;
        for mk in keys {
            let r = self.object.get(&mk).await?;
            let version = object_store::UpdateVersion {
                e_tag: r.meta.e_tag.clone(),
                version: r.meta.version.clone(),
            };
            let bytes = r.bytes().await?;
            let mut m: Manifest = serde_json::from_slice(&bytes)
                .map_err(|e| StrataError::Corrupt(format!("manifest decode: {e}")))?;
            if m.retained.is_empty() {
                continue;
            }
            let pin = m.checkpoints.values().copied().min();
            let mut keep = Vec::new();
            let before = m.retained.len();
            for r in m.retained.drain(..) {
                // A checkpointed txid stays restorable regardless of age.
                let pinned = pin.is_some_and(|p| p <= r.max_txid);
                let fresh = match self.object.head(&ObjPath::from(r.key.clone())).await {
                    Ok(meta) => meta.last_modified.timestamp_millis() > cutoff_ms,
                    Err(object_store::Error::NotFound { .. }) => false,
                    Err(e) => return Err(e.into()),
                };
                if pinned || fresh {
                    keep.push(r);
                }
            }
            m.retained = keep;
            let after = m.retained.len();
            if after == before {
                continue;
            }
            match manifest::store_manifest(&self.object, &self.root, uuid, &m, Some(version)).await
            {
                Ok(()) => pruned += before - after,
                Err(StrataError::CasConflict) => continue, // raced a flush
                Err(e) => return Err(e),
            }
        }
        Ok(pruned)
    }

    /// Drop manifest references to history strictly below `txid` on one
    /// branch (the manifest half of erasure; `Db::erase_below` runs the
    /// filtered compaction first). Ported outcomes.
    pub async fn prune_before(
        &self,
        uuid: &str,
        branch: &str,
        txid: Txid,
    ) -> Result<PruneBeforeOutcome> {
        let Some((mut m, version)) =
            manifest::load_versioned(&self.object, &self.root, uuid, branch).await?
        else {
            return Err(StrataError::BranchNotFound(branch.to_string()));
        };
        let blockers: Vec<String> = m
            .checkpoints
            .iter()
            .filter(|(_, &t)| t < txid)
            .map(|(name, _)| name.clone())
            .collect();
        if !blockers.is_empty() {
            return Ok(PruneBeforeOutcome::Blocked {
                checkpoints: blockers,
            });
        }
        if m.segments.iter().any(|s| s.min_txid < txid) {
            // Live history below the floor still exists — the filtered
            // compaction must rewrite it first.
            return Ok(PruneBeforeOutcome::NeedsCompaction);
        }
        let before = m.retained.len();
        m.retained.retain(|s| s.min_txid >= txid);
        let after = m.retained.len();
        if after == before {
            return Ok(PruneBeforeOutcome::AlreadyClean);
        }
        manifest::store_manifest(&self.object, &self.root, uuid, &m, Some(version)).await?;
        Ok(PruneBeforeOutcome::Pruned(before - after))
    }

    /// Prove no history below `txid` remains for this database: manifests
    /// reference nothing below it, and — because object keys encode txids —
    /// no segment or WAL object below it exists, referenced or not. Absence
    /// is provable by listing (ported shape).
    pub async fn verify_erased_before(&self, uuid: &str, txid: Txid) -> Result<ErasureEvidence> {
        let mut ev = ErasureEvidence {
            manifests_checked: 0,
            objects_listed: 0,
            oldest_segment_min_txid: None,
            oldest_wal_first_txid: None,
            clean: true,
        };
        for m in self.branch_manifests(uuid).await? {
            ev.manifests_checked += 1;
            for s in m.segments.iter().chain(&m.retained) {
                ev.note_segment(s.min_txid, txid);
            }
        }
        let seg_prefix = ObjPath::from(format!("{}/{uuid}/seg", self.root));
        let keys: Vec<ObjPath> = self
            .object
            .list(Some(&seg_prefix))
            .map_ok(|m| m.location)
            .try_collect()
            .await?;
        for key in keys {
            ev.objects_listed += 1;
            match key_leading_txid(key.as_ref()) {
                Some(t) => ev.note_segment(t, txid),
                None => ev.clean = false,
            }
        }
        let wal_prefix = ObjPath::from(format!("{}/{uuid}/wal", self.root));
        let keys: Vec<ObjPath> = self
            .object
            .list(Some(&wal_prefix))
            .map_ok(|m| m.location)
            .try_collect()
            .await?;
        for key in keys {
            ev.objects_listed += 1;
            match manifest::parse_wal_key(key.as_ref()) {
                Some((_, first_txid)) => ev.note_wal(first_txid, txid),
                None => ev.clean = false,
            }
        }
        Ok(ev)
    }

    /// Delete every object under a database prefix (database deletion).
    pub async fn delete_db(&self, uuid: &str) -> Result<()> {
        let prefix = ObjPath::from(format!("{}/{uuid}", self.root));
        let keys: Vec<ObjPath> = self
            .object
            .list(Some(&prefix))
            .map_ok(|m| m.location)
            .try_collect()
            .await?;
        for key in keys {
            self.object.delete(&key).await?;
        }
        Ok(())
    }
}

/// Result of the manifest half of an erasure pass (ported outcomes; `NoBase`
/// became `NeedsCompaction` — the new engine rewrites instead of re-basing).
#[derive(Debug, PartialEq)]
pub enum PruneBeforeOutcome {
    Pruned(usize),
    AlreadyClean,
    Blocked { checkpoints: Vec<String> },
    NeedsCompaction,
}

/// What `verify_erased_before` saw — the receipt's evidence (ported shape).
#[derive(Debug, serde::Serialize)]
pub struct ErasureEvidence {
    pub manifests_checked: usize,
    pub objects_listed: usize,
    pub oldest_segment_min_txid: Option<Txid>,
    pub oldest_wal_first_txid: Option<Txid>,
    pub clean: bool,
}

impl ErasureEvidence {
    fn note_segment(&mut self, seen: Txid, floor: Txid) {
        self.oldest_segment_min_txid =
            Some(self.oldest_segment_min_txid.map_or(seen, |o| o.min(seen)));
        if seen < floor {
            self.clean = false;
        }
    }
    fn note_wal(&mut self, seen: Txid, floor: Txid) {
        self.oldest_wal_first_txid = Some(self.oldest_wal_first_txid.map_or(seen, |o| o.min(seen)));
        if seen < floor {
            self.clean = false;
        }
    }
}

fn apply_replayed(mem: &mut Memtable, head: Txid, rec: &LogRecord) -> Result<Txid> {
    if rec.txid <= head {
        return Ok(head); // already absorbed (overlap with a flushed prefix)
    }
    if rec.txid != head + 1 {
        return Err(StrataError::Corrupt(format!(
            "wal chain gap: head {head}, next record txid {}",
            rec.txid
        )));
    }
    for req in &rec.requests {
        mem.apply(rec.txid, req);
    }
    Ok(rec.txid)
}

// ---- Db: the owned writer ----

struct PendingWrite {
    req: WriteRequest,
    durability: Durability,
    tx: oneshot::Sender<Result<(WriteOutput, Txid)>>,
}

struct DbInner {
    mem: Memtable,
    head: Txid,
    manifest: Manifest,
    segs: Vec<Arc<DecodedSegment>>,
    log: LocalLog,
    /// Records fsynced locally but not yet in a WAL chunk or segment.
    unshipped: Vec<LogRecord>,
    next_seq: u64,
}

struct DbShared {
    store: Arc<Store>,
    uuid: String,
    branch: String,
    epoch: u64,
    fenced: AtomicBool,
    pending: StdMutex<VecDeque<PendingWrite>>,
    inner: AsyncMutex<DbInner>,
}

/// An open writer handle for one branch. Cloneable; all clones share the
/// single writer queue (single writer per database, by construction).
#[derive(Clone)]
pub struct Db {
    shared: Arc<DbShared>,
}

impl Db {
    pub async fn head(&self) -> Txid {
        self.shared.inner.lock().await.head
    }

    /// Submit one typed request. Group commit: concurrent submitters share a
    /// round and its txid; per-request staging failures fail that request
    /// alone (the savepoint replacement).
    pub async fn submit(
        &self,
        req: WriteRequest,
        durability: Durability,
    ) -> Result<(WriteOutput, Txid)> {
        if self.shared.fenced.load(AtomicOrdering::SeqCst) {
            return Err(StrataError::ZombieFenced {
                manifest_epoch: 0,
                writer_epoch: self.shared.epoch,
            });
        }
        let (tx, mut rx) = oneshot::channel();
        self.shared
            .pending
            .lock()
            .expect("pending lock")
            .push_back(PendingWrite {
                req,
                durability,
                tx,
            });
        loop {
            tokio::select! {
                biased;
                res = &mut rx => {
                    return res.map_err(|_| StrataError::Invalid("writer dropped the request".into()))?;
                }
                mut inner = self.shared.inner.lock() => {
                    self.run_round(&mut inner).await;
                    drop(inner);
                    match rx.try_recv() {
                        Ok(res) => return res,
                        Err(oneshot::error::TryRecvError::Empty) => continue,
                        Err(oneshot::error::TryRecvError::Closed) => {
                            return Err(StrataError::Invalid("writer dropped the request".into()));
                        }
                    }
                }
            }
        }
    }

    /// Enqueue several requests and drive rounds until the queue drains —
    /// the deterministic way to exercise round sharing (concurrent `submit`
    /// callers get the same behavior nondeterministically).
    pub async fn submit_many(&self, reqs: Vec<WriteRequest>) -> Vec<Result<(WriteOutput, Txid)>> {
        let mut rxs = Vec::with_capacity(reqs.len());
        {
            let mut q = self.shared.pending.lock().expect("pending lock");
            for req in reqs {
                let (tx, rx) = oneshot::channel();
                q.push_back(PendingWrite {
                    req,
                    durability: Durability::Standard,
                    tx,
                });
                rxs.push(rx);
            }
        }
        {
            let mut inner = self.shared.inner.lock().await;
            while !self.shared.pending.lock().expect("pending lock").is_empty() {
                self.run_round(&mut inner).await;
            }
        }
        let mut out = Vec::with_capacity(rxs.len());
        for rx in rxs {
            out.push(match rx.await {
                Ok(res) => res,
                Err(_) => Err(StrataError::Invalid("writer dropped the request".into())),
            });
        }
        out
    }

    /// Drain one group-commit round: stage sequentially against the round
    /// overlay, write one log record, fsync (Standard commit point), ship
    /// synchronously if any participant escalated, apply, answer everyone.
    async fn run_round(&self, inner: &mut DbInner) {
        let drained: Vec<PendingWrite> = {
            let mut q = self.shared.pending.lock().expect("pending lock");
            let n = q.len().min(ROUND_MAX);
            q.drain(..n).collect()
        };
        if drained.is_empty() {
            return;
        }

        let mut overlay = Overlay::new();
        let mut staged: Vec<(PendingWrite, Vec<crate::Op>, WriteOutput)> = Vec::new();
        let mut durable = false;
        for p in drained {
            let view = View {
                overlay: Some(&overlay),
                mem: &inner.mem,
                segments: &inner.segs,
                at: inner.head,
            };
            match stage(&view, &p.req) {
                Ok((ops, out)) => {
                    for op in &ops {
                        match op {
                            crate::Op::Put { key, value } => {
                                overlay.insert(key.clone(), Some(value.clone()));
                            }
                            crate::Op::Del { key } => {
                                overlay.insert(key.clone(), None);
                            }
                        }
                    }
                    durable |= p.durability == Durability::Durable;
                    staged.push((p, ops, out));
                }
                Err(e) => {
                    let _ = p.tx.send(Err(e));
                }
            }
        }
        if staged.is_empty() {
            return;
        }
        let total_ops: usize = staged.iter().map(|(_, ops, _)| ops.len()).sum();
        if total_ops == 0 {
            // Nothing changed (e.g. all duplicates): no record, no txid bump
            // — the ported "txid bumps iff rows changed" rule.
            let head = inner.head;
            for (p, _, out) in staged {
                let _ = p.tx.send(Ok((out, head)));
            }
            return;
        }

        let txid = inner.head + 1;
        let record = LogRecord {
            flags: 0,
            epoch: self.shared.epoch,
            txid,
            requests: staged.iter().map(|(_, ops, _)| ops.clone()).collect(),
        };
        if let Err(e) = inner.log.append_fsync(&record) {
            let msg = e.to_string();
            for (p, _, _) in staged {
                let _ =
                    p.tx.send(Err(StrataError::Io(std::io::Error::other(msg.clone()))));
            }
            return;
        }

        if durable {
            // One conditional PUT of the pending tail — the durable-mode
            // fence. AlreadyExists means we have been fenced: never ack.
            let mut records = inner.unshipped.clone();
            records.push(record.clone());
            let header = ChunkHeader {
                format: 1,
                branch: self.shared.branch.clone(),
                epoch: self.shared.epoch,
                seq: inner.next_seq,
                first_txid: records[0].txid,
                last_txid: txid,
            };
            match wal::put_chunk(
                &self.shared.store.object,
                &self.shared.store.root,
                &self.shared.uuid,
                &header,
                &records,
            )
            .await
            {
                Ok(true) => {
                    inner.next_seq += 1;
                    inner.unshipped.clear();
                }
                Ok(false) => {
                    self.shared.fenced.store(true, AtomicOrdering::SeqCst);
                    for (p, _, _) in staged {
                        let _ = p.tx.send(Err(StrataError::ZombieFenced {
                            manifest_epoch: 0,
                            writer_epoch: self.shared.epoch,
                        }));
                    }
                    return;
                }
                Err(e) => {
                    let msg = e.to_string();
                    for (p, _, _) in staged {
                        let _ = p.tx.send(Err(StrataError::Corrupt(msg.clone())));
                    }
                    return;
                }
            }
        } else {
            inner.unshipped.push(record.clone());
        }

        for req_ops in &record.requests {
            inner.mem.apply(txid, req_ops);
        }
        inner.head = txid;
        for (p, _, out) in staged {
            let _ = p.tx.send(Ok((out, txid)));
        }
    }

    /// Read through a consistent view at the current head.
    pub async fn with_view<R>(&self, f: impl FnOnce(&View<'_>) -> R) -> R {
        let inner = self.shared.inner.lock().await;
        let view = View {
            overlay: None,
            mem: &inner.mem,
            segments: &inner.segs,
            at: inner.head,
        };
        f(&view)
    }

    /// Ship the unshipped record tail as one WAL chunk (the Standard-mode
    /// background flusher's job; explicit in the prototype).
    pub async fn ship(&self) -> Result<()> {
        let mut inner = self.shared.inner.lock().await;
        if inner.unshipped.is_empty() {
            return Ok(());
        }
        let records = inner.unshipped.clone();
        let header = ChunkHeader {
            format: 1,
            branch: self.shared.branch.clone(),
            epoch: self.shared.epoch,
            seq: inner.next_seq,
            first_txid: records[0].txid,
            last_txid: records.last().expect("non-empty").txid,
        };
        if wal::put_chunk(
            &self.shared.store.object,
            &self.shared.store.root,
            &self.shared.uuid,
            &header,
            &records,
        )
        .await?
        {
            inner.next_seq += 1;
            inner.unshipped.clear();
            Ok(())
        } else {
            self.shared.fenced.store(true, AtomicOrdering::SeqCst);
            Err(StrataError::ZombieFenced {
                manifest_epoch: 0,
                writer_epoch: self.shared.epoch,
            })
        }
    }

    /// Flush: memtable → one L0 segment + one manifest CAS that advances the
    /// WAL floor; the local log truncates (everything is now in a segment).
    pub async fn flush(&self) -> Result<()> {
        let mut inner = self.shared.inner.lock().await;
        self.flush_inner(&mut inner).await
    }

    async fn flush_inner(&self, inner: &mut DbInner) -> Result<()> {
        if inner.mem.is_empty() && inner.unshipped.is_empty() {
            // Still advance the floor over any shipped-but-unabsorbed chunks.
            if inner.manifest.wal_floor_seq + 1 < inner.next_seq {
                let floor = inner.next_seq - 1;
                let head = inner.head;
                self.commit_manifest(inner, |m| {
                    m.wal_floor_seq = floor;
                    m.head_txid = head;
                })
                .await?;
            }
            return Ok(());
        }
        let min_txid = inner.mem.min_txid().unwrap_or(inner.head);
        let max_txid = inner.mem.max_txid().unwrap_or(inner.head);
        let entries: Vec<Entry> = inner
            .mem
            .all_versions()
            .map(|(k, t, v)| Entry {
                key: k.to_vec(),
                txid: t,
                value: v.map(|b| b.to_vec()),
            })
            .collect();
        let (bytes, header) = segment::encode(&entries, min_txid, max_txid, 0)?;
        let key = segment_key(
            &self.shared.store.root,
            &self.shared.uuid,
            min_txid,
            max_txid,
            0,
        );
        self.shared
            .store
            .object
            .put(
                &ObjPath::from(key.clone()),
                PutPayload::from(Bytes::from(bytes)),
            )
            .await?;
        let seg_ref = SegmentRef {
            min_txid,
            max_txid,
            key: key.clone(),
            level: 0,
            key_min: header.key_min.clone(),
            key_max: header.key_max.clone(),
            entry_count: header.entry_count,
            bytes: 0,
        };
        let floor = inner.next_seq - 1;
        let head = inner.head;
        let sr = seg_ref.clone();
        self.commit_manifest(inner, move |m| {
            m.segments.push(sr.clone());
            m.head_txid = head;
            m.wal_floor_seq = floor;
        })
        .await?;
        let decoded = self.shared.store.load_segment(&key).await?;
        inner.segs.push(decoded);
        inner.mem.clear();
        inner.unshipped.clear();
        inner.log.truncate()?;
        Ok(())
    }

    /// CAS-commit a manifest edit, retrying on transient conflict (reload +
    /// re-fence + re-apply — the ported commit loop).
    async fn commit_manifest(
        &self,
        inner: &mut DbInner,
        edit: impl Fn(&mut Manifest),
    ) -> Result<()> {
        let store = &self.shared.store;
        for attempt in 0..=COMMIT_RETRIES {
            let loaded = manifest::load_versioned(
                &store.object,
                &store.root,
                &self.shared.uuid,
                &self.shared.branch,
            )
            .await?
            .ok_or_else(|| StrataError::BranchNotFound(self.shared.branch.clone()))?;
            let (mut m, v) = loaded;
            m.fence(self.shared.epoch)?;
            edit(&mut m);
            match manifest::store_manifest(
                &store.object,
                &store.root,
                &self.shared.uuid,
                &m,
                Some(v),
            )
            .await
            {
                Ok(()) => {
                    inner.manifest = m;
                    return Ok(());
                }
                Err(StrataError::CasConflict) if attempt < COMMIT_RETRIES => continue,
                Err(e) => return Err(e),
            }
        }
        Err(StrataError::CasConflict)
    }

    /// Name the current head as a checkpoint (flush-if-dirty first).
    pub async fn checkpoint(&self, name: &str) -> Result<Txid> {
        let mut inner = self.shared.inner.lock().await;
        self.flush_inner(&mut inner).await?;
        let head = inner.head;
        let name = name.to_string();
        self.commit_manifest(&mut inner, move |m| {
            m.checkpoints.insert(name.clone(), head);
        })
        .await?;
        Ok(head)
    }

    /// Fork this branch at its head (flushes first; O(1) manifest create).
    pub async fn fork(&self, child: &str, ttl_at: Option<i64>) -> Result<Manifest> {
        let mut inner = self.shared.inner.lock().await;
        self.flush_inner(&mut inner).await?;
        drop(inner);
        self.shared
            .store
            .fork(&self.shared.uuid, &self.shared.branch, child, ttl_at)
            .await
    }

    /// Rewind to a checkpoint name or txid — any txid at or below the head.
    /// Flushes first; the memtable is reconstructible, never authoritative.
    pub async fn rewind(&self, to: &str) -> Result<Txid> {
        let mut inner = self.shared.inner.lock().await;
        self.flush_inner(&mut inner).await?;
        let target = match inner.manifest.checkpoints.get(to) {
            Some(t) => *t,
            None => to
                .parse::<Txid>()
                .map_err(|_| StrataError::BranchNotFound(format!("checkpoint {to}")))?,
        };
        if target > inner.head {
            return Err(StrataError::Invalid(format!(
                "rewind target {target} is beyond head {}",
                inner.head
            )));
        }
        self.commit_manifest(&mut inner, move |m| {
            m.head_txid = target;
            // Runs entirely above the target dereference (objects fall to
            // GC); straddling runs stay — the read clamp masks them.
            m.segments.retain(|s| s.min_txid <= target);
        })
        .await?;
        inner.head = target;
        inner.mem.clear();
        inner.unshipped.clear();
        inner.log.truncate()?;
        let manifest_segments = inner.manifest.segments.clone();
        inner.segs = self.shared.store.load_segments(&manifest_segments).await?;
        Ok(target)
    }

    /// Full-merge compaction with a version-retention floor
    /// (F = min(PITR fine floor, oldest checkpoint, oldest child fork) — the
    /// caller computes F from control-plane state; checkpoints are clamped
    /// here from the manifest).
    pub async fn compact(&self, version_floor: Txid) -> Result<()> {
        let mut inner = self.shared.inner.lock().await;
        self.flush_inner(&mut inner).await?;
        if inner.segs.len() <= 1 {
            return Ok(());
        }
        let floor = inner
            .manifest
            .checkpoints
            .values()
            .copied()
            .min()
            .map_or(version_floor, |c| version_floor.min(c));
        let entries = compact::merge(&inner.segs, inner.head, Mode::Merge { floor });
        self.swap_segments(&mut inner, entries, 2, true).await
    }

    /// Erasure: rewrite history below `txid` through the filtered compaction
    /// — erased keys are simply not written; pre-`txid` retained refs drop.
    /// Blocked by checkpoints pinning history below `txid` (ported outcome).
    pub async fn erase_below(&self, txid: Txid) -> Result<()> {
        let mut inner = self.shared.inner.lock().await;
        self.flush_inner(&mut inner).await?;
        let blockers: Vec<String> = inner
            .manifest
            .checkpoints
            .iter()
            .filter(|(_, &t)| t < txid)
            .map(|(n, _)| n.clone())
            .collect();
        if !blockers.is_empty() {
            return Err(StrataError::ErasureBlocked(blockers));
        }
        let needs_rewrite = inner.segs.iter().any(|s| s.header.min_txid < txid)
            || !inner.manifest.retained.is_empty();
        if !needs_rewrite {
            return Ok(());
        }
        let entries = compact::merge(&inner.segs, inner.head, Mode::EraseBelow { txid });
        self.swap_segments_erase(&mut inner, entries, txid).await
    }

    async fn swap_segments(
        &self,
        inner: &mut DbInner,
        entries: Vec<Entry>,
        level: u8,
        retain_old: bool,
    ) -> Result<()> {
        let new_ref = if entries.is_empty() {
            None
        } else {
            let min = entries.iter().map(|e| e.txid).min().expect("non-empty");
            let max = inner
                .head
                .max(entries.iter().map(|e| e.txid).max().expect("non-empty"));
            let (bytes, header) = segment::encode(&entries, min, max, level)?;
            let key = segment_key(&self.shared.store.root, &self.shared.uuid, min, max, level);
            self.shared
                .store
                .object
                .put(
                    &ObjPath::from(key.clone()),
                    PutPayload::from(Bytes::from(bytes)),
                )
                .await?;
            Some(SegmentRef {
                min_txid: min,
                max_txid: max,
                key,
                level,
                key_min: header.key_min,
                key_max: header.key_max,
                entry_count: header.entry_count,
                bytes: 0,
            })
        };
        let nr = new_ref.clone();
        self.commit_manifest(inner, move |m| {
            let old = std::mem::take(&mut m.segments);
            if retain_old {
                // Replaced full-coverage inputs become the snapshot-grained
                // PITR tier (09 § compaction).
                m.retained.extend(old);
            }
            if let Some(r) = &nr {
                m.segments.push(r.clone());
            }
        })
        .await?;
        let manifest_segments = inner.manifest.segments.clone();
        inner.segs = self.shared.store.load_segments(&manifest_segments).await?;
        Ok(())
    }

    async fn swap_segments_erase(
        &self,
        inner: &mut DbInner,
        entries: Vec<Entry>,
        erase_txid: Txid,
    ) -> Result<()> {
        let new_ref = if entries.is_empty() {
            None
        } else {
            let min = entries.iter().map(|e| e.txid).min().expect("non-empty");
            debug_assert!(min >= erase_txid);
            let max = inner
                .head
                .max(entries.iter().map(|e| e.txid).max().expect("non-empty"));
            let (bytes, header) = segment::encode(&entries, min, max, 2)?;
            let key = segment_key(&self.shared.store.root, &self.shared.uuid, min, max, 2);
            self.shared
                .store
                .object
                .put(
                    &ObjPath::from(key.clone()),
                    PutPayload::from(Bytes::from(bytes)),
                )
                .await?;
            Some(SegmentRef {
                min_txid: min,
                max_txid: max,
                key,
                level: 2,
                key_min: header.key_min,
                key_max: header.key_max,
                entry_count: header.entry_count,
                bytes: 0,
            })
        };
        let nr = new_ref.clone();
        self.commit_manifest(inner, move |m| {
            // Erased history is dereferenced entirely — never retained.
            m.segments.clear();
            m.retained.retain(|s| s.min_txid >= erase_txid);
            if let Some(r) = &nr {
                m.segments.push(r.clone());
            }
        })
        .await?;
        let manifest_segments = inner.manifest.segments.clone();
        inner.segs = self.shared.store.load_segments(&manifest_segments).await?;
        Ok(())
    }
}

// ---- Replica ----

/// A stateless reader: manifest + replayed WAL tail. Eventually consistent;
/// `head()` is the achieved txid for `min_txid` read-your-writes checks.
pub struct Replica {
    mem: Memtable,
    segs: Vec<Arc<DecodedSegment>>,
    head: Txid,
}

impl Replica {
    pub fn head(&self) -> Txid {
        self.head
    }

    pub fn with_view<R>(&self, f: impl FnOnce(&View<'_>) -> R) -> R {
        let view = View {
            overlay: None,
            mem: &self.mem,
            segments: &self.segs,
            at: self.head,
        };
        f(&view)
    }

    /// Read clamped at an earlier txid (fork-point or PITR reads).
    pub fn with_view_at<R>(&self, at: Txid, f: impl FnOnce(&View<'_>) -> R) -> R {
        let view = View {
            overlay: None,
            mem: &self.mem,
            segments: &self.segs,
            at: at.min(self.head),
        };
        f(&view)
    }
}
