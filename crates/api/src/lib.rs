//! HTTP/JSON data-plane + (prototype) control-plane API.
//!
//! Production addresses databases by hostname (`{db}.{region}.memoturn.dev`);
//! the prototype uses path addressing (`/v1/db/{db}/...`) where `{db}` is a
//! spec `name[@branch]` (`@main` implicit). Every response that touches a
//! database carries the `Memoturn-Txid` header.
//!
//! Distribution (M4): writes resolve single-writer ownership through the
//! lease manager — unowned databases are acquired lazily (epoch+1), remote
//! ownership forwards the request to the owner node. Reads are served from
//! the local copy (replica semantics, txid disclosed); `Memoturn-Min-Txid`
//! forces a refresh from object storage for read-your-writes.

pub mod answer;
pub mod audit;
pub mod auth;
pub mod embed;
pub mod error;
pub mod extract;
pub mod governance;
pub mod limit;
pub mod mesh;
pub mod strata_backend;

use error::{ApiError, ErrorCode};

use axum::body::Bytes;
use axum::extract::{DefaultBodyLimit, Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use memoturn_control::{ControlError, LeaseManager, Owner};
use memoturn_engine::{guard_reserved, DbHandle, EngineError, NodeEngine, Registry, Stmt};
use memoturn_replication::{ReplicationError, Replicator, Shipper};
use serde::Deserialize;
use serde_json::json;
use std::collections::HashMap;
use std::sync::Arc;

#[derive(Clone)]
pub struct AppState {
    pub node: Arc<NodeEngine>,
    pub registry: Arc<Registry>,
    pub replicator: Arc<Replicator>,
    pub shipper: Arc<Shipper>,
    pub control: Arc<dyn LeaseManager>,
    pub mesh: Arc<mesh::Mesh>,
    pub auth: auth::Auth,
    pub http: reqwest::Client,
    /// Server-side memory extraction (None = unconfigured; endpoint 503s and
    /// extraction stays bring-your-own).
    pub extractor: Option<Arc<dyn extract::Extractor>>,
    /// Server-side auto-embedding (None = unconfigured; ingest/recall simply
    /// skip the vector channel for items/queries without BYO embeddings).
    pub embedder: Option<Arc<dyn embed::Embedder>>,
    /// Recall answer synthesis (None = unconfigured; the /ask endpoint 503s
    /// and clients synthesize from /recall themselves).
    pub answerer: Option<Arc<dyn answer::Answerer>>,
    /// Per-namespace data-governance policies (ADR-0010): retention/TTL caps
    /// and AI egress rules, authoritative in object storage.
    pub governance: Arc<governance::PolicyStore>,
    /// Where the configured embedder sends data (None = no embedder); decides
    /// the `ai_egress.embed = self_hosted_only` policy at startup.
    pub embed_provenance: Option<embed::EmbedProvenance>,
    /// Per-namespace audit stream (ADR-0010 phase 2). Always present;
    /// emission is gated by each namespace's `audit.enabled` policy.
    pub audit: Arc<audit::AuditSink>,
    /// Erasure coupons (ADR-0010 phase 3): durable records of verifiable
    /// erasures, in object storage outside any database's prefix.
    pub erasures: Arc<memoturn_governance::ErasureLedger>,
    /// The strata engine behind a flag (ADR-0011): `{ns}--{profile}` databases
    /// whose namespace is listed in `MEMOTURN_STRATA_NAMESPACES` serve their
    /// typed surfaces from `memoturn-strata` instead of libSQL. `None` = off.
    pub strata: Option<Arc<strata_backend::StrataHost>>,
}

/// Body cap for control/query requests (filters, recall, SQL queries). 1 MiB is
/// generous for any JSON command; oversized bodies get a 413 before allocation.
const DEFAULT_BODY_LIMIT: usize = 1 << 20; // 1 MiB

/// Body cap for data-bearing writes (ingest, upserts, SQL write batches, KV put).
/// Overridable via `MEMOTURN_MAX_BODY_BYTES`; defaults to 32 MiB.
fn large_body_limit() -> usize {
    std::env::var("MEMOTURN_MAX_BODY_BYTES")
        .ok()
        .and_then(|s| s.parse().ok())
        .filter(|n| *n > 0)
        .unwrap_or(32 << 20)
}

/// Per-request wall-clock budget; overridable via `MEMOTURN_REQUEST_TIMEOUT`
/// (seconds). A slow client past this gets a 408 and releases its slot.
fn request_timeout() -> std::time::Duration {
    let secs = std::env::var("MEMOTURN_REQUEST_TIMEOUT")
        .ok()
        .and_then(|s| s.parse().ok())
        .filter(|n| *n > 0)
        .unwrap_or(30);
    std::time::Duration::from_secs(secs)
}

/// Global in-flight request cap; overridable via `MEMOTURN_MAX_CONCURRENCY`.
/// Bounds memory/CPU under load; excess requests queue rather than pile up.
fn max_concurrency() -> usize {
    std::env::var("MEMOTURN_MAX_CONCURRENCY")
        .ok()
        .and_then(|s| s.parse().ok())
        .filter(|n| *n > 0)
        .unwrap_or(1024)
}

/// Hard ceiling on any client-requested result count (`limit`, recall/search
/// `k`). Prevents a single request from forcing the server to rank/return an
/// unbounded set; callers that want more must paginate.
pub const MAX_RESULT_LIMIT: u32 = 1000;

/// Clamp a client-supplied count to [`MAX_RESULT_LIMIT`].
fn capped(n: u32) -> u32 {
    n.min(MAX_RESULT_LIMIT)
}

/// Maximum memories accepted in one ingest request. Ingest is a single atomic
/// transaction; an unbounded batch is O(n) memory and a long lock hold. Clients
/// with more should chunk. The 32 MiB body cap is a coarser backstop.
pub const MAX_INGEST_BATCH: usize = 1000;

pub fn router(state: AppState) -> Router {
    let large = DefaultBodyLimit::max(large_body_limit());
    // One shared budget across all control endpoints (they all use the platform
    // key); cloning the layer shares the bucket.
    let control_rl = limit::RateLimit::control_from_env();
    let rl = |r: limit::RateLimit| {
        axum::middleware::from_fn(move |req, next| limit::enforce(r.clone(), req, next))
    };

    Router::new()
        .route("/health", get(|| async { "ok" }))
        .route(
            "/v1/databases",
            post(create_db).get(list_dbs).layer(rl(control_rl.clone())),
        )
        .route(
            "/v1/databases/{db}",
            axum::routing::delete(delete_db).layer(rl(control_rl.clone())),
        )
        .route("/v1/db/{db}/sql", post(sql).layer(large))
        .route("/v1/db/{db}/sync", post(sync_db))
        .route("/v1/db/{db}/branches", post(branch_create).get(branch_list))
        .route(
            "/v1/db/{db}/branches/{branch}",
            axum::routing::delete(branch_delete),
        )
        .route(
            "/v1/db/{db}/branches/{branch}/checkpoint",
            post(branch_checkpoint),
        )
        .route("/v1/db/{db}/branches/{branch}/rewind", post(branch_rewind))
        .route("/v1/db/{db}/kv/{ns}", get(kv_list))
        .route(
            "/v1/db/{db}/kv/{ns}/{key}",
            get(kv_get).put(kv_put).delete(kv_delete).layer(large),
        )
        .route(
            "/v1/db/{db}/docs/{coll}/insert",
            post(docs_insert).layer(large),
        )
        .route("/v1/db/{db}/docs/{coll}/find", post(docs_find))
        .route(
            "/v1/db/{db}/docs/{coll}/update",
            post(docs_update).layer(large),
        )
        .route("/v1/db/{db}/docs/{coll}/delete", post(docs_delete))
        .route("/v1/db/{db}/docs/{coll}/indexes", post(docs_create_index))
        .route(
            "/v1/db/{db}/vectors/{coll}",
            post(vectors_upsert).layer(large),
        )
        .route("/v1/db/{db}/vectors/{coll}/search", post(vectors_search))
        .route(
            "/v1/db/{db}/memory/{session}/turns",
            post(memory_append).get(memory_window).layer(large),
        )
        .route("/v1/db/{db}/memory/{session}/search", post(memory_search))
        // Agent memory: namespace > profile > memory (docs/architecture/07).
        .route("/v1/memory/{ns}", get(profiles_list))
        .route(
            "/v1/memory/{ns}/{profile}/memories",
            post(memories_ingest).layer(large),
        )
        .route(
            "/v1/memory/{ns}/{profile}/memories/{id}",
            get(memories_get).delete(memories_forget),
        )
        .route("/v1/memory/{ns}/{profile}/recall", post(memories_recall))
        .route("/v1/memory/{ns}/{profile}/ask", post(memories_ask))
        .route(
            "/v1/memory/{ns}/{profile}/extract",
            post(memories_extract).layer(large),
        )
        .route(
            "/v1/memory/{ns}/{profile}/sessions",
            get(memory_sessions_list),
        )
        .route(
            "/v1/memory/{ns}/{profile}/sessions/{sid}",
            axum::routing::delete(memory_session_end),
        )
        // Node-internal replica stream (NetworkPolicy/mTLS-isolated in prod).
        .route(
            "/internal/replica/subscribe",
            post(replica_subscribe).layer(large),
        )
        .route(
            "/internal/replica/ingest",
            post(replica_ingest).layer(large),
        )
        .route(
            "/v1/databases/{db}/tokens",
            post(create_token).layer(rl(control_rl.clone())),
        )
        .route(
            "/v1/namespaces/{ns}/tokens",
            post(create_ns_token).layer(rl(control_rl.clone())),
        )
        // Data governance (ADR-0010): namespace policy is a control-plane
        // operation (platform key via the middleware prefix); the per-profile
        // override rides the memory token model (read to see, admin to set).
        .route(
            "/v1/namespaces/{ns}/policy",
            get(ns_policy_get)
                .put(ns_policy_put)
                .layer(rl(control_rl.clone())),
        )
        .route(
            "/v1/memory/{ns}/{profile}/policy",
            get(profile_policy_get).put(profile_policy_put),
        )
        // Verifiable erasure (ADR-0010 phase 3): hard-forget now, then a
        // bounded-time history rewrite with a signed receipt.
        .route(
            "/v1/memory/{ns}/{profile}/erasures",
            post(memories_erase).get(erasures_list),
        )
        .route("/v1/memory/{ns}/{profile}/erasures/{id}", get(erasure_get))
        // Audit stream reads (platform key, or a namespace admin token for
        // its own stream — the carve-out lives in the auth middleware).
        .route(
            "/v1/namespaces/{ns}/audit",
            get(ns_audit_read).layer(rl(control_rl.clone())),
        )
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            auth::require_auth,
        ))
        // Global stack, outermost → innermost: reject slow/over-limit/excess
        // requests before they reach auth or a handler. Default body cap applies
        // to every route the per-route `large` layer did not already widen; CORS
        // is deny-by-default (this is a token API, not a browser origin).
        .layer(DefaultBodyLimit::max(DEFAULT_BODY_LIMIT))
        .layer(tower_http::cors::CorsLayer::new())
        .layer(tower::limit::GlobalConcurrencyLimitLayer::new(
            max_concurrency(),
        ))
        .layer(tower_http::timeout::TimeoutLayer::with_status_code(
            StatusCode::REQUEST_TIMEOUT,
            request_timeout(),
        ))
        .with_state(state)
}

/// The strata host, iff this database is strata-selected.
fn strata_host(state: &AppState, db_name: &str) -> Option<Arc<strata_backend::StrataHost>> {
    state
        .strata
        .as_ref()
        .filter(|h| h.selects(db_name))
        .cloned()
}

/// `name[@branch]` → (name, branch); `@main` implicit.
pub(crate) fn parse_spec(spec: &str) -> (&str, &str) {
    match spec.split_once('@') {
        Some((name, branch)) if !branch.is_empty() => (name, branch),
        _ => (spec, "main"),
    }
}

// ---- error mapping ----
// The envelope itself lives in `error`; these map crate errors onto it.

impl From<EngineError> for ApiError {
    fn from(e: EngineError) -> Self {
        let (status, code) = match &e {
            // The engine's NotFound is registry-only: a database lookup.
            EngineError::NotFound(_) => (StatusCode::NOT_FOUND, ErrorCode::DatabaseNotFound),
            EngineError::AlreadyExists(_) => (StatusCode::CONFLICT, ErrorCode::AlreadyExists),
            EngineError::Reserved => (StatusCode::FORBIDDEN, ErrorCode::Forbidden),
            EngineError::Overloaded(_) => (StatusCode::TOO_MANY_REQUESTS, ErrorCode::Overloaded),
            EngineError::Sql(_) => (StatusCode::BAD_REQUEST, ErrorCode::InvalidRequest),
            EngineError::Io(_) => (StatusCode::INTERNAL_SERVER_ERROR, ErrorCode::Internal),
        };
        ApiError::new(status, e.to_string()).with_code(code)
    }
}

impl From<ReplicationError> for ApiError {
    fn from(e: ReplicationError) -> Self {
        let (status, code) = match &e {
            ReplicationError::BranchNotFound(_) => {
                (StatusCode::NOT_FOUND, ErrorCode::BranchNotFound)
            }
            ReplicationError::NoSnapshot(_) => (StatusCode::CONFLICT, ErrorCode::Conflict),
            ReplicationError::ZombieFenced { .. } => (StatusCode::CONFLICT, ErrorCode::Conflict),
            ReplicationError::CasConflict => (StatusCode::CONFLICT, ErrorCode::Conflict),
            ReplicationError::Engine(_) => (StatusCode::BAD_REQUEST, ErrorCode::InvalidRequest),
            _ => (StatusCode::INTERNAL_SERVER_ERROR, ErrorCode::Internal),
        };
        ApiError::new(status, e.to_string()).with_code(code)
    }
}

impl From<ControlError> for ApiError {
    fn from(e: ControlError) -> Self {
        ApiError::new(StatusCode::SERVICE_UNAVAILABLE, e.to_string())
    }
}

impl From<memoturn_governance::GovernanceError> for ApiError {
    fn from(e: memoturn_governance::GovernanceError) -> Self {
        use memoturn_governance::GovernanceError::*;
        let status = match &e {
            Invalid(_) => StatusCode::BAD_REQUEST,
            Loosens(_) => StatusCode::CONFLICT,
            CasConflict => StatusCode::CONFLICT,
            Unavailable(_) => StatusCode::SERVICE_UNAVAILABLE,
            Corrupt(_) | Store(_) => StatusCode::INTERNAL_SERVER_ERROR,
        };
        ApiError::new(status, e.to_string())
    }
}

impl From<memoturn_docstore::DocError> for ApiError {
    fn from(e: memoturn_docstore::DocError) -> Self {
        use memoturn_docstore::DocError::*;
        match e {
            Engine(inner) => inner.into(),
            other => ApiError::new(StatusCode::BAD_REQUEST, other.to_string()),
        }
    }
}

fn txid_headers(txid: u64) -> HeaderMap {
    let mut h = HeaderMap::new();
    h.insert("Memoturn-Txid", txid.to_string().parse().unwrap());
    h
}

// ---- routing: ownership resolution + forwarding ----

struct LocalWrite {
    h: Arc<DbHandle>,
    uuid: String,
    branch: String,
    epoch: u64,
}

enum WriteRoute {
    Local(LocalWrite),
    Remote { addr: String },
}

async fn open_local(state: &AppState, uuid: &str, branch: &str) -> Result<Arc<DbHandle>, ApiError> {
    let file = state.node.db_file(uuid, branch);
    if !file.exists() {
        let restored = state.replicator.restore(uuid, branch, None, &file).await?;
        if restored.is_none() && branch != "main" {
            return Err(ApiError::new(
                StatusCode::NOT_FOUND,
                format!("branch has no state in object storage: {branch}"),
            )
            .with_code(ErrorCode::BranchNotFound));
        }
    }
    let key = format!("{uuid}@{branch}");
    Ok(state.node.handle(&key, &file).await?)
}

/// Resolve a write: become the owner (lazy acquisition) or forward to it.
/// On fresh acquisition the local copy is reconciled with the manifest head —
/// a new owner must never serve writes from a stale cache.
async fn resolve_write(state: &AppState, spec: &str) -> Result<WriteRoute, ApiError> {
    let (name, branch) = parse_spec(spec);
    let rec = state.registry.get(name).await?;
    if !state.registry.branch_exists(name, branch).await? {
        return Err(
            ApiError::new(StatusCode::NOT_FOUND, format!("branch not found: {branch}"))
                .with_code(ErrorCode::BranchNotFound),
        );
    }
    let key = format!("{}@{branch}", rec.uuid);
    match state.control.resolve_owner(&key).await? {
        Owner::Remote(o) => Ok(WriteRoute::Remote { addr: o.addr }),
        Owner::Local { epoch, acquired } => {
            let mut h = open_local(state, &rec.uuid, branch).await?;
            if acquired {
                if let Some(m) = state.replicator.load_manifest(&rec.uuid, branch).await? {
                    if m.head_txid > h.txid() {
                        state.node.evict(&key).await;
                        let file = state.node.db_file(&rec.uuid, branch);
                        let dir = state.node.db_dir(&rec.uuid, branch);
                        let _ = tokio::fs::remove_dir_all(&dir).await;
                        state
                            .replicator
                            .restore(&rec.uuid, branch, None, &file)
                            .await?;
                        h = state.node.handle(&key, &file).await?;
                    }
                }
            }
            Ok(WriteRoute::Local(LocalWrite {
                h,
                uuid: rec.uuid,
                branch: branch.to_string(),
                epoch,
            }))
        }
    }
}

/// Resolve a read: serve from the local copy (replica semantics). When the
/// caller demands `min_txid` beyond our local state, refresh from object
/// storage once; the response always discloses the served txid.
async fn resolve_read(
    state: &AppState,
    spec: &str,
    min_txid: Option<u64>,
) -> Result<(Arc<DbHandle>, String, String), ApiError> {
    let (name, branch) = parse_spec(spec);
    let rec = state.registry.get(name).await?;
    if !state.registry.branch_exists(name, branch).await? {
        return Err(
            ApiError::new(StatusCode::NOT_FOUND, format!("branch not found: {branch}"))
                .with_code(ErrorCode::BranchNotFound),
        );
    }
    let key = format!("{}@{branch}", rec.uuid);
    let mut h = open_local(state, &rec.uuid, branch).await?;
    if let Some(min) = min_txid {
        if h.txid() < min {
            state.node.evict(&key).await;
            let dir = state.node.db_dir(&rec.uuid, branch);
            let _ = tokio::fs::remove_dir_all(&dir).await;
            let file = state.node.db_file(&rec.uuid, branch);
            state
                .replicator
                .restore(&rec.uuid, branch, None, &file)
                .await?;
            h = state.node.handle(&key, &file).await?;
        }
    }
    maybe_subscribe(state, &key, &rec.uuid, branch);
    Ok((h, rec.uuid, branch.to_string()))
}

/// Lazy replica subscription: on the first read of a branch this node does
/// not own, register with the owner for live segment pushes. Fire-and-forget
/// off the read path; failure just leaves the replica on the object-storage
/// convergence path.
fn maybe_subscribe(state: &AppState, key: &str, uuid: &str, branch: &str) {
    let state = state.clone();
    let (key, uuid, branch) = (key.to_string(), uuid.to_string(), branch.to_string());
    tokio::spawn(async move {
        if !state.mesh.claim_subscription(&key).await {
            return;
        }
        let me = state.control.identity();
        let (self_node, self_addr) = (me.node_id.clone(), me.addr.clone());
        match state.control.lookup(&key).await {
            Ok(Some(owner)) if owner.node_id != self_node => {
                let mut req = state
                    .http
                    .post(format!("{}/internal/replica/subscribe", owner.addr))
                    .json(&json!({ "uuid": uuid, "branch": branch, "addr": self_addr }));
                if let auth::Auth::Enabled(keys) = &state.auth {
                    req = req.header(auth::INTERNAL_HEADER, keys.cluster_key.clone());
                }
                let sent = req.send().await;
                if !matches!(&sent, Ok(r) if r.status().is_success()) {
                    state.mesh.release_subscription(&key).await;
                }
            }
            // Unowned or self-owned: nothing to subscribe to (yet) — allow a
            // later read to retry once ownership exists elsewhere.
            _ => state.mesh.release_subscription(&key).await,
        }
    });
}

// ---- replica stream (node-internal) ----

#[derive(Deserialize)]
struct SubscribeReq {
    uuid: String,
    branch: String,
    addr: String,
}

async fn replica_subscribe(
    State(state): State<AppState>,
    Json(req): Json<SubscribeReq>,
) -> impl IntoResponse {
    let key = format!("{}@{}", req.uuid, req.branch);
    state.mesh.add_subscriber(&key, &req.addr).await;
    StatusCode::NO_CONTENT
}

/// Apply a pushed segment/snapshot to this node's replica copy. Atomic file
/// replacement: in-flight readers finish on the old inode; the handle is
/// evicted so the next read opens the new image (which carries its own txid
/// in `__memoturn_meta`).
async fn replica_ingest(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<StatusCode, ApiError> {
    let hdr = |name: &str| -> Result<String, ApiError> {
        headers
            .get(name)
            .and_then(|v| v.to_str().ok())
            .map(str::to_string)
            .ok_or_else(|| ApiError::new(StatusCode::BAD_REQUEST, format!("missing {name}")))
    };
    let (uuid, branch, kind) = (
        hdr("Memoturn-Db-Uuid")?,
        hdr("Memoturn-Branch")?,
        hdr("Memoturn-Kind")?,
    );
    let key = format!("{uuid}@{branch}");

    // Never let a stale push clobber writer state on the current owner.
    if let Ok(Some(owner)) = state.control.lookup(&key).await {
        if owner.node_id == state.control.identity().node_id {
            return Err(ApiError::new(StatusCode::CONFLICT, "node owns this branch"));
        }
    }

    let _serialize = state.mesh.ingest_lock.lock().await;
    let file = state.node.db_file(&uuid, &branch);
    let dir = state.node.db_dir(&uuid, &branch);
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(EngineError::from)?;

    let image: Vec<u8> = match kind.as_str() {
        "snapshot" => body.to_vec(),
        "segment" => {
            let seg = memoturn_replication::segment::decode(&body)?;
            // A fresh local file was created by this node (different page
            // layout than the primary) — never patch it; converge via
            // object storage instead.
            let local_txid = if file.exists() {
                state.node.handle(&key, &file).await?.txid()
            } else {
                0
            };
            if local_txid >= seg.max_txid {
                return Ok(StatusCode::OK); // duplicate / already ahead
            }
            if local_txid != seg.min_txid || seg.min_txid == 0 || !file.exists() {
                // Gap (missed pushes, never materialized, or fresh file):
                // converge from object storage.
                state.node.evict(&key).await;
                let _ = tokio::fs::remove_dir_all(&dir).await;
                state
                    .replicator
                    .restore(&uuid, &branch, None, &file)
                    .await?;
                return Ok(StatusCode::OK);
            }
            let mut image = tokio::fs::read(&file).await.map_err(EngineError::from)?;
            memoturn_replication::segment::apply_to_image(&mut image, &seg);
            image
        }
        other => {
            return Err(ApiError::new(
                StatusCode::BAD_REQUEST,
                format!("unknown kind {other}"),
            ))
        }
    };

    // tmp + rename in the same directory = atomic replace.
    let tmp = dir.join(".ingest.tmp");
    tokio::fs::write(&tmp, &image)
        .await
        .map_err(EngineError::from)?;
    tokio::fs::rename(&tmp, &file)
        .await
        .map_err(EngineError::from)?;
    state.node.evict(&key).await;
    for suffix in ["-wal", "-shm"] {
        let _ = tokio::fs::remove_file(dir.join(format!("main.db{suffix}"))).await;
    }
    Ok(StatusCode::OK)
}

fn min_txid_of(headers: &HeaderMap) -> Option<u64> {
    headers
        .get("Memoturn-Min-Txid")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.parse().ok())
}

/// Percent-encode one URL path segment or query value before it goes into a
/// forwarded URL. axum hands handlers percent-DECODED params, so client-chosen
/// ids/sessions/branches (which may contain `?`, `&`, `/`, spaces) must be
/// re-encoded or they mis-route / inject query params on the owner hop.
fn enc(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// Forward a request to the owner node and relay status/body/txid.
async fn forward(
    state: &AppState,
    addr: &str,
    method: reqwest::Method,
    path_and_query: &str,
    json_body: Option<serde_json::Value>,
    raw_body: Option<Vec<u8>>,
) -> Result<Response, ApiError> {
    let url = format!("{addr}{path_and_query}");
    let mut req = state.http.request(method, &url);
    if let auth::Auth::Enabled(keys) = &state.auth {
        req = req.header(auth::INTERNAL_HEADER, keys.cluster_key.clone());
    }
    if let Some(b) = json_body {
        req = req.json(&b);
    } else if let Some(b) = raw_body {
        req = req.body(b);
    }
    let resp = req
        .send()
        .await
        .map_err(|e| ApiError::new(StatusCode::BAD_GATEWAY, format!("forward to {addr}: {e}")))?;
    let status = StatusCode::from_u16(resp.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
    let mut headers = HeaderMap::new();
    if let Some(txid) = resp.headers().get("Memoturn-Txid") {
        if let Ok(v) = txid.to_str() {
            if let Ok(hv) = v.parse::<u64>() {
                headers = txid_headers(hv);
            }
        }
    }
    let body = resp
        .bytes()
        .await
        .map_err(|e| ApiError::new(StatusCode::BAD_GATEWAY, e.to_string()))?;
    Ok((status, headers, body).into_response())
}

/// Shorthand for the dominant case: POST with a JSON body.
macro_rules! route_write {
    ($state:expr, $spec:expr, $path:expr, $body:expr) => {
        match resolve_write($state, $spec).await? {
            WriteRoute::Remote { addr } => {
                return forward(
                    $state,
                    &addr,
                    reqwest::Method::POST,
                    $path,
                    Some($body),
                    None,
                )
                .await
            }
            WriteRoute::Local(l) => l,
        }
    };
}

/// Node-level default durability, read once. `MEMOTURN_DURABILITY=durable`
/// makes every write wait for its segment+manifest to land in object storage
/// before the txid is returned (Durable mode); otherwise writes are acked on
/// local WAL fsync and shipped by the ~sub-second background loop (Standard).
fn node_durable_default() -> bool {
    use std::sync::OnceLock;
    static D: OnceLock<bool> = OnceLock::new();
    *D.get_or_init(|| {
        std::env::var("MEMOTURN_DURABILITY")
            .map(|v| v.eq_ignore_ascii_case("durable"))
            .unwrap_or(false)
    })
}

/// Per-request durability escalation via the `Memoturn-Durability: durable`
/// header. Can only raise durability above the node default, never lower it.
fn request_durable(headers: &HeaderMap) -> bool {
    headers
        .get("memoturn-durability")
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.eq_ignore_ascii_case("durable"))
}

/// Settle a committed write. In Durable mode (node default or the request
/// header) ship synchronously and await the manifest CAS so the returned txid
/// is durable in object storage; otherwise mark the branch dirty for the
/// background shipper. Reuses the existing shipper machinery either way.
async fn settle(state: &AppState, l: &LocalWrite, want_durable: bool) -> Result<(), ApiError> {
    if want_durable || node_durable_default() {
        state
            .shipper
            .flush_one(&l.uuid, &l.branch, &l.h, l.epoch)
            .await?;
    } else {
        state
            .shipper
            .mark_dirty(&l.uuid, &l.branch, l.h.clone(), l.epoch)
            .await;
    }
    Ok(())
}

// ---- control plane (prototype-local) ----

#[derive(Deserialize)]
struct CreateDb {
    name: String,
}

async fn create_db(
    State(state): State<AppState>,
    Json(req): Json<CreateDb>,
) -> Result<impl IntoResponse, ApiError> {
    // `--` is reserved for `{ns}--{profile}` memory databases: a namespace
    // token covers every `{ns}--*`, so a plain database containing `--` would
    // silently fall inside a namespace's authority (see auth::Claims::covers_db).
    if req.name.contains('@') || req.name.contains('/') || req.name.contains("--") {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "invalid database name",
        ));
    }
    // Provisioning is metadata-only: one registry insert, no data-file I/O.
    // The uuid is agreed through the shared catalog first (same CAS as the
    // memory-profile auto-create) so two nodes racing a create for the same
    // name converge instead of minting divergent uuids (ADR-0009).
    if let Some(existing) = live_local_record(&state, &req.name).await {
        // Locally known and live: re-seed a catalog that lost state (process
        // restart on the in-process lease table), then report the conflict.
        let _ = state.control.resolve_uuid(&req.name, &existing.uuid).await;
        return Err(EngineError::AlreadyExists(req.name).into());
    }
    let proposed = uuid::Uuid::new_v4().simple().to_string();
    let canonical = state.control.resolve_uuid(&req.name, &proposed).await?;
    if canonical != proposed {
        // The name exists in the shared catalog (created or auto-created on
        // another node). Adopt it locally so this node can serve it, but the
        // create itself is a conflict.
        state
            .registry
            .ensure_with_uuid(&req.name, &canonical)
            .await?;
        return Err(EngineError::AlreadyExists(req.name).into());
    }
    let rec = state
        .registry
        .create_with_uuid(&req.name, &canonical)
        .await?;
    Ok((StatusCode::CREATED, Json(json!(rec))))
}

#[derive(Deserialize)]
struct CreateToken {
    scope: auth::Scope,
    #[serde(default)]
    expires_in: Option<u64>,
}

/// Mint a per-database JWT (platform-key protected by the middleware).
async fn create_token(
    State(state): State<AppState>,
    Path(db): Path<String>,
    Json(req): Json<CreateToken>,
) -> Result<impl IntoResponse, ApiError> {
    let auth::Auth::Enabled(keys) = &state.auth else {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "auth is disabled on this node",
        ));
    };
    state.registry.get(&db).await?;
    let ttl = req.expires_in.unwrap_or(3600) as i64;
    let token = keys
        .mint(&db, req.scope, ttl)
        .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, e))?;
    // Audit token minting into the profile's namespace stream (only memory
    // databases have one; plain databases have no governance namespace).
    if let Some((ns, profile)) = db.split_once("--") {
        let (audit_on, _) = audit_gate(&state, ns, profile).await;
        if audit_on {
            state.audit.emit(
                audit::AuditEvent::new("token.mint", ns)
                    .profile(profile)
                    .resource(format!("{db} scope={:?} ttl={ttl}", req.scope))
                    .actor(Some(&audit::Actor::platform())),
            );
        }
    }
    Ok((
        StatusCode::CREATED,
        Json(json!({ "token": token, "expires_in": ttl })),
    ))
}

async fn list_dbs(State(state): State<AppState>) -> Result<impl IntoResponse, ApiError> {
    Ok(Json(json!({ "databases": state.registry.list().await? })))
}

async fn delete_db(
    State(state): State<AppState>,
    Path(db): Path<String>,
) -> Result<impl IntoResponse, ApiError> {
    let branches = state.registry.list_branches(&db).await.unwrap_or_default();
    let rec = state.registry.delete(&db).await?;
    for b in branches.iter().map(|b| b.branch.as_str()).chain(["main"]) {
        let key = format!("{}@{b}", rec.uuid);
        state.control.release(&key).await?;
        state
            .node
            .evict_and_remove(&key, &state.node.db_dir(&rec.uuid, b))
            .await?;
    }
    state.replicator.delete_db(&rec.uuid).await?;
    if let Some(host) = strata_host(&state, &db) {
        host.evict_db(&rec.uuid).await;
        host.store.delete_db(&rec.uuid).await?;
    }
    // Revoke stateless tokens minted before now: a write token must not survive
    // deletion to resurrect or mutate a re-created database of the same name.
    // The registry copy makes revocation durable: the control-plane table is
    // in-process on a single node and would forget across a restart; the
    // registry persists via the catalog backup and re-seeds it at boot.
    let at = now_ms();
    state.registry.set_tombstone(&db, at).await?;
    state.control.tombstone(&db, at).await?;
    // Drop the catalog name→uuid mapping last: a re-created database must mint
    // a fresh uuid rather than resolve to the deleted one's (now empty) prefix.
    state.control.forget_uuid(&db).await?;
    // The deletion trail outlives the database: the audit stream lives under
    // `_audit/{ns}`, not the deleted uuid prefix.
    if let Some((ns, profile)) = db.split_once("--") {
        let (audit_on, _) = audit_gate(&state, ns, profile).await;
        if audit_on {
            state.audit.emit(
                audit::AuditEvent::new("db.delete", ns)
                    .profile(profile)
                    .resource(&db)
                    .actor(Some(&audit::Actor::platform())),
            );
        }
    }
    Ok(StatusCode::NO_CONTENT)
}

// ---- SQL ----

#[derive(Deserialize)]
struct SqlRequest {
    stmts: Vec<Stmt>,
}

async fn sql(
    State(state): State<AppState>,
    Path(db): Path<String>,
    claims: Option<axum::Extension<auth::Claims>>,
    headers: HeaderMap,
    Json(req): Json<serde_json::Value>,
) -> Result<Response, ApiError> {
    let parsed: SqlRequest = serde_json::from_value(req.clone())
        .map_err(|e| ApiError::new(StatusCode::BAD_REQUEST, e.to_string()))?;
    for stmt in &parsed.stmts {
        guard_reserved(&stmt.q)?;
    }
    // The middleware admits /sql at read scope; mutating statements need write.
    if let Some(axum::Extension(c)) = &claims {
        if c.scope < auth::Scope::Write
            && !parsed
                .stmts
                .iter()
                .all(|s| memoturn_engine::is_read_only(&s.q))
        {
            return Err(ApiError::new(
                StatusCode::FORBIDDEN,
                "write scope required for mutating SQL",
            ));
        }
    }
    // The strata engine has no SQL surface (ADR-0011) — typed APIs only.
    if strata_host(&state, parse_spec(&db).0).is_some() {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "this database runs on the strata engine, which has no SQL surface; use the docs/KV/memory APIs",
        )
        .with_code(ErrorCode::InvalidRequest));
    }
    let l = route_write!(&state, &db, &format!("/v1/db/{db}/sql"), req);
    let before = l.h.txid();
    let (results, txid) = l.h.write_batch(&parsed.stmts).await?;
    if txid > before {
        settle(&state, &l, request_durable(&headers)).await?;
    }
    Ok((
        txid_headers(txid),
        Json(json!({ "results": results, "txid": txid })),
    )
        .into_response())
}

/// Ship this branch's state to object storage now (deterministic durability
/// point; the background shipper otherwise runs on an interval).
async fn sync_db(
    State(state): State<AppState>,
    Path(db): Path<String>,
) -> Result<Response, ApiError> {
    if let Some(host) = strata_host(&state, parse_spec(&db).0) {
        let d = match strata_backend::route_write(&state, &host, &db).await? {
            strata_backend::SRoute::Remote { addr } => {
                return forward(
                    &state,
                    &addr,
                    reqwest::Method::POST,
                    &format!("/v1/db/{db}/sync"),
                    Some(json!({})),
                    None,
                )
                .await
            }
            strata_backend::SRoute::Local(d) => d,
        };
        // Flush folds the memtable + WAL tail into a segment and advances
        // the manifest — the strata durability point.
        d.flush().await?;
        let txid = d.head().await;
        return Ok((txid_headers(txid), Json(json!({ "txid": txid }))).into_response());
    }
    let l = route_write!(&state, &db, &format!("/v1/db/{db}/sync"), json!({}));
    state
        .shipper
        .flush_one(&l.uuid, &l.branch, &l.h, l.epoch)
        .await?;
    Ok((
        txid_headers(l.h.txid()),
        Json(json!({ "txid": l.h.txid() })),
    )
        .into_response())
}

// ---- branches ----

#[derive(Deserialize)]
struct CreateBranch {
    name: String,
    /// Parent branch (default `main`).
    #[serde(default)]
    from: Option<String>,
    /// Burner branch: seconds until GC.
    #[serde(default)]
    ttl: Option<u64>,
}

async fn branch_create(
    State(state): State<AppState>,
    Path(db): Path<String>,
    Json(req): Json<serde_json::Value>,
) -> Result<Response, ApiError> {
    let parsed: CreateBranch = serde_json::from_value(req.clone())
        .map_err(|e| ApiError::new(StatusCode::BAD_REQUEST, e.to_string()))?;
    let (name, _) = parse_spec(&db);
    let parent = parsed.from.as_deref().unwrap_or("main");
    let spec = format!("{name}@{parent}");
    if let Some(host) = strata_host(&state, name) {
        let d = match strata_backend::route_write(&state, &host, &spec).await? {
            strata_backend::SRoute::Remote { addr } => {
                return forward(
                    &state,
                    &addr,
                    reqwest::Method::POST,
                    &format!("/v1/db/{db}/branches"),
                    Some(req),
                    None,
                )
                .await
            }
            strata_backend::SRoute::Local(d) => d,
        };
        let ttl_at = parsed.ttl.map(|t| now_ms() + (t as i64) * 1000);
        // Fork flushes first, then one manifest create — O(1), no data copied.
        let manifest = d.fork(&parsed.name, ttl_at).await?;
        let rec = state
            .registry
            .create_branch(name, &parsed.name, parsed.ttl)
            .await?;
        return Ok((
            StatusCode::CREATED,
            Json(json!({
                "branch": rec.branch,
                "parent": parent,
                "fork_txid": manifest.head_txid,
                "ttl_at": rec.ttl_at,
                "spec": format!("{name}@{}", rec.branch),
            })),
        )
            .into_response());
    }
    let l = route_write!(&state, &spec, &format!("/v1/db/{db}/branches"), req);
    // Fork is CoW over the snapshot store: ship parent head, then one manifest write.
    state
        .shipper
        .flush_one(&l.uuid, parent, &l.h, l.epoch)
        .await?;
    let ttl_at = parsed.ttl.map(|t| now_ms() + (t as i64) * 1000);
    let manifest = state
        .replicator
        .fork(&l.uuid, parent, &parsed.name, ttl_at)
        .await?;
    let rec = state
        .registry
        .create_branch(name, &parsed.name, parsed.ttl)
        .await?;
    Ok((
        StatusCode::CREATED,
        Json(json!({
            "branch": rec.branch,
            "parent": parent,
            "fork_txid": manifest.head_txid,
            "ttl_at": rec.ttl_at,
            "spec": format!("{name}@{}", rec.branch),
        })),
    )
        .into_response())
}

async fn branch_list(
    State(state): State<AppState>,
    Path(db): Path<String>,
) -> Result<impl IntoResponse, ApiError> {
    let (name, _) = parse_spec(&db);
    state.registry.get(name).await?;
    Ok(Json(
        json!({ "branches": state.registry.list_branches(name).await? }),
    ))
}

async fn branch_delete(
    State(state): State<AppState>,
    Path((db, branch)): Path<(String, String)>,
) -> Result<impl IntoResponse, ApiError> {
    let (name, _) = parse_spec(&db);
    if branch == "main" {
        return Err(ApiError::new(StatusCode::BAD_REQUEST, "cannot delete main"));
    }
    let rec = state.registry.get(name).await?;
    state.registry.delete_branch(name, &branch).await?;
    let key = format!("{}@{branch}", rec.uuid);
    state.control.release(&key).await?;
    if let Some(host) = strata_host(&state, name) {
        host.evict_branch(&rec.uuid, &branch).await;
        host.store.delete_branch(&rec.uuid, &branch).await?;
        return Ok(StatusCode::NO_CONTENT);
    }
    state
        .node
        .evict_and_remove(&key, &state.node.db_dir(&rec.uuid, &branch))
        .await?;
    state.replicator.delete_branch(&rec.uuid, &branch).await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
struct CheckpointReq {
    name: String,
}

async fn branch_checkpoint(
    State(state): State<AppState>,
    Path((db, branch)): Path<(String, String)>,
    Json(req): Json<serde_json::Value>,
) -> Result<Response, ApiError> {
    let parsed: CheckpointReq = serde_json::from_value(req.clone())
        .map_err(|e| ApiError::new(StatusCode::BAD_REQUEST, e.to_string()))?;
    let (name, _) = parse_spec(&db);
    let spec = format!("{name}@{branch}");
    if let Some(host) = strata_host(&state, name) {
        let d = match strata_backend::route_write(&state, &host, &spec).await? {
            strata_backend::SRoute::Remote { addr } => {
                return forward(
                    &state,
                    &addr,
                    reqwest::Method::POST,
                    &format!("/v1/db/{db}/branches/{branch}/checkpoint"),
                    Some(req),
                    None,
                )
                .await
            }
            strata_backend::SRoute::Local(d) => d,
        };
        let txid = d.checkpoint(&parsed.name).await?;
        return Ok((
            txid_headers(txid),
            Json(json!({ "checkpoint": parsed.name, "txid": txid })),
        )
            .into_response());
    }
    let l = route_write!(
        &state,
        &spec,
        &format!("/v1/db/{db}/branches/{branch}/checkpoint"),
        req
    );
    state
        .shipper
        .flush_one(&l.uuid, &l.branch, &l.h, l.epoch)
        .await?;
    let m = state
        .replicator
        .checkpoint(&l.uuid, &l.branch, &parsed.name)
        .await?;
    Ok((
        txid_headers(m.head_txid),
        Json(json!({ "checkpoint": parsed.name, "txid": m.head_txid })),
    )
        .into_response())
}

#[derive(Deserialize)]
struct RewindReq {
    /// Checkpoint name or txid.
    to: String,
}

async fn branch_rewind(
    State(state): State<AppState>,
    Path((db, branch)): Path<(String, String)>,
    Json(req): Json<serde_json::Value>,
) -> Result<Response, ApiError> {
    let parsed: RewindReq = serde_json::from_value(req.clone())
        .map_err(|e| ApiError::new(StatusCode::BAD_REQUEST, e.to_string()))?;
    let (name, _) = parse_spec(&db);
    let spec = format!("{name}@{branch}");
    if let Some(host) = strata_host(&state, name) {
        let d = match strata_backend::route_write(&state, &host, &spec).await? {
            strata_backend::SRoute::Remote { addr } => {
                return forward(
                    &state,
                    &addr,
                    reqwest::Method::POST,
                    &format!("/v1/db/{db}/branches/{branch}/rewind"),
                    Some(req),
                    None,
                )
                .await
            }
            strata_backend::SRoute::Local(d) => d,
        };
        // Rewind works at any txid in the window — no boundary restriction
        // on this engine (ADR-0011); no local rematerialization either, the
        // writer just discards its memtable and reloads refs.
        let txid = d.rewind(&parsed.to).await?;
        return Ok((
            txid_headers(txid),
            Json(json!({ "rewound_to": txid, "epoch": d.epoch() })),
        )
            .into_response());
    }
    let l = route_write!(
        &state,
        &spec,
        &format!("/v1/db/{db}/branches/{branch}/rewind"),
        req
    );
    // Manifest op first (head moves), then rematerialize locally.
    let m = state
        .replicator
        .rewind(&l.uuid, &l.branch, &parsed.to)
        .await?;
    let key = format!("{}@{}", l.uuid, l.branch);
    state
        .node
        .evict_and_remove(&key, &state.node.db_dir(&l.uuid, &l.branch))
        .await?;
    let file = state.node.db_file(&l.uuid, &l.branch);
    state
        .replicator
        .restore(&l.uuid, &l.branch, Some(m.head_txid), &file)
        .await?;
    Ok((
        txid_headers(m.head_txid),
        Json(json!({ "rewound_to": m.head_txid, "epoch": m.epoch })),
    )
        .into_response())
}

/// GC pass for expired burner branches; returns how many were incinerated.
pub async fn gc_burner_branches(state: &AppState) -> usize {
    let Ok(expired) = state.registry.expired_branches().await else {
        return 0;
    };
    let mut n = 0;
    for b in expired {
        let Ok(rec) = state.registry.get(&b.db_name).await else {
            continue;
        };
        if state
            .registry
            .delete_branch(&b.db_name, &b.branch)
            .await
            .is_err()
        {
            continue;
        }
        let key = format!("{}@{}", rec.uuid, b.branch);
        let _ = state.control.release(&key).await;
        if let Some(host) = strata_host(state, &b.db_name) {
            host.evict_branch(&rec.uuid, &b.branch).await;
            let _ = host.store.delete_branch(&rec.uuid, &b.branch).await;
            n += 1;
            continue;
        }
        let _ = state
            .node
            .evict_and_remove(&key, &state.node.db_dir(&rec.uuid, &b.branch))
            .await;
        let _ = state.replicator.delete_branch(&rec.uuid, &b.branch).await;
        n += 1;
    }
    n
}

/// Sweep expired task memories and KV keys across hot databases. Expiry is a
/// write, so only branches this node currently owns are swept — a non-owner
/// must never mutate its replica copy (single-writer invariant).
pub async fn sweep_expired(state: &AppState) -> u64 {
    let me = state.control.identity().node_id.clone();
    // uuid → name, to resolve each hot database's namespace policy.
    let name_of: HashMap<String, String> = state
        .registry
        .list()
        .await
        .map(|dbs| dbs.into_iter().map(|d| (d.uuid, d.name)).collect())
        .unwrap_or_default();
    let mut n = 0;
    for (key, h) in state.node.hot_entries() {
        let Ok(Some(owner)) = state.control.lookup(&key).await else {
            continue;
        };
        if owner.node_id != me {
            continue;
        }
        let before = h.txid();
        n += memoturn_docstore::memories::sweep_expired(&h)
            .await
            .unwrap_or(0);
        n += memoturn_kv::sweep_expired(&h).await.unwrap_or(0);
        // Policy-driven memory aging (ADR-0010): superseded-history and event
        // age caps from the namespace policy. Same writer-only contract; cold
        // databases are swept when they next become hot on their owner (their
        // object-storage history is still bounded by `enforce_retention`).
        if let Some(name) = key.split_once('@').and_then(|(uuid, _)| name_of.get(uuid)) {
            if let Ok(eff) = state.governance.effective_for_db(name).await {
                let rules = memoturn_docstore::memories::MemoryRules {
                    event_max_age_secs: eff.event_max_age_secs,
                    superseded_max_age_secs: eff.superseded_max_age_secs,
                    superseded_max_count: eff.superseded_max_count,
                };
                if rules.any() {
                    n += memoturn_docstore::memories::enforce_memory_policy(&h, &rules)
                        .await
                        .unwrap_or(0);
                }
            }
        }
        if h.txid() > before {
            if let Some((uuid, branch)) = key.split_once('@') {
                state
                    .shipper
                    .mark_dirty(uuid, branch, h.clone(), owner.epoch)
                    .await;
            }
        }
    }
    // The strata pass: same writer-only contract over the host's owned
    // handles. Deletes are ordinary writes — the host's background flusher
    // ships them; recall already filters expired rows lazily in between.
    if let Some(host) = state.strata.clone() {
        for (key, d) in host.owned().await {
            let Ok(Some(owner)) = state.control.lookup(&key).await else {
                continue;
            };
            if owner.node_id != me {
                continue;
            }
            for req in [
                memoturn_strata::WriteRequest::MemSweepExpired,
                memoturn_strata::WriteRequest::KvSweep,
            ] {
                if let Ok((memoturn_strata::WriteOutput::Count(c), _)) =
                    d.submit(req, memoturn_strata::Durability::Standard).await
                {
                    n += c;
                }
            }
            if let Some(name) = key.split_once('@').and_then(|(uuid, _)| name_of.get(uuid)) {
                if let Ok(eff) = state.governance.effective_for_db(name).await {
                    let rules = memoturn_strata::MemoryRules {
                        event_max_age_secs: eff.event_max_age_secs,
                        superseded_max_age_secs: eff.superseded_max_age_secs,
                        superseded_max_count: eff.superseded_max_count,
                    };
                    if rules.any() {
                        if let Ok((memoturn_strata::WriteOutput::Count(c), _)) = d
                            .submit(
                                memoturn_strata::WriteRequest::MemEnforcePolicy(rules),
                                memoturn_strata::Durability::Standard,
                            )
                            .await
                        {
                            n += c;
                        }
                    }
                }
            }
        }
    }
    n
}

/// Reclaim object-storage snapshots/segments no longer referenced by any branch
/// manifest, across every database (refcount GC; ADR-0004). Idempotent and
/// grace-windowed, so it is safe to run from any node. `MEMOTURN_GC_GRACE_SECS`
/// (default 600) shields objects written within the window from deletion.
pub async fn gc_objects(state: &AppState) -> usize {
    let grace = std::time::Duration::from_secs(
        std::env::var("MEMOTURN_GC_GRACE_SECS")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(600),
    );
    let Ok(dbs) = state.registry.list().await else {
        return 0;
    };
    let mut n = 0;
    for db in dbs {
        match state.replicator.gc(&db.uuid, grace).await {
            Ok(d) => n += d,
            Err(e) => tracing::warn!(uuid = %db.uuid, error = %e, "object GC failed"),
        }
        // Strata databases GC under their own root (dereferenced segments,
        // absorbed WAL chunks) — same refcount-union + grace contract.
        if let Some(host) = strata_host(state, &db.name) {
            match host.store.gc(&db.uuid, grace).await {
                Ok(d) => n += d,
                Err(e) => tracing::warn!(uuid = %db.uuid, error = %e, "strata object GC failed"),
            }
        }
    }
    n
}

/// The local registry record for `name`, unless it predates the cluster-wide
/// deletion tombstone — i.e. a stale record on a node that did not serve the
/// delete. Stale records are dropped on sight (self-heal) and reported as
/// absent, so neither create nor auto-create can re-seed the catalog with a
/// deleted uuid whose object-storage prefix is gone.
async fn live_local_record(state: &AppState, name: &str) -> Option<memoturn_engine::DbRecord> {
    let rec = state.registry.get(name).await.ok()?;
    let deleted = state.control.deleted_at(name).await.ok().flatten();
    if deleted.is_some_and(|d| rec.created_at <= d) {
        tracing::info!(%name, "dropping registry record stale-since deletion");
        let _ = state.registry.delete(name).await;
        return None;
    }
    Some(rec)
}

/// Memory-profile auto-create (first ingest/extract): agree the uuid through
/// the shared catalog before touching the node-local registry, so concurrent
/// first-ingests across nodes converge on one uuid instead of splitting the
/// profile's storage (ADR-0009). Metadata-only, instant. A stale write token
/// cannot resurrect a deleted profile through here: the auth middleware
/// rejects tokens whose `iat` predates the deletion tombstone before any
/// handler runs. An existing (live) local record proposes its own uuid, which
/// re-seeds a catalog that lost state (process restart on the in-process
/// lease table).
async fn ensure_profile(state: &AppState, name: &str) -> Result<(), ApiError> {
    let proposed = match live_local_record(state, name).await {
        Some(rec) => rec.uuid,
        None => uuid::Uuid::new_v4().simple().to_string(),
    };
    let canonical = state.control.resolve_uuid(name, &proposed).await?;
    if canonical != proposed {
        tracing::debug!(%name, "profile uuid adopted from shared catalog");
    }
    state.registry.ensure_with_uuid(name, &canonical).await?;
    Ok(())
}

/// Re-seed the control plane's revocation list from the registry's durable
/// tombstones — call once at node start. On a single node the in-process
/// lease table forgets across restarts; without this, a write token revoked
/// by a deletion would work again after a pod replacement. Idempotent
/// (tombstones are monotonic max).
pub async fn seed_tombstones(state: &AppState) -> usize {
    let Ok(stones) = state.registry.tombstones().await else {
        return 0;
    };
    let mut n = 0;
    for (name, at_ms) in stones {
        match state.control.tombstone(&name, at_ms).await {
            Ok(()) => n += 1,
            Err(e) => tracing::warn!(%name, error = %e, "tombstone re-seed failed"),
        }
    }
    n
}

/// Bound every database's PITR history (docs/architecture/02): prune branch
/// manifests so the immutable segment log stops growing forever.
/// `MEMOTURN_PITR_RETENTION_SECS` (default 86400 = 24 h) is the fine-grained
/// window — restore-to-any-boundary; `MEMOTURN_PITR_SNAPSHOT_RETENTION_SECS`
/// (default 2592000 = 30 d) keeps older snapshots as coarse restore points.
/// `MEMOTURN_PITR_RETENTION_SECS=0` disables the pass entirely. Named
/// checkpoints are pinned regardless of age; child forks keep their own
/// references. Idempotent and CAS-guarded, so it is safe to run from any
/// node; dereferenced objects are reclaimed by the next `gc_objects` pass.
pub async fn enforce_retention(state: &AppState) -> usize {
    let fine_secs: u64 = std::env::var("MEMOTURN_PITR_RETENTION_SECS")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(86_400);
    if fine_secs == 0 {
        return 0;
    }
    let snap_secs: u64 = std::env::var("MEMOTURN_PITR_SNAPSHOT_RETENTION_SECS")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(2_592_000);
    let fine = std::time::Duration::from_secs(fine_secs);
    let snap = std::time::Duration::from_secs(snap_secs);
    let Ok(dbs) = state.registry.list().await else {
        return 0;
    };
    // Namespace policies may tighten (never widen) the env windows per
    // profile database (ADR-0010): effective = min(env ceiling, policy).
    // Read fresh — the sweep cadence already bounds staleness.
    let policies: HashMap<String, memoturn_governance::PolicyDoc> =
        match state.governance.list().await {
            Ok(docs) => docs.into_iter().map(|d| (d.namespace.clone(), d)).collect(),
            Err(e) => {
                tracing::warn!(error = %e, "policy list failed; retention uses env windows only");
                HashMap::new()
            }
        };
    let mut n = 0;
    for db in dbs {
        let (fine, snap) = retention_windows(&db.name, fine, snap, &policies);
        match state.replicator.prune_retention(&db.uuid, fine, snap).await {
            Ok(p) => n += p,
            Err(e) => tracing::warn!(uuid = %db.uuid, error = %e, "PITR retention failed"),
        }
    }
    n
}

/// Effective PITR windows for one database: the env ceilings tightened by the
/// `{ns}--{profile}` database's namespace policy, if any. Plain databases get
/// the env windows unchanged. Public for tests.
#[doc(hidden)]
pub fn retention_windows(
    db_name: &str,
    env_fine: std::time::Duration,
    env_snap: std::time::Duration,
    policies: &HashMap<String, memoturn_governance::PolicyDoc>,
) -> (std::time::Duration, std::time::Duration) {
    let (mut fine, mut snap) = (env_fine, env_snap);
    if let Some((ns, profile)) = db_name.split_once("--") {
        if let Some(doc) = policies.get(ns) {
            let eff = doc.effective(Some(profile));
            if let Some(p) = eff.pitr_secs {
                fine = fine.min(std::time::Duration::from_secs(p));
            }
            if let Some(p) = eff.pitr_snapshot_secs {
                snap = snap.min(std::time::Duration::from_secs(p));
            }
        }
    }
    (fine, snap)
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// ---- documents ----

#[derive(Deserialize)]
struct DocsInsert {
    docs: Vec<serde_json::Value>,
}

async fn docs_insert(
    State(state): State<AppState>,
    Path((db, coll)): Path<(String, String)>,
    Json(req): Json<serde_json::Value>,
) -> Result<Response, ApiError> {
    let parsed: DocsInsert = serde_json::from_value(req.clone())
        .map_err(|e| ApiError::new(StatusCode::BAD_REQUEST, e.to_string()))?;
    if let Some(host) = strata_host(&state, parse_spec(&db).0) {
        let d = match strata_backend::route_write(&state, &host, &db).await? {
            strata_backend::SRoute::Remote { addr } => {
                return forward(
                    &state,
                    &addr,
                    reqwest::Method::POST,
                    &format!("/v1/db/{db}/docs/{coll}/insert"),
                    Some(req),
                    None,
                )
                .await
            }
            strata_backend::SRoute::Local(d) => d,
        };
        let (out, txid) = strata_backend::submit(
            &d,
            memoturn_strata::WriteRequest::DocInsert {
                collection: coll.clone(),
                docs: parsed.docs,
            },
            false,
        )
        .await?;
        let ids = strata_backend::expect_ids(out)?;
        return Ok((
            StatusCode::CREATED,
            txid_headers(txid),
            Json(json!({ "ids": ids, "txid": txid })),
        )
            .into_response());
    }
    let l = route_write!(&state, &db, &format!("/v1/db/{db}/docs/{coll}/insert"), req);
    let (ids, txid) = memoturn_docstore::insert(&l.h, &coll, parsed.docs).await?;
    settle(&state, &l, false).await?;
    Ok((
        StatusCode::CREATED,
        txid_headers(txid),
        Json(json!({ "ids": ids, "txid": txid })),
    )
        .into_response())
}

#[derive(Deserialize)]
struct DocsFind {
    #[serde(default)]
    filter: serde_json::Value,
    #[serde(default)]
    sort: Option<serde_json::Value>,
    #[serde(default)]
    limit: Option<u32>,
    #[serde(default)]
    skip: Option<u32>,
}

async fn docs_find(
    State(state): State<AppState>,
    Path((db, coll)): Path<(String, String)>,
    headers: HeaderMap,
    Json(req): Json<DocsFind>,
) -> Result<Response, ApiError> {
    let filter = if req.filter.is_null() {
        json!({})
    } else {
        req.filter
    };
    if let Some(host) = strata_host(&state, parse_spec(&db).0) {
        let r = strata_backend::route_read(&state, &host, &db).await?;
        let docs = r
            .with_view(|v| {
                memoturn_strata::surface::docs::find(
                    v,
                    &coll,
                    &filter,
                    memoturn_strata::surface::docs::FindOpts {
                        sort: req.sort.clone(),
                        limit: capped(req.limit.unwrap_or(100)),
                        skip: req.skip.unwrap_or(0),
                    },
                )
            })
            .await?;
        let txid = r.head().await;
        return Ok((
            txid_headers(txid),
            Json(json!({ "docs": docs, "txid": txid })),
        )
            .into_response());
    }
    let (h, _, _) = resolve_read(&state, &db, min_txid_of(&headers)).await?;
    let docs = memoturn_docstore::find(
        &h,
        &coll,
        &filter,
        memoturn_docstore::FindOpts {
            sort: req.sort,
            limit: capped(req.limit.unwrap_or(100)),
            skip: req.skip.unwrap_or(0),
        },
    )
    .await?;
    Ok((
        txid_headers(h.txid()),
        Json(json!({ "docs": docs, "txid": h.txid() })),
    )
        .into_response())
}

#[derive(Deserialize)]
struct DocsUpdate {
    filter: serde_json::Value,
    update: serde_json::Value,
    #[serde(default)]
    multi: bool,
}

async fn docs_update(
    State(state): State<AppState>,
    Path((db, coll)): Path<(String, String)>,
    Json(req): Json<serde_json::Value>,
) -> Result<Response, ApiError> {
    let parsed: DocsUpdate = serde_json::from_value(req.clone())
        .map_err(|e| ApiError::new(StatusCode::BAD_REQUEST, e.to_string()))?;
    if let Some(host) = strata_host(&state, parse_spec(&db).0) {
        let d = match strata_backend::route_write(&state, &host, &db).await? {
            strata_backend::SRoute::Remote { addr } => {
                return forward(
                    &state,
                    &addr,
                    reqwest::Method::POST,
                    &format!("/v1/db/{db}/docs/{coll}/update"),
                    Some(req),
                    None,
                )
                .await
            }
            strata_backend::SRoute::Local(d) => d,
        };
        let (out, txid) = strata_backend::submit(
            &d,
            memoturn_strata::WriteRequest::DocUpdate {
                collection: coll.clone(),
                filter: parsed.filter,
                update: parsed.update,
                multi: parsed.multi,
            },
            false,
        )
        .await?;
        let modified = strata_backend::expect_count(out)?;
        return Ok((
            txid_headers(txid),
            Json(json!({ "modified": modified, "txid": txid })),
        )
            .into_response());
    }
    let l = route_write!(&state, &db, &format!("/v1/db/{db}/docs/{coll}/update"), req);
    let (modified, txid) =
        memoturn_docstore::update_docs(&l.h, &coll, &parsed.filter, &parsed.update, parsed.multi)
            .await?;
    if modified > 0 {
        settle(&state, &l, false).await?;
    }
    Ok((
        txid_headers(txid),
        Json(json!({ "modified": modified, "txid": txid })),
    )
        .into_response())
}

#[derive(Deserialize)]
struct DocsDelete {
    filter: serde_json::Value,
    #[serde(default)]
    multi: bool,
}

async fn docs_delete(
    State(state): State<AppState>,
    Path((db, coll)): Path<(String, String)>,
    Json(req): Json<serde_json::Value>,
) -> Result<Response, ApiError> {
    let parsed: DocsDelete = serde_json::from_value(req.clone())
        .map_err(|e| ApiError::new(StatusCode::BAD_REQUEST, e.to_string()))?;
    if let Some(host) = strata_host(&state, parse_spec(&db).0) {
        let d = match strata_backend::route_write(&state, &host, &db).await? {
            strata_backend::SRoute::Remote { addr } => {
                return forward(
                    &state,
                    &addr,
                    reqwest::Method::POST,
                    &format!("/v1/db/{db}/docs/{coll}/delete"),
                    Some(req),
                    None,
                )
                .await
            }
            strata_backend::SRoute::Local(d) => d,
        };
        let (out, txid) = strata_backend::submit(
            &d,
            memoturn_strata::WriteRequest::DocDelete {
                collection: coll.clone(),
                filter: parsed.filter,
                multi: parsed.multi,
            },
            false,
        )
        .await?;
        let deleted = strata_backend::expect_count(out)?;
        return Ok((
            txid_headers(txid),
            Json(json!({ "deleted": deleted, "txid": txid })),
        )
            .into_response());
    }
    let l = route_write!(&state, &db, &format!("/v1/db/{db}/docs/{coll}/delete"), req);
    let (deleted, txid) =
        memoturn_docstore::delete_docs(&l.h, &coll, &parsed.filter, parsed.multi).await?;
    if deleted > 0 {
        settle(&state, &l, false).await?;
    }
    Ok((
        txid_headers(txid),
        Json(json!({ "deleted": deleted, "txid": txid })),
    )
        .into_response())
}

#[derive(Deserialize)]
struct CreateIndexReq {
    path: String,
}

async fn docs_create_index(
    State(state): State<AppState>,
    Path((db, coll)): Path<(String, String)>,
    Json(req): Json<serde_json::Value>,
) -> Result<Response, ApiError> {
    let parsed: CreateIndexReq = serde_json::from_value(req.clone())
        .map_err(|e| ApiError::new(StatusCode::BAD_REQUEST, e.to_string()))?;
    if let Some(host) = strata_host(&state, parse_spec(&db).0) {
        let d = match strata_backend::route_write(&state, &host, &db).await? {
            strata_backend::SRoute::Remote { addr } => {
                return forward(
                    &state,
                    &addr,
                    reqwest::Method::POST,
                    &format!("/v1/db/{db}/docs/{coll}/indexes"),
                    Some(req),
                    None,
                )
                .await
            }
            strata_backend::SRoute::Local(d) => d,
        };
        strata_backend::submit(
            &d,
            memoturn_strata::WriteRequest::DocCreateIndex {
                collection: coll.clone(),
                path: parsed.path.clone(),
            },
            false,
        )
        .await?;
        return Ok((StatusCode::CREATED, Json(json!({ "indexed": parsed.path }))).into_response());
    }
    let l = route_write!(
        &state,
        &db,
        &format!("/v1/db/{db}/docs/{coll}/indexes"),
        req
    );
    memoturn_docstore::create_index(&l.h, &coll, &parsed.path).await?;
    settle(&state, &l, false).await?;
    Ok((StatusCode::CREATED, Json(json!({ "indexed": parsed.path }))).into_response())
}

// ---- vectors ----

/// Standalone vector collections are not part of the strata typed surface
/// (memory embeddings ride ingest); the route stays libSQL-only.
fn strata_no_vector_collections() -> ApiError {
    ApiError::new(
        StatusCode::BAD_REQUEST,
        "vector collections are not available on the strata engine; memory embeddings ride /memories ingest",
    )
    .with_code(ErrorCode::InvalidRequest)
}

#[derive(Deserialize)]
struct VectorUpsert {
    id: String,
    embedding: Vec<f32>,
}

async fn vectors_upsert(
    State(state): State<AppState>,
    Path((db, coll)): Path<(String, String)>,
    Json(req): Json<serde_json::Value>,
) -> Result<Response, ApiError> {
    let parsed: VectorUpsert = serde_json::from_value(req.clone())
        .map_err(|e| ApiError::new(StatusCode::BAD_REQUEST, e.to_string()))?;
    if strata_host(&state, parse_spec(&db).0).is_some() {
        return Err(strata_no_vector_collections());
    }
    let l = route_write!(&state, &db, &format!("/v1/db/{db}/vectors/{coll}"), req);
    let txid =
        memoturn_docstore::vectors::upsert(&l.h, &coll, &parsed.id, &parsed.embedding).await?;
    settle(&state, &l, false).await?;
    Ok((txid_headers(txid), Json(json!({ "txid": txid }))).into_response())
}

#[derive(Deserialize)]
struct VectorSearch {
    vector: Vec<f32>,
    #[serde(default)]
    k: Option<u32>,
}

async fn vectors_search(
    State(state): State<AppState>,
    Path((db, coll)): Path<(String, String)>,
    headers: HeaderMap,
    Json(req): Json<VectorSearch>,
) -> Result<impl IntoResponse, ApiError> {
    if strata_host(&state, parse_spec(&db).0).is_some() {
        return Err(strata_no_vector_collections());
    }
    let (h, _, _) = resolve_read(&state, &db, min_txid_of(&headers)).await?;
    let hits =
        memoturn_docstore::vectors::search(&h, &coll, &req.vector, capped(req.k.unwrap_or(10)))
            .await?;
    let hits: Vec<_> = hits
        .into_iter()
        .map(|hit| json!({ "id": hit.id, "distance": hit.distance }))
        .collect();
    Ok((txid_headers(h.txid()), Json(json!({ "hits": hits }))))
}

// ---- memory ----

#[derive(Deserialize)]
struct AppendTurn {
    role: String,
    content: serde_json::Value,
    #[serde(default)]
    embedding: Option<Vec<f32>>,
}

async fn memory_append(
    State(state): State<AppState>,
    Path((db, session)): Path<(String, String)>,
    Json(req): Json<serde_json::Value>,
) -> Result<Response, ApiError> {
    let parsed: AppendTurn = serde_json::from_value(req.clone())
        .map_err(|e| ApiError::new(StatusCode::BAD_REQUEST, e.to_string()))?;
    if let Some(host) = strata_host(&state, parse_spec(&db).0) {
        let d = match strata_backend::route_write(&state, &host, &db).await? {
            strata_backend::SRoute::Remote { addr } => {
                return forward(
                    &state,
                    &addr,
                    reqwest::Method::POST,
                    &format!("/v1/db/{db}/memory/{session}/turns"),
                    Some(req),
                    None,
                )
                .await
            }
            strata_backend::SRoute::Local(d) => d,
        };
        let (out, txid) = strata_backend::submit(
            &d,
            memoturn_strata::WriteRequest::TurnAppend {
                session: session.clone(),
                role: parsed.role,
                content: parsed.content,
                embedding: parsed.embedding,
            },
            false,
        )
        .await?;
        let seq = strata_backend::expect_seq(out)?;
        return Ok((
            StatusCode::CREATED,
            txid_headers(txid),
            Json(json!({ "seq": seq, "txid": txid })),
        )
            .into_response());
    }
    let l = route_write!(
        &state,
        &db,
        &format!("/v1/db/{db}/memory/{session}/turns"),
        req
    );
    let (seq, txid) = memoturn_docstore::memory::append_turn(
        &l.h,
        &session,
        &parsed.role,
        &parsed.content,
        parsed.embedding.as_deref(),
    )
    .await?;
    settle(&state, &l, false).await?;
    Ok((
        StatusCode::CREATED,
        txid_headers(txid),
        Json(json!({ "seq": seq, "txid": txid })),
    )
        .into_response())
}

async fn memory_window(
    State(state): State<AppState>,
    Path((db, session)): Path<(String, String)>,
    headers: HeaderMap,
    Query(q): Query<HashMap<String, String>>,
) -> Result<Response, ApiError> {
    let last: u32 = q.get("last").and_then(|s| s.parse().ok()).unwrap_or(20);
    if let Some(host) = strata_host(&state, parse_spec(&db).0) {
        let r = strata_backend::route_read(&state, &host, &db).await?;
        let turns = r
            .with_view(|v| memoturn_strata::surface::transcript::get_window(v, &session, last))
            .await?;
        return Ok((
            txid_headers(r.head().await),
            Json(json!({ "turns": turns })),
        )
            .into_response());
    }
    let (h, _, _) = resolve_read(&state, &db, min_txid_of(&headers)).await?;
    let turns = memoturn_docstore::memory::get_window(&h, &session, last).await?;
    Ok((txid_headers(h.txid()), Json(json!({ "turns": turns }))).into_response())
}

#[derive(Deserialize)]
struct MemorySearch {
    vector: Vec<f32>,
    #[serde(default)]
    k: Option<u32>,
}

async fn memory_search(
    State(state): State<AppState>,
    Path((db, session)): Path<(String, String)>,
    headers: HeaderMap,
    Json(req): Json<MemorySearch>,
) -> Result<Response, ApiError> {
    if let Some(host) = strata_host(&state, parse_spec(&db).0) {
        let r = strata_backend::route_read(&state, &host, &db).await?;
        let turns = r
            .with_view(|v| {
                memoturn_strata::surface::transcript::search(
                    v,
                    Some(&session),
                    &req.vector,
                    capped(req.k.unwrap_or(5)),
                )
            })
            .await?;
        return Ok((
            txid_headers(r.head().await),
            Json(json!({ "turns": turns })),
        )
            .into_response());
    }
    let (h, _, _) = resolve_read(&state, &db, min_txid_of(&headers)).await?;
    let turns = memoturn_docstore::memory::search_semantic(
        &h,
        &session,
        &req.vector,
        capped(req.k.unwrap_or(5)),
    )
    .await?;
    Ok((txid_headers(h.txid()), Json(json!({ "turns": turns }))).into_response())
}

// ---- agent memory: namespace > profile > memory (07, ADR-0009) ----
//
// A profile is one database named `{ns}--{profile}`; these routes build that
// spec and ride the standard write/read plumbing (forwarding, fencing, txid).
// Branch addressing comes via `?branch=` or the `Memoturn-Branch` header —
// forwarded hops carry it as the query param.

// Namespace/profile parts share auth's canonical validation (no trailing
// hyphen, no `--`), so the authz boundary and the route boundary agree on
// exactly which names are valid.
use auth::part_ok as ns_part_ok;

/// → (db name, branch). Reads with an unknown profile return empty results;
/// only ingest auto-creates (reads must never mutate the catalog).
fn profile_db(
    ns: &str,
    profile: &str,
    headers: &HeaderMap,
    q: &HashMap<String, String>,
) -> Result<(String, String), ApiError> {
    if !ns_part_ok(ns) || !ns_part_ok(profile) {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "invalid namespace or profile name",
        ));
    }
    let branch = q
        .get("branch")
        .map(String::as_str)
        .or_else(|| headers.get("Memoturn-Branch").and_then(|v| v.to_str().ok()))
        .unwrap_or("main")
        .to_string();
    Ok((format!("{ns}--{profile}"), branch))
}

/// Fill in embeddings for items that arrived without one (tasks skip the
/// vector channel by design). Best-effort: an embedding-provider failure must
/// never take down ingest — keyword and topic recall still work — so errors
/// log and degrade rather than fail the write. The `ai_egress.embed` policy
/// gates here (not at the edge handler) because a forwarded ingest embeds on
/// the owner node — this is the point where bytes would leave the cluster.
async fn auto_embed_items(
    state: &AppState,
    ns: &str,
    profile: &str,
    items: &mut [memoturn_docstore::memories::MemoryInput],
) {
    let Some(_embedder) = &state.embedder else {
        return;
    };
    let pending: Vec<usize> = items
        .iter()
        .enumerate()
        .filter(|(_, m)| {
            m.embedding.is_none() && m.mtype != memoturn_docstore::memories::MemoryType::Task
        })
        .map(|(i, _)| i)
        .collect();
    if pending.is_empty() {
        return;
    }
    let texts: Vec<String> = pending
        .iter()
        .map(|&i| {
            let m = &items[i];
            match &m.keywords {
                Some(k) if !k.is_empty() => format!("{} {k}", m.summary),
                _ => m.summary.clone(),
            }
        })
        .collect();
    let Some(vectors) = embed_texts(state, ns, profile, &texts, embed::EmbedKind::Document).await
    else {
        return;
    };
    for (&i, v) in pending.iter().zip(vectors) {
        items[i].embedding = Some(v);
    }
}

/// Embed a query/question for the vector channel. `None` = no embedder,
/// denied by policy, or provider failure — recall degrades to keyword+topic
/// either way.
async fn auto_embed_query(
    state: &AppState,
    ns: &str,
    profile: &str,
    text: &str,
) -> Option<Vec<f32>> {
    embed_texts(
        state,
        ns,
        profile,
        &[text.to_string()],
        embed::EmbedKind::Query,
    )
    .await?
    .pop()
}

/// The single embed egress point: policy gate, provider call, and the
/// `ai.embed` audit event all live here — including for forwarded ingests,
/// where this runs on the owner node (where the bytes would actually leave).
/// Best-effort: failures and denials degrade, never error.
async fn embed_texts(
    state: &AppState,
    ns: &str,
    profile: &str,
    texts: &[String],
    kind: embed::EmbedKind,
) -> Option<Vec<Vec<f32>>> {
    let embedder = state.embedder.as_ref()?;
    let eff = match state.governance.effective(ns, Some(profile)).await {
        Ok(eff) => eff,
        Err(e) => {
            tracing::warn!(ns, error = %e, "policy unavailable; skipping auto-embed (fail closed)");
            return None;
        }
    };
    let input_bytes = texts.iter().map(String::len).sum();
    if !governance::embed_rule_allows(&eff, state.embed_provenance.as_ref()) {
        tracing::debug!(ns, profile, "auto-embed skipped by policy");
        if eff.audit_enabled {
            state.audit.emit(
                audit::AuditEvent::new("ai.embed", ns)
                    .profile(profile)
                    .outcome("denied")
                    .egress(embed_egress_meta(state, texts.len(), input_bytes, 0)),
            );
        }
        return None;
    }
    let started = std::time::Instant::now();
    let result = embedder.embed(texts, kind).await;
    let duration_ms = started.elapsed().as_millis() as u64;
    match result {
        Ok(vectors) => {
            if eff.audit_enabled {
                let mut meta = embed_egress_meta(state, texts.len(), input_bytes, duration_ms);
                meta.output_items = Some(vectors.len());
                state.audit.emit(
                    audit::AuditEvent::new("ai.embed", ns)
                        .profile(profile)
                        .egress(meta),
                );
            }
            Some(vectors)
        }
        Err(e) => {
            tracing::warn!(error = %e, "auto-embedding failed; degrading to keyword/topic");
            if eff.audit_enabled {
                state.audit.emit(
                    audit::AuditEvent::new("ai.embed", ns)
                        .profile(profile)
                        .egress(embed_egress_meta(
                            state,
                            texts.len(),
                            input_bytes,
                            duration_ms,
                        ))
                        .error(e),
                );
            }
            None
        }
    }
}

fn embed_egress_meta(
    state: &AppState,
    input_items: usize,
    input_bytes: usize,
    duration_ms: u64,
) -> audit::EgressMeta {
    let p = state.embed_provenance.as_ref();
    audit::EgressMeta {
        provider: p
            .map(|p| p.provider.clone())
            .unwrap_or_else(|| "unknown".into()),
        model: p
            .map(|p| p.model.clone())
            .unwrap_or_else(|| "unknown".into()),
        endpoint_host: p.map(|p| p.endpoint_host.clone()),
        self_hosted: p.is_some_and(|p| p.self_hosted),
        input_items,
        input_bytes,
        output_items: None,
        duration_ms,
    }
}

/// `(enabled, include_reads)` audit gates for one profile. Audit is off when
/// the policy store is unreachable — no readable policy means no namespace
/// has turned the stream on.
async fn audit_gate(state: &AppState, ns: &str, profile: &str) -> (bool, bool) {
    match state.governance.effective(ns, Some(profile)).await {
        Ok(eff) => (eff.audit_enabled, eff.audit_include_reads),
        Err(_) => (false, false),
    }
}

/// Memory events are emitted at the edge (it holds the client's identity);
/// the owner of a forwarded write sees the internal actor and stays silent.
fn is_internal(actor: &Option<audit::Actor>) -> bool {
    actor.as_ref().is_some_and(|a| a.is_internal())
}

fn forwarded_txid(resp: &Response) -> Option<u64> {
    resp.headers()
        .get("Memoturn-Txid")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.parse().ok())
}

/// Clamp task TTLs to the namespace policy's `memory.task_ttl_max_secs`
/// (ADR-0010). Clamping (not rejecting) keeps ingest idempotent and agents
/// unmodified. The owner of a forwarded write re-clamps against the same
/// policy store, so its clamp is authoritative. A policy-store miss proceeds
/// uncapped: governance must not join the write path's failure domain
/// (fail-closed applies to auth and AI egress, not TTL caps).
async fn clamp_task_ttls(
    state: &AppState,
    ns: &str,
    profile: &str,
    items: &mut [memoturn_docstore::memories::MemoryInput],
) {
    match state.governance.effective(ns, Some(profile)).await {
        Ok(eff) => {
            if let Some(cap) = eff.task_ttl_max_secs {
                for m in items {
                    if m.mtype == memoturn_docstore::memories::MemoryType::Task {
                        let requested = m
                            .ttl_secs
                            .unwrap_or(memoturn_docstore::memories::DEFAULT_TASK_TTL_SECS);
                        m.ttl_secs = Some(requested.min(cap));
                    }
                }
            }
        }
        Err(e) => {
            tracing::warn!(ns, error = %e, "policy unavailable; ingesting without TTL caps")
        }
    }
}

#[derive(Deserialize)]
struct MemoryItemReq {
    #[serde(rename = "type")]
    mtype: String,
    #[serde(default)]
    topic_key: Option<String>,
    summary: String,
    #[serde(default)]
    content: serde_json::Value,
    #[serde(default)]
    keywords: Option<String>,
    #[serde(default)]
    embedding: Option<Vec<f32>>,
    #[serde(default)]
    session_id: Option<String>,
    #[serde(default)]
    source: Option<String>,
    #[serde(default)]
    ttl: Option<u64>,
}

#[derive(Deserialize)]
struct IngestReq {
    memories: Vec<MemoryItemReq>,
}

async fn memories_ingest(
    State(state): State<AppState>,
    Path((ns, profile)): Path<(String, String)>,
    headers: HeaderMap,
    Query(q): Query<HashMap<String, String>>,
    actor: Option<axum::Extension<audit::Actor>>,
    Json(req): Json<serde_json::Value>,
) -> Result<Response, ApiError> {
    let actor = actor.map(|e| e.0);
    let parsed: IngestReq = serde_json::from_value(req.clone())
        .map_err(|e| ApiError::new(StatusCode::BAD_REQUEST, e.to_string()))?;
    if parsed.memories.len() > MAX_INGEST_BATCH {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            format!("ingest batch exceeds {MAX_INGEST_BATCH} memories; split the request"),
        ));
    }
    let n_items = parsed.memories.len() as u64;
    let (name, branch) = profile_db(&ns, &profile, &headers, &q)?;
    ensure_profile(&state, &name).await?;
    let (audit_on, _) = audit_gate(&state, &ns, &profile).await;
    let spec = format!("{name}@{branch}");
    enum IngestRoute {
        Sql(LocalWrite),
        Strata(memoturn_strata::Db),
    }
    let route = if let Some(host) = strata_host(&state, &name) {
        match strata_backend::route_write(&state, &host, &spec).await? {
            strata_backend::SRoute::Local(d) => IngestRoute::Strata(d),
            strata_backend::SRoute::Remote { addr } => {
                let resp = forward(
                    &state,
                    &addr,
                    reqwest::Method::POST,
                    &format!("/v1/memory/{ns}/{profile}/memories?branch={}", enc(&branch)),
                    Some(req),
                    None,
                )
                .await?;
                if audit_on && !is_internal(&actor) {
                    let mut evt = audit::AuditEvent::new("memory.ingest", &ns)
                        .profile(&profile)
                        .branch(&branch)
                        .count(n_items)
                        .actor(actor.as_ref());
                    if let Some(t) = forwarded_txid(&resp) {
                        evt = evt.txid(t);
                    }
                    if !resp.status().is_success() {
                        evt = evt.outcome("error");
                    }
                    state.audit.emit(evt);
                }
                return Ok(resp);
            }
        }
    } else {
        match resolve_write(&state, &spec).await? {
            WriteRoute::Remote { addr } => {
                let resp = forward(
                    &state,
                    &addr,
                    reqwest::Method::POST,
                    &format!("/v1/memory/{ns}/{profile}/memories?branch={}", enc(&branch)),
                    Some(req),
                    None,
                )
                .await?;
                if audit_on && !is_internal(&actor) {
                    let mut evt = audit::AuditEvent::new("memory.ingest", &ns)
                        .profile(&profile)
                        .branch(&branch)
                        .count(n_items)
                        .actor(actor.as_ref());
                    if let Some(t) = forwarded_txid(&resp) {
                        evt = evt.txid(t);
                    }
                    if !resp.status().is_success() {
                        evt = evt.outcome("error");
                    }
                    state.audit.emit(evt);
                }
                return Ok(resp);
            }
            WriteRoute::Local(l) => IngestRoute::Sql(l),
        }
    };
    let items = parsed
        .memories
        .into_iter()
        .map(|m| {
            Ok(memoturn_docstore::memories::MemoryInput {
                mtype: memoturn_docstore::memories::MemoryType::parse(&m.mtype)?,
                topic_key: m.topic_key,
                summary: m.summary,
                content: m.content,
                keywords: m.keywords,
                embedding: m.embedding,
                session_id: m.session_id,
                source: m.source,
                ttl_secs: m.ttl,
            })
        })
        .collect::<Result<Vec<_>, memoturn_docstore::DocError>>()?;
    let mut items = items;
    clamp_task_ttls(&state, &ns, &profile, &mut items).await;
    auto_embed_items(&state, &ns, &profile, &mut items).await;
    let (results, txid): (Vec<serde_json::Value>, u64) = match route {
        IngestRoute::Strata(d) => {
            let items = strata_backend::to_strata_items(items)?;
            let (out, txid) = strata_backend::submit(
                &d,
                memoturn_strata::WriteRequest::MemIngest(items),
                request_durable(&headers),
            )
            .await?;
            let outcomes = strata_backend::expect_ingest(out)?;
            (
                outcomes
                    .into_iter()
                    .map(|o| json!({ "id": o.id, "status": o.status, "superseded": o.superseded }))
                    .collect(),
                txid,
            )
        }
        IngestRoute::Sql(l) => {
            let before = l.h.txid();
            let (outcomes, txid) = memoturn_docstore::memories::ingest(&l.h, items).await?;
            if txid > before {
                settle(&state, &l, request_durable(&headers)).await?;
            }
            (
                outcomes
                    .into_iter()
                    .map(|o| json!({ "id": o.id, "status": o.status, "superseded": o.superseded }))
                    .collect(),
                txid,
            )
        }
    };
    if audit_on && !is_internal(&actor) {
        state.audit.emit(
            audit::AuditEvent::new("memory.ingest", &ns)
                .profile(&profile)
                .branch(&branch)
                .txid(txid)
                .count(results.len() as u64)
                .actor(actor.as_ref()),
        );
    }
    Ok((
        StatusCode::CREATED,
        txid_headers(txid),
        Json(json!({ "results": results, "txid": txid })),
    )
        .into_response())
}

#[derive(Deserialize)]
struct ExtractReq {
    turns: Vec<extract::Turn>,
    #[serde(default)]
    session_id: Option<String>,
    #[serde(default)]
    source: Option<String>,
    /// Return the proposed memories without ingesting them.
    #[serde(default)]
    dry_run: bool,
}

/// Server-side extraction: LLM call first (out of the write path), then the
/// proposals ride the ordinary idempotent ingest — locally or forwarded to
/// the owner as a plain /memories request (the peer never re-extracts).
async fn memories_extract(
    State(state): State<AppState>,
    Path((ns, profile)): Path<(String, String)>,
    headers: HeaderMap,
    Query(q): Query<HashMap<String, String>>,
    actor: Option<axum::Extension<audit::Actor>>,
    Json(req): Json<serde_json::Value>,
) -> Result<Response, ApiError> {
    let actor = actor.map(|e| e.0);
    let turns_bytes = req["turns"].to_string().len();
    let parsed: ExtractReq = serde_json::from_value(req)
        .map_err(|e| ApiError::new(StatusCode::BAD_REQUEST, e.to_string()))?;
    let (name, branch) = profile_db(&ns, &profile, &headers, &q)?;
    let (audit_on, _) = audit_gate(&state, &ns, &profile).await;
    // Egress policy before anything else: this endpoint exists to send the
    // turns to the extractor model, so a denial is a deterministic 403.
    // Denials are audited regardless of `include_reads`.
    if let Err(e) =
        governance::check_egress(&state, &ns, &profile, governance::EgressOp::Extract).await
    {
        if audit_on {
            state.audit.emit(
                audit::AuditEvent::new("ai.extract", &ns)
                    .profile(&profile)
                    .outcome("denied")
                    .actor(actor.as_ref()),
            );
        }
        return Err(e);
    }
    let Some(extractor) = state.extractor.clone() else {
        return Err(ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "extraction is not configured on this node (set MEMOTURN_EXTRACT_API_KEY)",
        )
        .with_code(ErrorCode::Unconfigured));
    };
    if parsed.turns.is_empty() {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "turns must not be empty",
        ));
    }

    let started = std::time::Instant::now();
    let extracted = extractor.extract(&parsed.turns).await;
    let duration_ms = started.elapsed().as_millis() as u64;
    let mut egress_meta = governance::llm_egress_meta(
        governance::EgressOp::Extract,
        parsed.turns.len(),
        turns_bytes,
    );
    egress_meta.duration_ms = duration_ms;
    let extracted = match extracted {
        Ok(x) => {
            if audit_on {
                egress_meta.output_items = Some(x.len());
                state.audit.emit(
                    audit::AuditEvent::new("ai.extract", &ns)
                        .profile(&profile)
                        .egress(egress_meta)
                        .actor(actor.as_ref()),
                );
            }
            x
        }
        Err(e) => {
            if audit_on {
                state.audit.emit(
                    audit::AuditEvent::new("ai.extract", &ns)
                        .profile(&profile)
                        .egress(egress_meta)
                        .error(e.clone())
                        .actor(actor.as_ref()),
                );
            }
            return Err(ApiError::new(StatusCode::BAD_GATEWAY, e));
        }
    };
    let proposals: Vec<serde_json::Value> = extracted
        .iter()
        .map(|m| {
            let mut item = json!({
                "type": m.mtype,
                "summary": m.summary,
                "content": {"text": m.details},
                "keywords": m.keywords,
            });
            // Defensive: topic keys only exist on fact/instruction; drop any
            // the model put elsewhere rather than failing the whole batch.
            if matches!(m.mtype.as_str(), "fact" | "instruction") {
                if let Some(key) = &m.topic_key {
                    item["topic_key"] = json!(key);
                }
            }
            if let Some(sid) = &parsed.session_id {
                item["session_id"] = json!(sid);
            }
            if let Some(src) = &parsed.source {
                item["source"] = json!(src);
            }
            item
        })
        .collect();

    if parsed.dry_run {
        return Ok(Json(json!({ "proposed": proposals })).into_response());
    }
    if proposals.is_empty() {
        return Ok((
            StatusCode::CREATED,
            Json(json!({ "results": [], "txid": null })),
        )
            .into_response());
    }

    // Profiles auto-create on first ingest (same posture as /memories).
    ensure_profile(&state, &name).await?;
    let spec = format!("{name}@{branch}");
    let n_proposals = proposals.len() as u64;
    let ingest_body = json!({ "memories": proposals });
    if let Some(host) = strata_host(&state, &name) {
        let d = match strata_backend::route_write(&state, &host, &spec).await? {
            strata_backend::SRoute::Remote { addr } => {
                let resp = forward(
                    &state,
                    &addr,
                    reqwest::Method::POST,
                    &format!("/v1/memory/{ns}/{profile}/memories?branch={}", enc(&branch)),
                    Some(ingest_body),
                    None,
                )
                .await?;
                if audit_on && !is_internal(&actor) {
                    let mut evt = audit::AuditEvent::new("memory.extract", &ns)
                        .profile(&profile)
                        .branch(&branch)
                        .count(n_proposals)
                        .actor(actor.as_ref());
                    if let Some(t) = forwarded_txid(&resp) {
                        evt = evt.txid(t);
                    }
                    if !resp.status().is_success() {
                        evt = evt.outcome("error");
                    }
                    state.audit.emit(evt);
                }
                return Ok(resp);
            }
            strata_backend::SRoute::Local(d) => d,
        };
        let mut items = extracted
            .into_iter()
            .map(|m| {
                Ok(memoturn_docstore::memories::MemoryInput {
                    mtype: memoturn_docstore::memories::MemoryType::parse(&m.mtype)?,
                    topic_key: if matches!(m.mtype.as_str(), "fact" | "instruction") {
                        m.topic_key
                    } else {
                        None
                    },
                    summary: m.summary,
                    content: json!({"text": m.details}),
                    keywords: Some(m.keywords),
                    embedding: None,
                    session_id: parsed.session_id.clone(),
                    source: parsed.source.clone(),
                    ttl_secs: None,
                })
            })
            .collect::<Result<Vec<_>, memoturn_docstore::DocError>>()?;
        clamp_task_ttls(&state, &ns, &profile, &mut items).await;
        auto_embed_items(&state, &ns, &profile, &mut items).await;
        let sitems = strata_backend::to_strata_items(items)?;
        let (out, txid) = strata_backend::submit(
            &d,
            memoturn_strata::WriteRequest::MemIngest(sitems),
            request_durable(&headers),
        )
        .await?;
        let results: Vec<_> = strata_backend::expect_ingest(out)?
            .into_iter()
            .map(|o| json!({ "id": o.id, "status": o.status, "superseded": o.superseded }))
            .collect();
        if audit_on && !is_internal(&actor) {
            state.audit.emit(
                audit::AuditEvent::new("memory.extract", &ns)
                    .profile(&profile)
                    .branch(&branch)
                    .txid(txid)
                    .count(results.len() as u64)
                    .actor(actor.as_ref()),
            );
        }
        return Ok((
            StatusCode::CREATED,
            txid_headers(txid),
            Json(json!({ "results": results, "txid": txid })),
        )
            .into_response());
    }
    let l = match resolve_write(&state, &spec).await? {
        WriteRoute::Remote { addr } => {
            let resp = forward(
                &state,
                &addr,
                reqwest::Method::POST,
                &format!("/v1/memory/{ns}/{profile}/memories?branch={}", enc(&branch)),
                Some(ingest_body),
                None,
            )
            .await?;
            if audit_on && !is_internal(&actor) {
                let mut evt = audit::AuditEvent::new("memory.extract", &ns)
                    .profile(&profile)
                    .branch(&branch)
                    .count(n_proposals)
                    .actor(actor.as_ref());
                if let Some(t) = forwarded_txid(&resp) {
                    evt = evt.txid(t);
                }
                if !resp.status().is_success() {
                    evt = evt.outcome("error");
                }
                state.audit.emit(evt);
            }
            return Ok(resp);
        }
        WriteRoute::Local(l) => l,
    };
    let items = extracted
        .into_iter()
        .map(|m| {
            Ok(memoturn_docstore::memories::MemoryInput {
                mtype: memoturn_docstore::memories::MemoryType::parse(&m.mtype)?,
                topic_key: if matches!(m.mtype.as_str(), "fact" | "instruction") {
                    m.topic_key
                } else {
                    None
                },
                summary: m.summary,
                content: json!({"text": m.details}),
                keywords: Some(m.keywords),
                embedding: None,
                session_id: parsed.session_id.clone(),
                source: parsed.source.clone(),
                ttl_secs: None,
            })
        })
        .collect::<Result<Vec<_>, memoturn_docstore::DocError>>()?;
    let mut items = items;
    clamp_task_ttls(&state, &ns, &profile, &mut items).await;
    auto_embed_items(&state, &ns, &profile, &mut items).await;
    let before = l.h.txid();
    let (outcomes, txid) = memoturn_docstore::memories::ingest(&l.h, items).await?;
    if txid > before {
        settle(&state, &l, request_durable(&headers)).await?;
    }
    let results: Vec<_> = outcomes
        .into_iter()
        .map(|o| json!({ "id": o.id, "status": o.status, "superseded": o.superseded }))
        .collect();
    if audit_on && !is_internal(&actor) {
        state.audit.emit(
            audit::AuditEvent::new("memory.extract", &ns)
                .profile(&profile)
                .branch(&branch)
                .txid(txid)
                .count(results.len() as u64)
                .actor(actor.as_ref()),
        );
    }
    Ok((
        StatusCode::CREATED,
        txid_headers(txid),
        Json(json!({ "results": results, "txid": txid })),
    )
        .into_response())
}

#[derive(Deserialize)]
struct RecallReq {
    #[serde(default)]
    query: Option<String>,
    #[serde(default)]
    embedding: Option<Vec<f32>>,
    #[serde(default)]
    topic_key: Option<String>,
    #[serde(default)]
    types: Option<Vec<String>>,
    #[serde(default)]
    session_id: Option<String>,
    #[serde(default)]
    source: Option<String>,
    #[serde(default)]
    k: Option<u32>,
    #[serde(default)]
    include_superseded: bool,
    /// Raw-turn channel: also search the verbatim transcript (needs `embedding`).
    #[serde(default)]
    include_turns: bool,
}

async fn memories_recall(
    State(state): State<AppState>,
    Path((ns, profile)): Path<(String, String)>,
    headers: HeaderMap,
    Query(q): Query<HashMap<String, String>>,
    actor: Option<axum::Extension<audit::Actor>>,
    Json(req): Json<RecallReq>,
) -> Result<Response, ApiError> {
    let actor = actor.map(|e| e.0);
    let (name, branch) = profile_db(&ns, &profile, &headers, &q)?;
    // Unknown profile: empty recall, not 404 — reads never create. But a caller
    // demanding read-your-writes (Min-Txid) needs an error, not a silent txid 0
    // below its watermark, so it can distinguish "no memories" from "wrong
    // profile / not yet replicated here".
    if state.registry.get(&name).await.is_err() {
        if min_txid_of(&headers).is_some_and(|m| m > 0) {
            return Err(ApiError::new(StatusCode::NOT_FOUND, "profile not found"));
        }
        return Ok((txid_headers(0), Json(json!({ "memories": [], "txid": 0 }))).into_response());
    }
    let spec = format!("{name}@{branch}");
    let types = req
        .types
        .map(|ts| {
            ts.iter()
                .map(|t| memoturn_docstore::memories::MemoryType::parse(t))
                .collect::<Result<Vec<_>, _>>()
        })
        .transpose()?;
    let k = capped(req.k.unwrap_or(8));
    // Auto-embed bare query strings so the vector (and raw-turn) channels work
    // for text-only clients. Best-effort and policy-gated: on provider failure
    // or an embed-deny policy, recall degrades to keyword+topic.
    let mut embedding = req.embedding;
    if embedding.is_none() {
        if let Some(query) = &req.query {
            embedding = auto_embed_query(&state, &ns, &profile, query).await;
        }
    }
    // Engine dispatch: identical query semantics, same RRF channels/weights.
    let (memories, turns, txid) = if let Some(host) = strata_host(&state, &name) {
        let r = strata_backend::route_read(&state, &host, &spec).await?;
        let sq = memoturn_strata::RecallQuery {
            query: req.query,
            embedding: embedding.clone(),
            topic_key: req.topic_key,
            types: strata_backend::to_strata_types(types)?,
            session_id: req.session_id.clone(),
            source: req.source,
            k,
            include_superseded: req.include_superseded,
        };
        let memories = r
            .with_view(|v| memoturn_strata::surface::memory::recall(v, &sq))
            .await?;
        let turns = if req.include_turns {
            let Some(emb) = &embedding else {
                return Err(recall_needs_embedding());
            };
            Some(
                r.with_view(|v| {
                    memoturn_strata::surface::transcript::search(
                        v,
                        req.session_id.as_deref(),
                        emb,
                        k,
                    )
                })
                .await?,
            )
        } else {
            None
        };
        (memories, turns, r.head().await)
    } else {
        let (h, _, _) = resolve_read(&state, &spec, min_txid_of(&headers)).await?;
        let memories = memoturn_docstore::memories::recall(
            &h,
            &memoturn_docstore::memories::RecallQuery {
                query: req.query,
                embedding: embedding.clone(),
                topic_key: req.topic_key,
                types,
                session_id: req.session_id.clone(),
                source: req.source,
                k,
                include_superseded: req.include_superseded,
            },
        )
        .await?;
        let turns = if req.include_turns {
            let Some(emb) = &embedding else {
                return Err(recall_needs_embedding());
            };
            Some(
                memoturn_docstore::memory::search_turns(&h, req.session_id.as_deref(), emb, k)
                    .await?,
            )
        } else {
            None
        };
        (memories, turns, h.txid())
    };
    let (audit_on, include_reads) = audit_gate(&state, &ns, &profile).await;
    if audit_on && include_reads {
        state.audit.emit(
            audit::AuditEvent::new("memory.recall", &ns)
                .profile(&profile)
                .branch(&branch)
                .txid(txid)
                .count(memories.len() as u64)
                .actor(actor.as_ref()),
        );
    }
    // Raw-turn channel: verbatim transcript moments alongside (not fused
    // with) typed memories — turns aren't memories, so they rank separately.
    let mut body = json!({ "memories": memories, "txid": txid });
    if let Some(turns) = turns {
        body["turns"] = json!(turns);
    }
    Ok((txid_headers(txid), Json(body)).into_response())
}

fn recall_needs_embedding() -> ApiError {
    ApiError::new(
        StatusCode::BAD_REQUEST,
        "include_turns requires an embedding (or a query + a configured, policy-permitted embedder)",
    )
}

#[derive(Deserialize)]
struct AskReq {
    question: String,
    #[serde(default)]
    types: Option<Vec<String>>,
    #[serde(default)]
    session_id: Option<String>,
    #[serde(default)]
    source: Option<String>,
    #[serde(default)]
    k: Option<u32>,
    #[serde(default)]
    include_superseded: bool,
}

/// Recall answer synthesis: hybrid recall over the profile, then the
/// control-plane LLM turns the recalled memories into a grounded prose
/// answer with cited sources. Read-only — the synthesizer never sees
/// anything recall would not have returned to this caller.
async fn memories_ask(
    State(state): State<AppState>,
    Path((ns, profile)): Path<(String, String)>,
    headers: HeaderMap,
    Query(q): Query<HashMap<String, String>>,
    actor: Option<axum::Extension<audit::Actor>>,
    Json(req): Json<AskReq>,
) -> Result<Response, ApiError> {
    let actor = actor.map(|e| e.0);
    let Some(answerer) = state.answerer.clone() else {
        return Err(ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "answer synthesis is not configured on this node (set MEMOTURN_ASSISTANT_API_KEY)",
        )
        .with_code(ErrorCode::Unconfigured));
    };
    if req.question.trim().is_empty() {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "question must not be empty",
        ));
    }
    let (name, branch) = profile_db(&ns, &profile, &headers, &q)?;
    let (audit_on, include_reads) = audit_gate(&state, &ns, &profile).await;
    // Egress policy before recall runs — don't pay recall cost for a denied
    // request, and the endpoint's purpose is the model call (deny = 403).
    // Denials are audited regardless of `include_reads`.
    if let Err(e) = governance::check_egress(&state, &ns, &profile, governance::EgressOp::Ask).await
    {
        if audit_on {
            state.audit.emit(
                audit::AuditEvent::new("ai.ask", &ns)
                    .profile(&profile)
                    .outcome("denied")
                    .actor(actor.as_ref()),
            );
        }
        return Err(e);
    }
    // Unknown profile: no memories, no LLM call — same read posture as recall.
    if state.registry.get(&name).await.is_err() {
        return Ok((
            txid_headers(0),
            Json(json!({ "answer": null, "sources": [], "memories": [], "txid": 0 })),
        )
            .into_response());
    }
    let spec = format!("{name}@{branch}");
    let types = req
        .types
        .map(|ts| {
            ts.iter()
                .map(|t| memoturn_docstore::memories::MemoryType::parse(t))
                .collect::<Result<Vec<_>, _>>()
        })
        .transpose()?;
    // Auto-embed the question so the vector channel contributes (best-effort,
    // same degradation and policy gate as recall).
    let embedding = auto_embed_query(&state, &ns, &profile, &req.question).await;
    let (memories, txid) = if let Some(host) = strata_host(&state, &name) {
        let r = strata_backend::route_read(&state, &host, &spec).await?;
        let sq = memoturn_strata::RecallQuery {
            query: Some(req.question.clone()),
            embedding,
            topic_key: None,
            types: strata_backend::to_strata_types(types)?,
            session_id: req.session_id,
            source: req.source,
            k: capped(req.k.unwrap_or(8)),
            include_superseded: req.include_superseded,
        };
        let memories = r
            .with_view(|v| memoturn_strata::surface::memory::recall(v, &sq))
            .await?;
        (memories, r.head().await)
    } else {
        let (h, _, _) = resolve_read(&state, &spec, min_txid_of(&headers)).await?;
        let memories = memoturn_docstore::memories::recall(
            &h,
            &memoturn_docstore::memories::RecallQuery {
                query: Some(req.question.clone()),
                embedding,
                topic_key: None,
                types,
                session_id: req.session_id,
                source: req.source,
                k: capped(req.k.unwrap_or(8)),
                include_superseded: req.include_superseded,
            },
        )
        .await?;
        (memories, h.txid())
    };
    if audit_on && include_reads {
        state.audit.emit(
            audit::AuditEvent::new("memory.ask", &ns)
                .profile(&profile)
                .branch(&branch)
                .txid(txid)
                .count(memories.len() as u64)
                .actor(actor.as_ref()),
        );
    }
    if memories.is_empty() {
        return Ok((
            txid_headers(txid),
            Json(json!({ "answer": null, "sources": [], "memories": [], "txid": txid })),
        )
            .into_response());
    }
    let started = std::time::Instant::now();
    let answered = answerer.answer(&req.question, &memories).await;
    let mut egress_meta = governance::llm_egress_meta(
        governance::EgressOp::Ask,
        memories.len(),
        serde_json::to_string(&memories)
            .map(|s| s.len())
            .unwrap_or(0),
    );
    egress_meta.duration_ms = started.elapsed().as_millis() as u64;
    let out = match answered {
        Ok(out) => {
            if audit_on {
                state.audit.emit(
                    audit::AuditEvent::new("ai.ask", &ns)
                        .profile(&profile)
                        .egress(egress_meta)
                        .actor(actor.as_ref()),
                );
            }
            out
        }
        Err(e) => {
            if audit_on {
                state.audit.emit(
                    audit::AuditEvent::new("ai.ask", &ns)
                        .profile(&profile)
                        .egress(egress_meta)
                        .error(e.clone())
                        .actor(actor.as_ref()),
                );
            }
            return Err(ApiError::new(StatusCode::BAD_GATEWAY, e));
        }
    };
    Ok((
        txid_headers(txid),
        Json(json!({
            "answer": out.answer,
            "sources": out.sources,
            "memories": memories,
            "txid": txid,
        })),
    )
        .into_response())
}

async fn memories_get(
    State(state): State<AppState>,
    Path((ns, profile, id)): Path<(String, String, String)>,
    headers: HeaderMap,
    Query(q): Query<HashMap<String, String>>,
    actor: Option<axum::Extension<audit::Actor>>,
) -> Result<Response, ApiError> {
    let actor = actor.map(|e| e.0);
    let (name, branch) = profile_db(&ns, &profile, &headers, &q)?;
    let spec = format!("{name}@{branch}");
    let (found, txid) = if let Some(host) = strata_host(&state, &name) {
        let r = strata_backend::route_read(&state, &host, &spec).await?;
        let found = r
            .with_view(|v| memoturn_strata::surface::memory::get(v, &id))
            .await?;
        (found, r.head().await)
    } else {
        let (h, _, _) = resolve_read(&state, &spec, min_txid_of(&headers)).await?;
        (memoturn_docstore::memories::get(&h, &id).await?, h.txid())
    };
    match found {
        Some(memory) => {
            let (audit_on, include_reads) = audit_gate(&state, &ns, &profile).await;
            if audit_on && include_reads {
                state.audit.emit(
                    audit::AuditEvent::new("memory.get", &ns)
                        .profile(&profile)
                        .branch(&branch)
                        .resource(&id)
                        .txid(txid)
                        .actor(actor.as_ref()),
                );
            }
            Ok((txid_headers(txid), Json(memory)).into_response())
        }
        None => Err(ApiError::new(StatusCode::NOT_FOUND, "memory not found")),
    }
}

async fn memories_forget(
    State(state): State<AppState>,
    Path((ns, profile, id)): Path<(String, String, String)>,
    headers: HeaderMap,
    Query(q): Query<HashMap<String, String>>,
    actor: Option<axum::Extension<audit::Actor>>,
) -> Result<Response, ApiError> {
    let actor = actor.map(|e| e.0);
    let (name, branch) = profile_db(&ns, &profile, &headers, &q)?;
    let eff = state
        .governance
        .effective(&ns, Some(&profile))
        .await
        .unwrap_or_default();
    let audit_on = eff.audit_enabled;
    let spec = format!("{name}@{branch}");
    if let Some(host) = strata_host(&state, &name) {
        let d = match strata_backend::route_write(&state, &host, &spec).await? {
            strata_backend::SRoute::Remote { addr } => {
                let resp = forward(
                    &state,
                    &addr,
                    reqwest::Method::DELETE,
                    &format!(
                        "/v1/memory/{ns}/{profile}/memories/{}?branch={}",
                        enc(&id),
                        enc(&branch)
                    ),
                    None,
                    None,
                )
                .await?;
                if audit_on && !is_internal(&actor) && resp.status().is_success() {
                    let mut evt = audit::AuditEvent::new("memory.forget", &ns)
                        .profile(&profile)
                        .branch(&branch)
                        .resource(&id)
                        .actor(actor.as_ref());
                    if let Some(t) = forwarded_txid(&resp) {
                        evt = evt.txid(t);
                    }
                    state.audit.emit(evt);
                }
                return Ok(resp);
            }
            strata_backend::SRoute::Local(d) => d,
        };
        let (out, txid) = strata_backend::submit(
            &d,
            memoturn_strata::WriteRequest::MemForget { id: id.clone() },
            request_durable(&headers),
        )
        .await?;
        if strata_backend::expect_count(out)? == 0 {
            return Err(ApiError::new(StatusCode::NOT_FOUND, "memory not found"));
        }
        let mut resp_headers = txid_headers(txid);
        // `purge_on_forget` upgrades the forget into a tracked erasure. No
        // secure_delete equivalent is needed: the history rewrite is a
        // filtered compaction into new objects (ADR-0011). Flush first — the
        // coupon must never promise an erasure whose post-`T` state is not
        // yet in object storage.
        if eff.purge_on_forget {
            d.flush().await?;
            let rec = state.registry.get(&name).await?;
            let target = memoturn_governance::ErasureTarget {
                memory_id: Some(id.clone()),
                ..Default::default()
            };
            let coupon = create_erasure_coupon_at(
                &state,
                &ns,
                &profile,
                &rec.uuid,
                &branch,
                target,
                vec![id.clone()],
                txid,
                &actor,
            )
            .await?;
            if let Ok(v) = coupon.id.parse() {
                resp_headers.insert("Memoturn-Erasure-Id", v);
            }
        }
        if audit_on && !is_internal(&actor) {
            state.audit.emit(
                audit::AuditEvent::new("memory.forget", &ns)
                    .profile(&profile)
                    .branch(&branch)
                    .resource(&id)
                    .txid(txid)
                    .actor(actor.as_ref()),
            );
        }
        return Ok((resp_headers, StatusCode::NO_CONTENT).into_response());
    }
    let l = match resolve_write(&state, &spec).await? {
        WriteRoute::Remote { addr } => {
            let resp = forward(
                &state,
                &addr,
                reqwest::Method::DELETE,
                &format!(
                    "/v1/memory/{ns}/{profile}/memories/{}?branch={}",
                    enc(&id),
                    enc(&branch)
                ),
                None,
                None,
            )
            .await?;
            if audit_on && !is_internal(&actor) && resp.status().is_success() {
                let mut evt = audit::AuditEvent::new("memory.forget", &ns)
                    .profile(&profile)
                    .branch(&branch)
                    .resource(&id)
                    .actor(actor.as_ref());
                if let Some(t) = forwarded_txid(&resp) {
                    evt = evt.txid(t);
                }
                state.audit.emit(evt);
            }
            return Ok(resp);
        }
        WriteRoute::Local(l) => l,
    };
    // `erasure.purge_on_forget` upgrades a plain forget into a tracked
    // erasure: secure_delete page zeroing now, coupon + history rewrite after
    // the grace window. The coupon id rides a response header.
    let purge = eff.purge_on_forget;
    if purge {
        l.h.set_secure_delete(true).await?;
    }
    let forgotten = memoturn_docstore::memories::forget(&l.h, &id).await;
    if purge {
        let _ = l.h.set_secure_delete(false).await;
    }
    let (deleted, txid) = forgotten?;
    if deleted == 0 {
        return Err(ApiError::new(StatusCode::NOT_FOUND, "memory not found"));
    }
    let mut resp_headers = txid_headers(txid);
    if purge {
        // The coupon path ships durably — it supersedes the plain settle.
        let target = memoturn_governance::ErasureTarget {
            memory_id: Some(id.clone()),
            ..Default::default()
        };
        let coupon = create_erasure_coupon(
            &state,
            &ns,
            &profile,
            &l,
            target,
            vec![id.clone()],
            txid,
            &actor,
        )
        .await?;
        if let Ok(v) = coupon.id.parse() {
            resp_headers.insert("Memoturn-Erasure-Id", v);
        }
    } else {
        settle(&state, &l, false).await?;
    }
    if audit_on && !is_internal(&actor) {
        state.audit.emit(
            audit::AuditEvent::new("memory.forget", &ns)
                .profile(&profile)
                .branch(&branch)
                .resource(&id)
                .txid(txid)
                .actor(actor.as_ref()),
        );
    }
    Ok((resp_headers, StatusCode::NO_CONTENT).into_response())
}

async fn memory_sessions_list(
    State(state): State<AppState>,
    Path((ns, profile)): Path<(String, String)>,
    headers: HeaderMap,
    Query(q): Query<HashMap<String, String>>,
) -> Result<Response, ApiError> {
    let (name, branch) = profile_db(&ns, &profile, &headers, &q)?;
    if state.registry.get(&name).await.is_err() {
        if min_txid_of(&headers).is_some_and(|m| m > 0) {
            return Err(ApiError::new(StatusCode::NOT_FOUND, "profile not found"));
        }
        return Ok((txid_headers(0), Json(json!({ "sessions": [], "txid": 0 }))).into_response());
    }
    let spec = format!("{name}@{branch}");
    let limit: u32 = capped(q.get("limit").and_then(|s| s.parse().ok()).unwrap_or(100));
    let (sessions, txid) = if let Some(host) = strata_host(&state, &name) {
        let r = strata_backend::route_read(&state, &host, &spec).await?;
        let sessions = r
            .with_view(|v| memoturn_strata::surface::memory::list_sessions(v, limit))
            .await?;
        (sessions, r.head().await)
    } else {
        let (h, _, _) = resolve_read(&state, &spec, min_txid_of(&headers)).await?;
        (
            memoturn_docstore::memories::list_sessions(&h, limit).await?,
            h.txid(),
        )
    };
    Ok((
        txid_headers(txid),
        Json(json!({ "sessions": sessions, "txid": txid })),
    )
        .into_response())
}

/// End a session: its task memories go; durable memories survive. With
/// `?turns=true` the raw transcript goes too.
async fn memory_session_end(
    State(state): State<AppState>,
    Path((ns, profile, sid)): Path<(String, String, String)>,
    headers: HeaderMap,
    Query(q): Query<HashMap<String, String>>,
    actor: Option<axum::Extension<audit::Actor>>,
) -> Result<Response, ApiError> {
    let actor = actor.map(|e| e.0);
    let (name, branch) = profile_db(&ns, &profile, &headers, &q)?;
    let drop_turns = q.get("turns").map(String::as_str) == Some("true");
    let (audit_on, _) = audit_gate(&state, &ns, &profile).await;
    // The resource records whether the transcript went too.
    let resource = if drop_turns {
        format!("session:{sid}?turns=true")
    } else {
        format!("session:{sid}")
    };
    let spec = format!("{name}@{branch}");
    if let Some(host) = strata_host(&state, &name) {
        let d = match strata_backend::route_write(&state, &host, &spec).await? {
            strata_backend::SRoute::Remote { addr } => {
                let turns_qs = if drop_turns { "&turns=true" } else { "" };
                let resp = forward(
                    &state,
                    &addr,
                    reqwest::Method::DELETE,
                    &format!(
                        "/v1/memory/{ns}/{profile}/sessions/{}?branch={}{turns_qs}",
                        enc(&sid),
                        enc(&branch)
                    ),
                    None,
                    None,
                )
                .await?;
                if audit_on && !is_internal(&actor) && resp.status().is_success() {
                    let mut evt = audit::AuditEvent::new("memory.session_end", &ns)
                        .profile(&profile)
                        .branch(&branch)
                        .resource(&resource)
                        .actor(actor.as_ref());
                    if let Some(t) = forwarded_txid(&resp) {
                        evt = evt.txid(t);
                    }
                    state.audit.emit(evt);
                }
                return Ok(resp);
            }
            strata_backend::SRoute::Local(d) => d,
        };
        let (_, txid) = strata_backend::submit(
            &d,
            memoturn_strata::WriteRequest::MemEndSession {
                session: sid.clone(),
                drop_turns,
            },
            false,
        )
        .await?;
        if audit_on && !is_internal(&actor) {
            state.audit.emit(
                audit::AuditEvent::new("memory.session_end", &ns)
                    .profile(&profile)
                    .branch(&branch)
                    .resource(&resource)
                    .txid(txid)
                    .actor(actor.as_ref()),
            );
        }
        return Ok((txid_headers(txid), StatusCode::NO_CONTENT).into_response());
    }
    let l = match resolve_write(&state, &spec).await? {
        WriteRoute::Remote { addr } => {
            let turns_qs = if drop_turns { "&turns=true" } else { "" };
            let resp = forward(
                &state,
                &addr,
                reqwest::Method::DELETE,
                &format!(
                    "/v1/memory/{ns}/{profile}/sessions/{}?branch={}{turns_qs}",
                    enc(&sid),
                    enc(&branch)
                ),
                None,
                None,
            )
            .await?;
            if audit_on && !is_internal(&actor) && resp.status().is_success() {
                let mut evt = audit::AuditEvent::new("memory.session_end", &ns)
                    .profile(&profile)
                    .branch(&branch)
                    .resource(&resource)
                    .actor(actor.as_ref());
                if let Some(t) = forwarded_txid(&resp) {
                    evt = evt.txid(t);
                }
                state.audit.emit(evt);
            }
            return Ok(resp);
        }
        WriteRoute::Local(l) => l,
    };
    let mut txid = memoturn_docstore::memories::end_session(&l.h, &sid).await?;
    if drop_turns {
        txid = memoturn_docstore::memory::drop_session(&l.h, &sid).await?;
    }
    settle(&state, &l, false).await?;
    if audit_on && !is_internal(&actor) {
        state.audit.emit(
            audit::AuditEvent::new("memory.session_end", &ns)
                .profile(&profile)
                .branch(&branch)
                .resource(&resource)
                .txid(txid)
                .actor(actor.as_ref()),
        );
    }
    Ok((txid_headers(txid), StatusCode::NO_CONTENT).into_response())
}

/// Profiles under a namespace (registry prefix scan; namespace tokens only).
async fn profiles_list(
    State(state): State<AppState>,
    Path(ns): Path<String>,
) -> Result<Response, ApiError> {
    if !ns_part_ok(&ns) {
        return Err(ApiError::new(StatusCode::BAD_REQUEST, "invalid namespace"));
    }
    let prefix = format!("{ns}--");
    // The registry prefix scan is a byte range, so a sibling namespace whose
    // name sorts inside `{ns}--` could appear; keep only remainders that are a
    // single valid profile part (the same anchor covers_db enforces).
    let profiles: Vec<_> = state
        .registry
        .list_prefix(&prefix)
        .await?
        .into_iter()
        .filter_map(|rec| {
            let profile = rec.name.strip_prefix(&prefix).filter(|p| ns_part_ok(p))?;
            Some(json!({ "profile": profile, "created_at": rec.created_at }))
        })
        .collect();
    Ok(Json(json!({ "namespace": ns, "profiles": profiles })).into_response())
}

#[derive(Deserialize)]
struct CreateNsToken {
    scope: auth::Scope,
    #[serde(default)]
    expires_in: Option<u64>,
}

/// Mint a namespace token (platform-key protected by the middleware): covers
/// every memory profile under the namespace.
async fn create_ns_token(
    State(state): State<AppState>,
    Path(ns): Path<String>,
    Json(req): Json<CreateNsToken>,
) -> Result<impl IntoResponse, ApiError> {
    let auth::Auth::Enabled(keys) = &state.auth else {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "auth is disabled on this node",
        ));
    };
    if !ns_part_ok(&ns) {
        return Err(ApiError::new(StatusCode::BAD_REQUEST, "invalid namespace"));
    }
    let ttl = req.expires_in.unwrap_or(3600) as i64;
    let token = keys
        .mint_ns(&ns, req.scope, ttl)
        .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, e))?;
    // Namespace-token mints gate on the namespace-level audit policy.
    if let Ok(eff) = state.governance.effective(&ns, None).await {
        if eff.audit_enabled {
            state.audit.emit(
                audit::AuditEvent::new("token.mint", &ns)
                    .resource(format!("ns:{ns} scope={:?} ttl={ttl}", req.scope))
                    .actor(Some(&audit::Actor::platform())),
            );
        }
    }
    Ok((
        StatusCode::CREATED,
        Json(json!({ "token": token, "expires_in": ttl })),
    ))
}

// ---- data governance: namespace policy + profile overrides (ADR-0010) ----

#[derive(Deserialize)]
struct PolicyPut {
    /// The policy sections to set. `null` clears a profile override.
    policy: serde_json::Value,
}

fn parse_policy(v: serde_json::Value) -> Result<governance::Policy, ApiError> {
    serde_json::from_value(v).map_err(|e| ApiError::new(StatusCode::BAD_REQUEST, e.to_string()))
}

/// Namespace policy (platform key via the `/v1/namespaces` middleware gate).
async fn ns_policy_get(
    State(state): State<AppState>,
    Path(ns): Path<String>,
) -> Result<Response, ApiError> {
    if !ns_part_ok(&ns) {
        return Err(ApiError::new(StatusCode::BAD_REQUEST, "invalid namespace"));
    }
    match state.governance.get(&ns).await? {
        Some(doc) => Ok(Json(json!({
            "namespace": doc.namespace,
            "revision": doc.revision,
            "updated_at": doc.updated_at,
            "policy": doc.policy,
            "profiles": doc.profiles,
        }))
        .into_response()),
        None => Err(ApiError::new(
            StatusCode::NOT_FOUND,
            format!("no policy set for namespace '{ns}'"),
        )),
    }
}

async fn ns_policy_put(
    State(state): State<AppState>,
    Path(ns): Path<String>,
    Json(req): Json<PolicyPut>,
) -> Result<Response, ApiError> {
    if !ns_part_ok(&ns) {
        return Err(ApiError::new(StatusCode::BAD_REQUEST, "invalid namespace"));
    }
    let policy = parse_policy(req.policy)?;
    let doc = state.governance.put_namespace(&ns, policy).await?;
    // Gate on the NEW policy so the change that turns audit on is itself the
    // stream's first record.
    if doc.effective(None).audit_enabled {
        state.audit.emit(
            audit::AuditEvent::new("policy.update", &ns)
                .resource(format!("policy:{ns}"))
                .count(doc.revision)
                .actor(Some(&audit::Actor::platform())),
        );
    }
    Ok(Json(json!({
        "namespace": doc.namespace,
        "revision": doc.revision,
        "updated_at": doc.updated_at,
        "policy": doc.policy,
    }))
    .into_response())
}

/// Profile policy view: the override (if any) plus the effective policy with
/// the node env ceilings folded in — what will actually be enforced.
async fn profile_policy_get(
    State(state): State<AppState>,
    Path((ns, profile)): Path<(String, String)>,
) -> Result<Response, ApiError> {
    if !ns_part_ok(&ns) || !ns_part_ok(&profile) {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "invalid namespace or profile name",
        ));
    }
    let doc = state.governance.get(&ns).await?;
    let over = doc.as_ref().and_then(|d| d.profiles.get(&profile));
    let mut eff = doc
        .as_ref()
        .map(|d| d.effective(Some(&profile)))
        .unwrap_or_default();
    governance::fold_env_ceilings(&mut eff);
    Ok(Json(json!({
        "namespace": ns,
        "profile": profile,
        "override": over,
        "effective": eff,
        "revision": doc.as_ref().map(|d| d.revision).unwrap_or(0),
    }))
    .into_response())
}

#[derive(Deserialize)]
struct AuditReadParams {
    /// Unix ms; defaults to `to - 24h`.
    from: Option<i64>,
    /// Unix ms; defaults to now.
    to: Option<i64>,
    /// Exact action, or a `.`-terminated prefix (`ai.`).
    action: Option<String>,
    profile: Option<String>,
    outcome: Option<String>,
    limit: Option<u32>,
    cursor: Option<String>,
}

/// Page through a namespace's audit stream, oldest first.
async fn ns_audit_read(
    State(state): State<AppState>,
    Path(ns): Path<String>,
    Query(p): Query<AuditReadParams>,
) -> Result<Response, ApiError> {
    if !ns_part_ok(&ns) {
        return Err(ApiError::new(StatusCode::BAD_REQUEST, "invalid namespace"));
    }
    let to_ms = p.to.unwrap_or_else(now_ms);
    let q = audit::AuditQuery {
        from_ms: p.from.unwrap_or(to_ms - 86_400_000),
        to_ms,
        action: p.action,
        profile: p.profile,
        outcome: p.outcome,
        limit: capped(p.limit.unwrap_or(100)) as usize,
        cursor: p.cursor,
    };
    let page = state
        .audit
        .read_range(&ns, &q)
        .await
        .map_err(|e| ApiError::new(StatusCode::BAD_REQUEST, e))?;
    Ok(Json(json!({
        "events": page.events,
        "next_cursor": page.next_cursor,
        "complete": page.complete,
    }))
    .into_response())
}

/// Bound each namespace's audit stream to its `audit.retention_secs` policy
/// (maintenance loop, same cadence as the other object-storage passes). Day
/// granularity: a day prefix is deleted once wholly past the cutoff.
pub async fn sweep_audit_retention(state: &AppState) -> usize {
    let Ok(docs) = state.governance.list().await else {
        return 0;
    };
    let mut n = 0;
    for doc in docs {
        if let Some(secs) = doc.effective(None).audit_retention_secs {
            n += state.audit.sweep_retention(&doc.namespace, secs).await;
        }
    }
    n
}

// ---- verifiable erasure (ADR-0010 phase 3) ----

#[derive(Deserialize)]
struct EraseReq {
    /// Erase one memory by id.
    #[serde(default)]
    memory_id: Option<String>,
    /// Erase a whole topic — the active row and its supersession chain.
    #[serde(default)]
    topic_key: Option<String>,
    #[serde(rename = "type", default)]
    mtype: Option<String>,
    /// Erase a session's task memories; `turns: true` drops its transcript.
    #[serde(default)]
    session_id: Option<String>,
    #[serde(default)]
    turns: bool,
}

/// Hard-forget now (with `secure_delete` page zeroing), durably ship the
/// post-forget state, and record an erasure coupon promising that after the
/// grace window every trace below the forget txid leaves object storage —
/// verified and receipted by the maintenance loop.
async fn memories_erase(
    State(state): State<AppState>,
    Path((ns, profile)): Path<(String, String)>,
    headers: HeaderMap,
    Query(q): Query<HashMap<String, String>>,
    actor: Option<axum::Extension<audit::Actor>>,
    Json(req): Json<serde_json::Value>,
) -> Result<Response, ApiError> {
    let actor = actor.map(|e| e.0);
    let parsed: EraseReq = serde_json::from_value(req.clone())
        .map_err(|e| ApiError::new(StatusCode::BAD_REQUEST, e.to_string()))?;
    let targets = [
        parsed.memory_id.is_some(),
        parsed.topic_key.is_some(),
        parsed.session_id.is_some(),
    ]
    .iter()
    .filter(|t| **t)
    .count();
    if targets != 1 {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "exactly one of memory_id, topic_key (with type), or session_id",
        ));
    }
    if parsed.topic_key.is_some() && parsed.mtype.is_none() {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "topic_key erasure requires type (fact | instruction)",
        ));
    }
    let (name, branch) = profile_db(&ns, &profile, &headers, &q)?;
    let spec = format!("{name}@{branch}");
    if let Some(host) = strata_host(&state, &name) {
        let d = match strata_backend::route_write(&state, &host, &spec).await? {
            strata_backend::SRoute::Remote { addr } => {
                return forward(
                    &state,
                    &addr,
                    reqwest::Method::POST,
                    &format!("/v1/memory/{ns}/{profile}/erasures?branch={}", enc(&branch)),
                    Some(req),
                    None,
                )
                .await;
            }
            strata_backend::SRoute::Local(d) => d,
        };
        // The forget itself; no secure_delete equivalent is needed — the
        // history rewrite is a filtered compaction into new objects.
        let (memory_ids, txid) = if let Some(id) = &parsed.memory_id {
            let (out, txid) = strata_backend::submit(
                &d,
                memoturn_strata::WriteRequest::MemForget { id: id.clone() },
                true,
            )
            .await?;
            if strata_backend::expect_count(out)? == 0 {
                return Err(ApiError::new(StatusCode::NOT_FOUND, "memory not found"));
            }
            (vec![id.clone()], txid)
        } else if let (Some(key), Some(mtype)) = (&parsed.topic_key, &parsed.mtype) {
            let (out, txid) = strata_backend::submit(
                &d,
                memoturn_strata::WriteRequest::MemForgetTopic {
                    mtype: memoturn_strata::MemoryType::parse(mtype)?,
                    topic: key.clone(),
                },
                true,
            )
            .await?;
            let ids = strata_backend::expect_ids(out)?;
            if ids.is_empty() {
                return Err(ApiError::new(
                    StatusCode::NOT_FOUND,
                    "no memories on that topic",
                ));
            }
            (ids, txid)
        } else {
            let sid = parsed.session_id.clone().unwrap_or_default();
            let (_, txid) = strata_backend::submit(
                &d,
                memoturn_strata::WriteRequest::MemEndSession {
                    session: sid,
                    drop_turns: parsed.turns,
                },
                true,
            )
            .await?;
            (Vec::new(), txid)
        };
        // Coupon ordering: post-`T` state durable in object storage first.
        d.flush().await?;
        let rec = state.registry.get(&name).await?;
        let target = memoturn_governance::ErasureTarget {
            memory_id: parsed.memory_id,
            topic_key: parsed.topic_key,
            mtype: parsed.mtype,
            session_id: parsed.session_id,
            turns: parsed.turns,
        };
        let coupon = create_erasure_coupon_at(
            &state, &ns, &profile, &rec.uuid, &branch, target, memory_ids, txid, &actor,
        )
        .await?;
        return Ok((
            StatusCode::ACCEPTED,
            txid_headers(txid),
            Json(json!({
                "erasure_id": coupon.id,
                "status": coupon.status,
                "txid": txid,
                "grace_until": coupon.grace_until,
            })),
        )
            .into_response());
    }
    let l = match resolve_write(&state, &spec).await? {
        WriteRoute::Remote { addr } => {
            // The owner performs the forget and creates the coupon (it holds
            // the handle the durable ship needs).
            return forward(
                &state,
                &addr,
                reqwest::Method::POST,
                &format!("/v1/memory/{ns}/{profile}/erasures?branch={}", enc(&branch)),
                Some(req),
                None,
            )
            .await;
        }
        WriteRoute::Local(l) => l,
    };

    // The erasing transaction runs with secure_delete on, so the freed cells
    // are zeroed and the forced post-forget snapshot carries no byte residue.
    l.h.set_secure_delete(true).await?;
    let erased: Result<(Vec<String>, u64), ApiError> = async {
        if let Some(id) = &parsed.memory_id {
            let (deleted, txid) = memoturn_docstore::memories::forget(&l.h, id).await?;
            if deleted == 0 {
                return Err(ApiError::new(StatusCode::NOT_FOUND, "memory not found"));
            }
            Ok((vec![id.clone()], txid))
        } else if let (Some(key), Some(mtype)) = (&parsed.topic_key, &parsed.mtype) {
            let mtype = memoturn_docstore::memories::MemoryType::parse(mtype)?;
            let (ids, txid) = memoturn_docstore::memories::forget_topic(&l.h, mtype, key).await?;
            if ids.is_empty() {
                return Err(ApiError::new(
                    StatusCode::NOT_FOUND,
                    "no memories on that topic",
                ));
            }
            Ok((ids, txid))
        } else {
            let sid = parsed.session_id.as_deref().unwrap_or_default();
            let mut txid = memoturn_docstore::memories::end_session(&l.h, sid).await?;
            if parsed.turns {
                txid = memoturn_docstore::memory::drop_session(&l.h, sid).await?;
            }
            Ok((Vec::new(), txid))
        }
    }
    .await;
    let off = l.h.set_secure_delete(false).await;
    let (memory_ids, txid) = erased?;
    off?;

    let target = memoturn_governance::ErasureTarget {
        memory_id: parsed.memory_id,
        topic_key: parsed.topic_key,
        mtype: parsed.mtype,
        session_id: parsed.session_id,
        turns: parsed.turns,
    };
    let coupon =
        create_erasure_coupon(&state, &ns, &profile, &l, target, memory_ids, txid, &actor).await?;
    Ok((
        StatusCode::ACCEPTED,
        txid_headers(txid),
        Json(json!({
            "erasure_id": coupon.id,
            "status": coupon.status,
            "txid": txid,
            "grace_until": coupon.grace_until,
        })),
    )
        .into_response())
}

/// Durably ship the post-forget state, then write the coupon. Ordering
/// matters: the coupon must never promise an erasure whose post-`T` state is
/// not yet in object storage.
#[allow(clippy::too_many_arguments)]
async fn create_erasure_coupon(
    state: &AppState,
    ns: &str,
    profile: &str,
    l: &LocalWrite,
    target: memoturn_governance::ErasureTarget,
    memory_ids: Vec<String>,
    txid: u64,
    actor: &Option<audit::Actor>,
) -> Result<memoturn_governance::ErasureCoupon, ApiError> {
    state
        .shipper
        .flush_one(&l.uuid, &l.branch, &l.h, l.epoch)
        .await?;
    create_erasure_coupon_at(
        state, ns, profile, &l.uuid, &l.branch, target, memory_ids, txid, actor,
    )
    .await
}

/// The engine-agnostic half: build, persist, and audit the coupon. Callers
/// must already have made the post-`T` state durable in object storage.
#[allow(clippy::too_many_arguments)]
async fn create_erasure_coupon_at(
    state: &AppState,
    ns: &str,
    profile: &str,
    uuid: &str,
    branch: &str,
    target: memoturn_governance::ErasureTarget,
    memory_ids: Vec<String>,
    txid: u64,
    actor: &Option<audit::Actor>,
) -> Result<memoturn_governance::ErasureCoupon, ApiError> {
    let eff = state
        .governance
        .effective(ns, Some(profile))
        .await
        .unwrap_or_default();
    let now = now_ms();
    let coupon = memoturn_governance::ErasureCoupon {
        id: format!("ers_{}", &uuid::Uuid::new_v4().simple().to_string()[..16]),
        db: format!("{ns}--{profile}"),
        uuid: uuid.to_string(),
        target,
        memory_ids,
        requested_at: now,
        grace_until: now + (eff.erasure_grace_secs as i64) * 1000,
        forget_txid: std::collections::BTreeMap::from([(branch.to_string(), txid)]),
        status: memoturn_governance::ErasureStatus::Pending,
        blocked_by: None,
        completed_at: None,
        receipt: None,
        extra: serde_json::Map::new(),
    };
    state.erasures.create(&coupon).await?;
    if eff.audit_enabled {
        state.audit.emit(
            audit::AuditEvent::new("erasure.requested", ns)
                .profile(profile)
                .branch(branch)
                .resource(&coupon.id)
                .txid(txid)
                .count(coupon.memory_ids.len() as u64)
                .actor(actor.as_ref()),
        );
    }
    Ok(coupon)
}

async fn erasures_list(
    State(state): State<AppState>,
    Path((ns, profile)): Path<(String, String)>,
    headers: HeaderMap,
    Query(q): Query<HashMap<String, String>>,
) -> Result<Response, ApiError> {
    let (name, _) = profile_db(&ns, &profile, &headers, &q)?;
    let erasures = state.erasures.list(&name).await?;
    Ok(Json(json!({ "erasures": erasures })).into_response())
}

async fn erasure_get(
    State(state): State<AppState>,
    Path((ns, profile, id)): Path<(String, String, String)>,
    headers: HeaderMap,
    Query(q): Query<HashMap<String, String>>,
) -> Result<Response, ApiError> {
    let (name, _) = profile_db(&ns, &profile, &headers, &q)?;
    match state.erasures.get(&name, &id).await? {
        Some(coupon) => Ok(Json(serde_json::to_value(coupon).unwrap_or_default()).into_response()),
        None => Err(ApiError::new(StatusCode::NOT_FOUND, "erasure not found")),
    }
}

/// Drive pending erasures past their grace window: per branch, ensure a
/// post-`T` snapshot base (forcing one when this node can own the branch),
/// surface checkpoint/fork blockers honestly, and prune history below `T`.
/// Runs before `enforce_retention`/`gc_objects` so dereferenced objects fall
/// to this pass's GC; `finalize_erasures` then proves and receipts.
pub async fn process_erasures(state: &AppState) -> usize {
    let Ok(coupons) = state.erasures.unfinished().await else {
        return 0;
    };
    let now = now_ms();
    let mut acted = 0;
    for mut coupon in coupons {
        if coupon.grace_until > now {
            continue;
        }
        let Some((request_branch, &t)) = coupon.forget_txid.iter().next() else {
            continue;
        };
        // A fully deleted database is the strongest erasure — nothing to
        // prune; finalize verifies the (empty) prefix.
        if state.registry.get(&coupon.db).await.is_err() {
            continue;
        }
        let mut branches: Vec<String> = vec!["main".into()];
        if let Ok(bs) = state.registry.list_branches(&coupon.db).await {
            branches.extend(bs.into_iter().map(|b| b.branch));
        }
        branches.sort();
        branches.dedup();
        // Strata databases rewrite history below `T` with the engine's
        // filtered compaction (ADR-0011) — one pass erases the row, its FTS
        // postings, and its vector together; dereferenced objects fall to GC.
        if let Some(host) = strata_host(state, &coupon.db) {
            let mut blocked = memoturn_governance::BlockedBy::default();
            for b in &branches {
                let Ok(Some(m)) = host.store.manifest(&coupon.uuid, b).await else {
                    continue;
                };
                // Same live-content rule as libSQL: a branch that isn't the
                // erased one and didn't fork from it at or after `T` holds
                // the datum as LIVE content — rewriting can't help.
                if b != request_branch {
                    let post_t_child = m
                        .parent
                        .as_ref()
                        .is_some_and(|p| &p.branch == request_branch && p.fork_txid >= t);
                    if !post_t_child {
                        blocked.branches.push(b.clone());
                        continue;
                    }
                }
                let spec = format!("{}@{b}", coupon.db);
                // A remote owner's pass handles its branches; transient
                // route errors defer to the next tick.
                if let Ok(strata_backend::SRoute::Local(d)) =
                    strata_backend::route_write(state, &host, &spec).await
                {
                    match d.erase_below(t).await {
                        Ok(()) => acted += 1,
                        Err(memoturn_strata::StrataError::ErasureBlocked(names)) => {
                            blocked.checkpoints.extend(names)
                        }
                        Err(e) => {
                            tracing::warn!(db = %coupon.db, branch = %b, error = %e,
                                "strata erasure rewrite deferred")
                        }
                    }
                }
            }
            update_coupon_blockers(state, &mut coupon, blocked).await;
            continue;
        }
        let mut blocked = memoturn_governance::BlockedBy::default();
        for b in &branches {
            let Ok(Some(m)) = state.replicator.load_manifest(&coupon.uuid, b).await else {
                continue;
            };
            // A branch that isn't the erased one and didn't fork from it at
            // or after `T` may hold the datum as LIVE content, not history —
            // pruning can't help; the caller must erase or delete it there.
            if b != request_branch {
                let post_t_child = m
                    .parent
                    .as_ref()
                    .is_some_and(|p| &p.branch == request_branch && p.fork_txid >= t);
                if !post_t_child {
                    blocked.branches.push(b.clone());
                    continue;
                }
            }
            match state.replicator.prune_before(&coupon.uuid, b, t).await {
                Ok(memoturn_replication::PruneBeforeOutcome::Pruned(n)) => acted += n,
                Ok(memoturn_replication::PruneBeforeOutcome::AlreadyClean) => {}
                Ok(memoturn_replication::PruneBeforeOutcome::Blocked { checkpoints }) => {
                    blocked.checkpoints.extend(checkpoints)
                }
                Ok(memoturn_replication::PruneBeforeOutcome::NoBase) => {
                    // No post-T snapshot yet: force one if this node can own
                    // the branch; a remote owner's pass handles it otherwise.
                    let spec = format!("{}@{b}", coupon.db);
                    if let Ok(WriteRoute::Local(l)) = resolve_write(state, &spec).await {
                        if l.h.txid() >= t
                            && state
                                .replicator
                                .ship_snapshot(&l.h, &coupon.uuid, b, l.epoch)
                                .await
                                .is_ok()
                        {
                            if let Ok(memoturn_replication::PruneBeforeOutcome::Pruned(n)) =
                                state.replicator.prune_before(&coupon.uuid, b, t).await
                            {
                                acted += n;
                            }
                        }
                    }
                }
                Err(e) => {
                    tracing::warn!(db = %coupon.db, branch = %b, error = %e, "erasure prune deferred")
                }
            }
        }
        update_coupon_blockers(state, &mut coupon, blocked).await;
    }
    acted
}

/// Persist a coupon's blocker outcome from one maintenance pass (shared by
/// both engines' arms): Blocked when anything pins history below `T`,
/// otherwise back to Pending so `finalize_erasures` can prove and receipt.
async fn update_coupon_blockers(
    state: &AppState,
    coupon: &mut memoturn_governance::ErasureCoupon,
    mut blocked: memoturn_governance::BlockedBy,
) {
    blocked.checkpoints.sort();
    blocked.checkpoints.dedup();
    let status = if blocked.any() {
        memoturn_governance::ErasureStatus::Blocked
    } else {
        memoturn_governance::ErasureStatus::Pending
    };
    let blocked = blocked.any().then_some(blocked);
    if status != coupon.status
        || serde_json::to_value(&blocked).ok() != serde_json::to_value(&coupon.blocked_by).ok()
    {
        coupon.status = status;
        coupon.blocked_by = blocked;
        if let Err(e) = state.erasures.update(coupon).await {
            tracing::warn!(id = %coupon.id, error = %e, "erasure coupon update failed");
        }
    }
}

/// Prove and receipt erasures whose history rewrite has fully landed: every
/// manifest and every txid-named object sits at or above the forget txid.
/// Runs after `gc_objects` (the verifier counts raw keys, so dereferenced
/// objects must be physically gone first).
pub async fn finalize_erasures(state: &AppState) -> usize {
    let Ok(coupons) = state.erasures.unfinished().await else {
        return 0;
    };
    let now = now_ms();
    let mut done = 0;
    for mut coupon in coupons {
        if coupon.grace_until > now || coupon.status == memoturn_governance::ErasureStatus::Blocked
        {
            continue;
        }
        let Some(&t) = coupon.forget_txid.values().next() else {
            continue;
        };
        // Evidence comes from whichever engine owns the database's layout:
        // both proofs are listings of txid-named keys, just different roots.
        let ev_json = if let Some(host) = strata_host(state, &coupon.db) {
            match host.store.verify_erased_before(&coupon.uuid, t).await {
                Ok(ev) if ev.clean => serde_json::to_value(&ev).unwrap_or_else(|_| json!({})),
                Ok(_) => continue, // objects still pending GC — next pass
                Err(e) => {
                    tracing::warn!(id = %coupon.id, error = %e, "strata erasure verification deferred");
                    continue;
                }
            }
        } else {
            match state.replicator.verify_erased_before(&coupon.uuid, t).await {
                Ok(ev) if ev.clean => serde_json::to_value(&ev).unwrap_or_else(|_| json!({})),
                Ok(_) => continue, // objects still pending GC — next pass
                Err(e) => {
                    tracing::warn!(id = %coupon.id, error = %e, "erasure verification deferred");
                    continue;
                }
            }
        };
        let der = match &state.auth {
            auth::Auth::Enabled(keys) => Some(keys.signing_der().to_vec()),
            auth::Auth::Disabled => None,
        };
        let payload = memoturn_governance::receipt_payload(&coupon, now, ev_json);
        let receipt = match memoturn_governance::sign_receipt(der.as_deref(), payload) {
            Ok(r) => r,
            Err(e) => {
                tracing::warn!(id = %coupon.id, error = %e, "erasure receipt signing failed");
                continue;
            }
        };
        coupon.status = memoturn_governance::ErasureStatus::Completed;
        coupon.completed_at = Some(now);
        coupon.receipt = Some(receipt);
        if state.erasures.update(&coupon).await.is_ok() {
            done += 1;
            tracing::info!(id = %coupon.id, db = %coupon.db, "erasure verified and receipted");
            if let Some((ns, profile)) = coupon.db.split_once("--") {
                let (audit_on, _) = audit_gate(state, ns, profile).await;
                if audit_on {
                    state.audit.emit(
                        audit::AuditEvent::new("erasure.completed", ns)
                            .profile(profile)
                            .resource(&coupon.id),
                    );
                }
            }
        }
    }
    done
}

/// Set or clear a profile override (admin scope). Tighten-only: a 409 names
/// every field that loosens the namespace policy. Works before the profile's
/// first ingest — governance may precede data.
async fn profile_policy_put(
    State(state): State<AppState>,
    Path((ns, profile)): Path<(String, String)>,
    actor: Option<axum::Extension<audit::Actor>>,
    Json(req): Json<PolicyPut>,
) -> Result<Response, ApiError> {
    let actor = actor.map(|e| e.0);
    if !ns_part_ok(&ns) || !ns_part_ok(&profile) {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "invalid namespace or profile name",
        ));
    }
    let over = if req.policy.is_null() {
        None
    } else {
        Some(parse_policy(req.policy)?)
    };
    let doc = state.governance.put_profile(&ns, &profile, over).await?;
    let mut eff = doc.effective(Some(&profile));
    if eff.audit_enabled {
        state.audit.emit(
            audit::AuditEvent::new("policy.update", &ns)
                .profile(&profile)
                .resource(format!("policy:{ns}/{profile}"))
                .count(doc.revision)
                .actor(actor.as_ref()),
        );
    }
    governance::fold_env_ceilings(&mut eff);
    Ok(Json(json!({
        "namespace": ns,
        "profile": profile,
        "override": doc.profiles.get(&profile),
        "effective": eff,
        "revision": doc.revision,
    }))
    .into_response())
}

// ---- KV ----

#[derive(Deserialize)]
struct KvPutParams {
    ttl: Option<u64>,
}

async fn kv_put(
    State(state): State<AppState>,
    Path((db, ns, key)): Path<(String, String, String)>,
    Query(params): Query<KvPutParams>,
    body: Bytes,
) -> Result<Response, ApiError> {
    if let Some(host) = strata_host(&state, parse_spec(&db).0) {
        let d = match strata_backend::route_write(&state, &host, &db).await? {
            strata_backend::SRoute::Remote { addr } => {
                let qs = params.ttl.map(|t| format!("?ttl={t}")).unwrap_or_default();
                return forward(
                    &state,
                    &addr,
                    reqwest::Method::PUT,
                    &format!("/v1/db/{db}/kv/{ns}/{key}{qs}"),
                    None,
                    Some(body.to_vec()),
                )
                .await;
            }
            strata_backend::SRoute::Local(d) => d,
        };
        let (_, txid) = strata_backend::submit(
            &d,
            memoturn_strata::WriteRequest::KvPut {
                ns: ns.clone(),
                key: key.clone(),
                value: body.to_vec(),
                ttl_secs: params.ttl,
            },
            false,
        )
        .await?;
        return Ok((txid_headers(txid), Json(json!({ "txid": txid }))).into_response());
    }
    let l = match resolve_write(&state, &db).await? {
        WriteRoute::Remote { addr } => {
            let qs = params.ttl.map(|t| format!("?ttl={t}")).unwrap_or_default();
            return forward(
                &state,
                &addr,
                reqwest::Method::PUT,
                &format!("/v1/db/{db}/kv/{ns}/{key}{qs}"),
                None,
                Some(body.to_vec()),
            )
            .await;
        }
        WriteRoute::Local(l) => l,
    };
    let txid = memoturn_kv::put(&l.h, &ns, &key, body.to_vec(), params.ttl).await?;
    settle(&state, &l, false).await?;
    Ok((txid_headers(txid), Json(json!({ "txid": txid }))).into_response())
}

async fn kv_get(
    State(state): State<AppState>,
    Path((db, ns, key)): Path<(String, String, String)>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    if let Some(host) = strata_host(&state, parse_spec(&db).0) {
        let r = strata_backend::route_read(&state, &host, &db).await?;
        let value = r
            .with_view(|v| memoturn_strata::surface::kv::get(v, &ns, &key))
            .await?;
        return match value {
            Some(value) => Ok((txid_headers(r.head().await), value).into_response()),
            None => Err(ApiError::new(StatusCode::NOT_FOUND, "key not found")),
        };
    }
    let (h, _, _) = resolve_read(&state, &db, min_txid_of(&headers)).await?;
    match memoturn_kv::get(&h, &ns, &key).await? {
        Some(entry) => Ok((txid_headers(entry.txid), entry.value).into_response()),
        None => Err(ApiError::new(StatusCode::NOT_FOUND, "key not found")),
    }
}

async fn kv_delete(
    State(state): State<AppState>,
    Path((db, ns, key)): Path<(String, String, String)>,
) -> Result<Response, ApiError> {
    if let Some(host) = strata_host(&state, parse_spec(&db).0) {
        let d = match strata_backend::route_write(&state, &host, &db).await? {
            strata_backend::SRoute::Remote { addr } => {
                return forward(
                    &state,
                    &addr,
                    reqwest::Method::DELETE,
                    &format!("/v1/db/{db}/kv/{ns}/{key}"),
                    None,
                    None,
                )
                .await;
            }
            strata_backend::SRoute::Local(d) => d,
        };
        let (_, txid) = strata_backend::submit(
            &d,
            memoturn_strata::WriteRequest::KvDelete {
                ns: ns.clone(),
                key: key.clone(),
            },
            false,
        )
        .await?;
        return Ok((txid_headers(txid), StatusCode::NO_CONTENT).into_response());
    }
    let l = match resolve_write(&state, &db).await? {
        WriteRoute::Remote { addr } => {
            return forward(
                &state,
                &addr,
                reqwest::Method::DELETE,
                &format!("/v1/db/{db}/kv/{ns}/{key}"),
                None,
                None,
            )
            .await;
        }
        WriteRoute::Local(l) => l,
    };
    let txid = memoturn_kv::delete(&l.h, &ns, &key).await?;
    settle(&state, &l, false).await?;
    Ok((txid_headers(txid), StatusCode::NO_CONTENT).into_response())
}

async fn kv_list(
    State(state): State<AppState>,
    Path((db, ns)): Path<(String, String)>,
    headers: HeaderMap,
    Query(q): Query<HashMap<String, String>>,
) -> Result<Response, ApiError> {
    let prefix = q.get("prefix").map(String::as_str).unwrap_or("");
    let limit: u32 = capped(q.get("limit").and_then(|s| s.parse().ok()).unwrap_or(100));
    if let Some(host) = strata_host(&state, parse_spec(&db).0) {
        let r = strata_backend::route_read(&state, &host, &db).await?;
        let keys = r
            .with_view(|v| memoturn_strata::surface::kv::list(v, &ns, prefix, limit))
            .await?;
        return Ok((txid_headers(r.head().await), Json(json!({ "keys": keys }))).into_response());
    }
    let (h, _, _) = resolve_read(&state, &db, min_txid_of(&headers)).await?;
    let keys = memoturn_kv::list(&h, &ns, prefix, limit).await?;
    Ok((txid_headers(h.txid()), Json(json!({ "keys": keys }))).into_response())
}

#[cfg(test)]
mod tests {
    use super::enc;

    #[test]
    fn enc_escapes_url_metacharacters() {
        // Unreserved pass through; everything that could mis-route a forwarded
        // path/query is percent-encoded.
        assert_eq!(enc("mem_ab12-_.~"), "mem_ab12-_.~");
        assert_eq!(enc("s1?turns=true"), "s1%3Fturns%3Dtrue");
        assert_eq!(enc("a/b&c#d e"), "a%2Fb%26c%23d%20e");
        assert_eq!(enc("main&turns=true"), "main%26turns%3Dtrue");
    }
}
