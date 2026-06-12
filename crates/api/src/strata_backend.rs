//! The strata engine behind a flag (ADR-0011 graduation step): databases
//! selected by `MEMOTURN_STRATA_NAMESPACES` serve their typed surfaces
//! (memory/KV/docs/transcripts) from `memoturn-strata` instead of libSQL.
//!
//! Selection is per-database: only `{ns}--{profile}` memory databases whose
//! namespace is listed (or `*` for all memory profiles) are affected — plain
//! databases and every unlisted namespace stay on libSQL untouched. The two
//! engines share the object store but use disjoint roots (`v1` vs
//! `v2-strata`), so the libSQL replicator's GC/retention/erasure passes never
//! see (or misparse) strata manifests.
//!
//! Routing reuses the standard plumbing: registry name→uuid, branch
//! existence, and the control-plane owner lease all resolve exactly as for
//! libSQL databases; only the storage calls differ. Writes on the owner go
//! through the strata group-commit writer (durability escalation maps to the
//! engine's Durable mode — one conditional WAL-chunk PUT before ack); reads
//! elsewhere are stateless replicas over manifest + WAL tail.
//!
//! Deliberately not wired in this step (each returns a clear error instead):
//! `/sql` (no SQL dialect on this engine), standalone vector collections
//! (memory embeddings ride ingest), and verifiable-erasure coupons.

use crate::error::{ApiError, ErrorCode};
use crate::AppState;
use axum::http::StatusCode;
use memoturn_control::Owner;
use memoturn_strata::{Db, Durability, Replica, Store, StrataError, WriteOutput, WriteRequest};
use object_store::ObjectStore;
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use tokio::sync::Mutex as AsyncMutex;

/// Object-store root for strata databases — disjoint from the libSQL
/// replicator's `v1` so neither engine's maintenance passes read the other's
/// manifests.
pub const STRATA_ROOT: &str = "v2-strata";

#[derive(Debug, Clone)]
enum Selection {
    /// `*`: every `{ns}--{profile}` memory database.
    AllProfiles,
    /// Listed namespaces only.
    Namespaces(HashSet<String>),
}

pub struct StrataHost {
    selection: Selection,
    pub store: Arc<Store>,
    /// Owned writer handles, keyed `uuid@branch` (single writer per branch).
    dbs: AsyncMutex<HashMap<String, Db>>,
}

impl StrataHost {
    /// Read `MEMOTURN_STRATA_NAMESPACES` (`*` or a comma-separated namespace
    /// list); absent/empty = the flag is off and this returns `None`.
    pub fn from_env(
        object: Arc<dyn ObjectStore>,
        data_dir: impl Into<std::path::PathBuf>,
    ) -> Option<Arc<Self>> {
        let raw = std::env::var("MEMOTURN_STRATA_NAMESPACES").ok()?;
        let raw = raw.trim();
        if raw.is_empty() {
            return None;
        }
        let selection = if raw == "*" {
            Selection::AllProfiles
        } else {
            Selection::Namespaces(
                raw.split(',')
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty())
                    .collect(),
            )
        };
        Some(Self::with_selection(
            selection_to_string(&selection),
            object,
            data_dir,
        ))
    }

    /// Explicit construction for tests: `spec` is `*` or a namespace list.
    pub fn with_selection(
        spec: String,
        object: Arc<dyn ObjectStore>,
        data_dir: impl Into<std::path::PathBuf>,
    ) -> Arc<Self> {
        let selection = if spec == "*" {
            Selection::AllProfiles
        } else {
            Selection::Namespaces(spec.split(',').map(|s| s.trim().to_string()).collect())
        };
        let host = Arc::new(Self {
            selection,
            store: Store::new(object, STRATA_ROOT, data_dir),
            dbs: AsyncMutex::new(HashMap::new()),
        });
        host.spawn_flusher(std::time::Duration::from_millis(200));
        host
    }

    /// The background flusher: every owned handle ships its unshipped record
    /// tail on a debounced interval — the Standard-mode durability loop
    /// (≤200 ms RPO window, matching the libSQL shipper's posture). Ship is a
    /// no-op when nothing is pending; a fenced zombie's ship fails silently
    /// by design. The task holds a weak ref and ends when the host drops.
    fn spawn_flusher(self: &Arc<Self>, interval: std::time::Duration) {
        let weak = Arc::downgrade(self);
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(interval).await;
                let Some(host) = weak.upgrade() else { break };
                let dbs: Vec<Db> = host.dbs.lock().await.values().cloned().collect();
                for db in dbs {
                    let _ = db.ship().await;
                }
            }
        });
    }

    /// Owned writer handles, keyed `uuid@branch` (the maintenance sweeps
    /// iterate these — only branches this node owns may be swept).
    pub async fn owned(&self) -> Vec<(String, Db)> {
        self.dbs
            .lock()
            .await
            .iter()
            .map(|(k, d)| (k.clone(), d.clone()))
            .collect()
    }

    /// Does this database run on strata? Only `{ns}--{profile}` memory
    /// databases are ever selected.
    pub fn selects(&self, db_name: &str) -> bool {
        let Some((ns, _)) = db_name.split_once("--") else {
            return false;
        };
        match &self.selection {
            Selection::AllProfiles => true,
            Selection::Namespaces(set) => set.contains(ns),
        }
    }

    async fn open(&self, uuid: &str, branch: &str, reacquired: bool) -> Result<Db, ApiError> {
        let key = format!("{uuid}@{branch}");
        let mut dbs = self.dbs.lock().await;
        if reacquired {
            // The lease lapsed and came back: a cached handle may have been
            // fenced by an interim owner — reopen from object storage.
            dbs.remove(&key);
        }
        if let Some(db) = dbs.get(&key) {
            return Ok(db.clone());
        }
        // Provisioning is one manifest create-if-absent; idempotent.
        self.store.create_db(uuid).await?;
        let db = self.store.open(uuid, branch).await?;
        dbs.insert(key, db.clone());
        Ok(db)
    }

    pub async fn cached(&self, uuid: &str, branch: &str) -> Option<Db> {
        self.dbs
            .lock()
            .await
            .get(&format!("{uuid}@{branch}"))
            .cloned()
    }

    pub async fn evict_branch(&self, uuid: &str, branch: &str) {
        self.dbs.lock().await.remove(&format!("{uuid}@{branch}"));
    }

    pub async fn evict_db(&self, uuid: &str) {
        let prefix = format!("{uuid}@");
        self.dbs.lock().await.retain(|k, _| !k.starts_with(&prefix));
    }
}

fn selection_to_string(s: &Selection) -> String {
    match s {
        Selection::AllProfiles => "*".to_string(),
        Selection::Namespaces(set) => set.iter().cloned().collect::<Vec<_>>().join(","),
    }
}

impl From<StrataError> for ApiError {
    fn from(e: StrataError) -> Self {
        let (status, code) = match &e {
            StrataError::Invalid(_) => (StatusCode::BAD_REQUEST, ErrorCode::InvalidRequest),
            StrataError::BranchNotFound(_) => (StatusCode::NOT_FOUND, ErrorCode::BranchNotFound),
            StrataError::CasConflict | StrataError::ZombieFenced { .. } => {
                (StatusCode::CONFLICT, ErrorCode::Conflict)
            }
            StrataError::ErasureBlocked(_) => (StatusCode::CONFLICT, ErrorCode::Conflict),
            _ => (StatusCode::INTERNAL_SERVER_ERROR, ErrorCode::Internal),
        };
        ApiError::new(status, e.to_string()).with_code(code)
    }
}

/// The strata route surfaced to handlers when this database runs on strata
/// (same control-plane resolution as `resolve_write`, different engine).
pub enum SRoute {
    Remote { addr: String },
    Local(Db),
}

pub async fn route_write(
    state: &AppState,
    host: &StrataHost,
    spec: &str,
) -> Result<SRoute, ApiError> {
    let (name, branch) = crate::parse_spec(spec);
    let rec = state.registry.get(name).await?;
    if !state.registry.branch_exists(name, branch).await? {
        return Err(
            ApiError::new(StatusCode::NOT_FOUND, format!("branch not found: {branch}"))
                .with_code(ErrorCode::BranchNotFound),
        );
    }
    let key = format!("{}@{branch}", rec.uuid);
    match state.control.resolve_owner(&key).await? {
        Owner::Remote(o) => Ok(SRoute::Remote { addr: o.addr }),
        Owner::Local { acquired, .. } => {
            Ok(SRoute::Local(host.open(&rec.uuid, branch, acquired).await?))
        }
    }
}

/// A read source: the owned writer (sees everything) or a stateless replica
/// snapshot over manifest + WAL tail (the standard eventual-consistency
/// contract — Standard-mode writes appear once shipped).
pub enum SRead {
    Owned(Db),
    Snapshot(Box<Replica>),
}

impl SRead {
    pub async fn head(&self) -> u64 {
        match self {
            SRead::Owned(db) => db.head().await,
            SRead::Snapshot(r) => r.head(),
        }
    }

    pub async fn with_view<R>(&self, f: impl FnOnce(&memoturn_strata::View<'_>) -> R) -> R {
        match self {
            SRead::Owned(db) => db.with_view(f).await,
            SRead::Snapshot(r) => r.with_view(f),
        }
    }
}

pub async fn route_read(
    state: &AppState,
    host: &StrataHost,
    spec: &str,
) -> Result<SRead, ApiError> {
    let (name, branch) = crate::parse_spec(spec);
    let rec = state.registry.get(name).await?;
    if !state.registry.branch_exists(name, branch).await? {
        return Err(
            ApiError::new(StatusCode::NOT_FOUND, format!("branch not found: {branch}"))
                .with_code(ErrorCode::BranchNotFound),
        );
    }
    if let Some(db) = host.cached(&rec.uuid, branch).await {
        return Ok(SRead::Owned(db));
    }
    match host.store.replica(&rec.uuid, branch).await {
        Ok(r) => Ok(SRead::Snapshot(Box::new(r))),
        // Never written: an empty profile reads as empty, not 404 (reads
        // never create — the same posture as the libSQL path).
        Err(StrataError::BranchNotFound(_)) if branch == "main" => {
            host.store.create_db(&rec.uuid).await?;
            Ok(SRead::Snapshot(Box::new(
                host.store.replica(&rec.uuid, branch).await?,
            )))
        }
        Err(e) => Err(e.into()),
    }
}

/// Submit one typed write with the request's effective durability. Durable
/// acks ride the engine's conditional WAL-chunk PUT before returning;
/// Standard writes are acked on the local-log fsync and shipped by the
/// host's background flusher (≤200 ms).
pub async fn submit(
    db: &Db,
    req: WriteRequest,
    durable: bool,
) -> Result<(WriteOutput, u64), ApiError> {
    let durability = if durable {
        Durability::Durable
    } else {
        Durability::Standard
    };
    Ok(db.submit(req, durability).await?)
}

fn unexpected_output() -> ApiError {
    ApiError::new(
        StatusCode::INTERNAL_SERVER_ERROR,
        "strata engine returned an unexpected output shape",
    )
}

pub fn expect_ids(out: WriteOutput) -> Result<Vec<String>, ApiError> {
    match out {
        WriteOutput::Ids(ids) => Ok(ids),
        _ => Err(unexpected_output()),
    }
}

pub fn expect_count(out: WriteOutput) -> Result<u64, ApiError> {
    match out {
        WriteOutput::Count(n) => Ok(n),
        _ => Err(unexpected_output()),
    }
}

pub fn expect_seq(out: WriteOutput) -> Result<u64, ApiError> {
    match out {
        WriteOutput::Seq(n) => Ok(n),
        _ => Err(unexpected_output()),
    }
}

pub fn expect_ingest(out: WriteOutput) -> Result<Vec<memoturn_strata::IngestOutcome>, ApiError> {
    match out {
        WriteOutput::MemIngest(outcomes) => Ok(outcomes),
        _ => Err(unexpected_output()),
    }
}

// ---- type conversions (the docstore types are the API-layer lingua franca;
// clamp_task_ttls / auto_embed_items operate on them before conversion) ----

pub fn to_strata_items(
    items: Vec<memoturn_docstore::memories::MemoryInput>,
) -> Result<Vec<memoturn_strata::MemoryInput>, ApiError> {
    items
        .into_iter()
        .map(|m| {
            Ok(memoturn_strata::MemoryInput {
                mtype: memoturn_strata::MemoryType::parse(m.mtype.as_str())?,
                topic_key: m.topic_key,
                summary: m.summary,
                content: m.content,
                keywords: m.keywords,
                embedding: m.embedding,
                session_id: m.session_id,
                source: m.source,
                ttl_secs: m.ttl_secs,
            })
        })
        .collect()
}

pub fn to_strata_types(
    types: Option<Vec<memoturn_docstore::memories::MemoryType>>,
) -> Result<Option<Vec<memoturn_strata::MemoryType>>, ApiError> {
    types
        .map(|ts| {
            ts.iter()
                .map(|t| Ok(memoturn_strata::MemoryType::parse(t.as_str())?))
                .collect::<Result<Vec<_>, ApiError>>()
        })
        .transpose()
}
