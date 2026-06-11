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
pub mod auth;
pub mod embed;
pub mod extract;
pub mod limit;
pub mod mesh;

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
        .route("/healthz", get(|| async { "ok" }))
        .route(
            "/v1/databases",
            post(create_db).get(list_dbs).layer(rl(control_rl.clone())),
        )
        .route(
            "/v1/databases/{db}",
            axum::routing::delete(delete_db).layer(rl(control_rl.clone())),
        )
        .route("/v1/db/{db}/sql", post(sql).layer(large.clone()))
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
            get(kv_get)
                .put(kv_put)
                .delete(kv_delete)
                .layer(large.clone()),
        )
        .route(
            "/v1/db/{db}/docs/{coll}/insert",
            post(docs_insert).layer(large.clone()),
        )
        .route("/v1/db/{db}/docs/{coll}/find", post(docs_find))
        .route(
            "/v1/db/{db}/docs/{coll}/update",
            post(docs_update).layer(large.clone()),
        )
        .route("/v1/db/{db}/docs/{coll}/delete", post(docs_delete))
        .route("/v1/db/{db}/docs/{coll}/indexes", post(docs_create_index))
        .route(
            "/v1/db/{db}/vectors/{coll}",
            post(vectors_upsert).layer(large.clone()),
        )
        .route("/v1/db/{db}/vectors/{coll}/search", post(vectors_search))
        .route(
            "/v1/db/{db}/memory/{session}/turns",
            post(memory_append).get(memory_window).layer(large.clone()),
        )
        .route("/v1/db/{db}/memory/{session}/search", post(memory_search))
        // Agent memory: namespace > profile > memory (docs/architecture/07).
        .route("/v1/memory/{ns}", get(profiles_list))
        .route(
            "/v1/memory/{ns}/{profile}/memories",
            post(memories_ingest).layer(large.clone()),
        )
        .route(
            "/v1/memory/{ns}/{profile}/memories/{id}",
            get(memories_get).delete(memories_forget),
        )
        .route("/v1/memory/{ns}/{profile}/recall", post(memories_recall))
        .route("/v1/memory/{ns}/{profile}/ask", post(memories_ask))
        .route(
            "/v1/memory/{ns}/{profile}/extract",
            post(memories_extract).layer(large.clone()),
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
            post(replica_subscribe).layer(large.clone()),
        )
        .route(
            "/internal/replica/ingest",
            post(replica_ingest).layer(large.clone()),
        )
        .route(
            "/v1/databases/{db}/tokens",
            post(create_token).layer(rl(control_rl.clone())),
        )
        .route(
            "/v1/namespaces/{ns}/tokens",
            post(create_ns_token).layer(rl(control_rl.clone())),
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

/// `name[@branch]` → (name, branch); `@main` implicit.
fn parse_spec(spec: &str) -> (&str, &str) {
    match spec.split_once('@') {
        Some((name, branch)) if !branch.is_empty() => (name, branch),
        _ => (spec, "main"),
    }
}

// ---- error mapping ----

struct ApiError(StatusCode, String);

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.0, Json(json!({ "error": self.1 }))).into_response()
    }
}

impl From<EngineError> for ApiError {
    fn from(e: EngineError) -> Self {
        let code = match &e {
            EngineError::NotFound(_) => StatusCode::NOT_FOUND,
            EngineError::AlreadyExists(_) => StatusCode::CONFLICT,
            EngineError::Reserved => StatusCode::FORBIDDEN,
            EngineError::Sql(_) => StatusCode::BAD_REQUEST,
            EngineError::Io(_) => StatusCode::INTERNAL_SERVER_ERROR,
        };
        ApiError(code, e.to_string())
    }
}

impl From<ReplicationError> for ApiError {
    fn from(e: ReplicationError) -> Self {
        let code = match &e {
            ReplicationError::BranchNotFound(_) => StatusCode::NOT_FOUND,
            ReplicationError::NoSnapshot(_) => StatusCode::CONFLICT,
            ReplicationError::ZombieFenced { .. } => StatusCode::CONFLICT,
            ReplicationError::CasConflict => StatusCode::CONFLICT,
            ReplicationError::Engine(_) => StatusCode::BAD_REQUEST,
            _ => StatusCode::INTERNAL_SERVER_ERROR,
        };
        ApiError(code, e.to_string())
    }
}

impl From<ControlError> for ApiError {
    fn from(e: ControlError) -> Self {
        ApiError(StatusCode::SERVICE_UNAVAILABLE, e.to_string())
    }
}

impl From<memoturn_docstore::DocError> for ApiError {
    fn from(e: memoturn_docstore::DocError) -> Self {
        use memoturn_docstore::DocError::*;
        match e {
            Engine(inner) => inner.into(),
            other => ApiError(StatusCode::BAD_REQUEST, other.to_string()),
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
            return Err(ApiError(
                StatusCode::NOT_FOUND,
                format!("branch has no state in object storage: {branch}"),
            ));
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
        return Err(ApiError(
            StatusCode::NOT_FOUND,
            format!("branch not found: {branch}"),
        ));
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
        return Err(ApiError(
            StatusCode::NOT_FOUND,
            format!("branch not found: {branch}"),
        ));
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
            .ok_or_else(|| ApiError(StatusCode::BAD_REQUEST, format!("missing {name}")))
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
            return Err(ApiError(
                StatusCode::CONFLICT,
                "node owns this branch".into(),
            ));
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
            return Err(ApiError(
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
        .map_err(|e| ApiError(StatusCode::BAD_GATEWAY, format!("forward to {addr}: {e}")))?;
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
        .map_err(|e| ApiError(StatusCode::BAD_GATEWAY, e.to_string()))?;
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
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "invalid database name".into(),
        ));
    }
    // Provisioning is metadata-only: one registry insert, no data-file I/O.
    let rec = state.registry.create(&req.name).await?;
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
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "auth is disabled on this node".into(),
        ));
    };
    state.registry.get(&db).await?;
    let ttl = req.expires_in.unwrap_or(3600) as i64;
    let token = keys
        .mint(&db, req.scope, ttl)
        .map_err(|e| ApiError(StatusCode::INTERNAL_SERVER_ERROR, e))?;
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
    // Revoke stateless tokens minted before now: a write token must not survive
    // deletion to resurrect or mutate a re-created database of the same name.
    state.control.tombstone(&db, now_ms()).await?;
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
        .map_err(|e| ApiError(StatusCode::BAD_REQUEST, e.to_string()))?;
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
            return Err(ApiError(
                StatusCode::FORBIDDEN,
                "write scope required for mutating SQL".into(),
            ));
        }
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
        .map_err(|e| ApiError(StatusCode::BAD_REQUEST, e.to_string()))?;
    let (name, _) = parse_spec(&db);
    let parent = parsed.from.as_deref().unwrap_or("main");
    let spec = format!("{name}@{parent}");
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
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "cannot delete main".into(),
        ));
    }
    let rec = state.registry.get(name).await?;
    state.registry.delete_branch(name, &branch).await?;
    let key = format!("{}@{branch}", rec.uuid);
    state.control.release(&key).await?;
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
        .map_err(|e| ApiError(StatusCode::BAD_REQUEST, e.to_string()))?;
    let (name, _) = parse_spec(&db);
    let spec = format!("{name}@{branch}");
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
        .map_err(|e| ApiError(StatusCode::BAD_REQUEST, e.to_string()))?;
    let (name, _) = parse_spec(&db);
    let spec = format!("{name}@{branch}");
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
        if h.txid() > before {
            if let Some((uuid, branch)) = key.split_once('@') {
                state
                    .shipper
                    .mark_dirty(uuid, branch, h.clone(), owner.epoch)
                    .await;
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
    let mut n = 0;
    for db in dbs {
        match state.replicator.prune_retention(&db.uuid, fine, snap).await {
            Ok(p) => n += p,
            Err(e) => tracing::warn!(uuid = %db.uuid, error = %e, "PITR retention failed"),
        }
    }
    n
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
        .map_err(|e| ApiError(StatusCode::BAD_REQUEST, e.to_string()))?;
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
) -> Result<impl IntoResponse, ApiError> {
    let (h, _, _) = resolve_read(&state, &db, min_txid_of(&headers)).await?;
    let filter = if req.filter.is_null() {
        json!({})
    } else {
        req.filter
    };
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
    ))
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
        .map_err(|e| ApiError(StatusCode::BAD_REQUEST, e.to_string()))?;
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
        .map_err(|e| ApiError(StatusCode::BAD_REQUEST, e.to_string()))?;
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
        .map_err(|e| ApiError(StatusCode::BAD_REQUEST, e.to_string()))?;
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
        .map_err(|e| ApiError(StatusCode::BAD_REQUEST, e.to_string()))?;
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
        .map_err(|e| ApiError(StatusCode::BAD_REQUEST, e.to_string()))?;
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
) -> Result<impl IntoResponse, ApiError> {
    let (h, _, _) = resolve_read(&state, &db, min_txid_of(&headers)).await?;
    let last: u32 = q.get("last").and_then(|s| s.parse().ok()).unwrap_or(20);
    let turns = memoturn_docstore::memory::get_window(&h, &session, last).await?;
    Ok((txid_headers(h.txid()), Json(json!({ "turns": turns }))))
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
) -> Result<impl IntoResponse, ApiError> {
    let (h, _, _) = resolve_read(&state, &db, min_txid_of(&headers)).await?;
    let turns = memoturn_docstore::memory::search_semantic(
        &h,
        &session,
        &req.vector,
        capped(req.k.unwrap_or(5)),
    )
    .await?;
    Ok((txid_headers(h.txid()), Json(json!({ "turns": turns }))))
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
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "invalid namespace or profile name".into(),
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
/// log and degrade rather than fail the write.
async fn auto_embed_items(
    state: &AppState,
    items: &mut [memoturn_docstore::memories::MemoryInput],
) {
    let Some(embedder) = &state.embedder else {
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
    match embedder.embed(&texts, embed::EmbedKind::Document).await {
        Ok(vectors) => {
            for (&i, v) in pending.iter().zip(vectors) {
                items[i].embedding = Some(v);
            }
        }
        Err(e) => tracing::warn!(error = %e, "auto-embedding failed; ingesting without vectors"),
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
    Json(req): Json<serde_json::Value>,
) -> Result<Response, ApiError> {
    let parsed: IngestReq = serde_json::from_value(req.clone())
        .map_err(|e| ApiError(StatusCode::BAD_REQUEST, e.to_string()))?;
    if parsed.memories.len() > MAX_INGEST_BATCH {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            format!("ingest batch exceeds {MAX_INGEST_BATCH} memories; split the request"),
        ));
    }
    let (name, branch) = profile_db(&ns, &profile, &headers, &q)?;
    // Profiles auto-create on first ingest: metadata-only, instant. The uuid is
    // agreed through the shared catalog first, so two nodes racing a first
    // ingest to the same profile converge on one uuid instead of splitting its
    // storage (ADR-0009 split-brain). A stale write token can no longer
    // resurrect a deleted profile here: the auth middleware rejects tokens whose
    // `iat` predates the deletion tombstone before this handler runs.
    let proposed = uuid::Uuid::new_v4().simple().to_string();
    let canonical = state.control.resolve_uuid(&name, &proposed).await?;
    state.registry.ensure_with_uuid(&name, &canonical).await?;
    let spec = format!("{name}@{branch}");
    let l = route_write!(
        &state,
        &spec,
        &format!("/v1/memory/{ns}/{profile}/memories?branch={}", enc(&branch)),
        req
    );
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
                ttl_secs: m.ttl,
            })
        })
        .collect::<Result<Vec<_>, memoturn_docstore::DocError>>()?;
    let mut items = items;
    auto_embed_items(&state, &mut items).await;
    let before = l.h.txid();
    let (outcomes, txid) = memoturn_docstore::memories::ingest(&l.h, items).await?;
    if txid > before {
        settle(&state, &l, request_durable(&headers)).await?;
    }
    let results: Vec<_> = outcomes
        .into_iter()
        .map(|o| json!({ "id": o.id, "status": o.status, "superseded": o.superseded }))
        .collect();
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
    Json(req): Json<serde_json::Value>,
) -> Result<Response, ApiError> {
    let parsed: ExtractReq = serde_json::from_value(req)
        .map_err(|e| ApiError(StatusCode::BAD_REQUEST, e.to_string()))?;
    let (name, branch) = profile_db(&ns, &profile, &headers, &q)?;
    let Some(extractor) = state.extractor.clone() else {
        return Err(ApiError(
            StatusCode::SERVICE_UNAVAILABLE,
            "extraction is not configured on this node (set MEMOTURN_EXTRACT_API_KEY)".into(),
        ));
    };
    if parsed.turns.is_empty() {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "turns must not be empty".into(),
        ));
    }

    let extracted = extractor
        .extract(&parsed.turns)
        .await
        .map_err(|e| ApiError(StatusCode::BAD_GATEWAY, e))?;
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
    state.registry.ensure(&name).await?;
    let spec = format!("{name}@{branch}");
    let ingest_body = json!({ "memories": proposals });
    let l = route_write!(
        &state,
        &spec,
        &format!("/v1/memory/{ns}/{profile}/memories?branch={}", enc(&branch)),
        ingest_body
    );
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
                ttl_secs: None,
            })
        })
        .collect::<Result<Vec<_>, memoturn_docstore::DocError>>()?;
    let mut items = items;
    auto_embed_items(&state, &mut items).await;
    let before = l.h.txid();
    let (outcomes, txid) = memoturn_docstore::memories::ingest(&l.h, items).await?;
    if txid > before {
        settle(&state, &l, request_durable(&headers)).await?;
    }
    let results: Vec<_> = outcomes
        .into_iter()
        .map(|o| json!({ "id": o.id, "status": o.status, "superseded": o.superseded }))
        .collect();
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
    Json(req): Json<RecallReq>,
) -> Result<Response, ApiError> {
    let (name, branch) = profile_db(&ns, &profile, &headers, &q)?;
    // Unknown profile: empty recall, not 404 — reads never create. But a caller
    // demanding read-your-writes (Min-Txid) needs an error, not a silent txid 0
    // below its watermark, so it can distinguish "no memories" from "wrong
    // profile / not yet replicated here".
    if state.registry.get(&name).await.is_err() {
        if min_txid_of(&headers).is_some_and(|m| m > 0) {
            return Err(ApiError(StatusCode::NOT_FOUND, "profile not found".into()));
        }
        return Ok((txid_headers(0), Json(json!({ "memories": [], "txid": 0 }))).into_response());
    }
    let spec = format!("{name}@{branch}");
    let (h, _, _) = resolve_read(&state, &spec, min_txid_of(&headers)).await?;
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
    // for text-only clients. Best-effort: on provider failure recall degrades
    // to keyword+topic rather than erroring.
    let mut embedding = req.embedding;
    if embedding.is_none() {
        if let (Some(query), Some(embedder)) = (&req.query, &state.embedder) {
            match embedder
                .embed(&[query.clone()], embed::EmbedKind::Query)
                .await
            {
                Ok(mut vs) => embedding = vs.pop(),
                Err(e) => {
                    tracing::warn!(error = %e, "query auto-embedding failed; vector channel skipped")
                }
            }
        }
    }
    let memories = memoturn_docstore::memories::recall(
        &h,
        &memoturn_docstore::memories::RecallQuery {
            query: req.query,
            embedding: embedding.clone(),
            topic_key: req.topic_key,
            types,
            session_id: req.session_id.clone(),
            k,
            include_superseded: req.include_superseded,
        },
    )
    .await?;
    // Raw-turn channel: verbatim transcript moments alongside (not fused
    // with) typed memories — turns aren't memories, so they rank separately.
    let mut body = json!({ "memories": memories, "txid": h.txid() });
    if req.include_turns {
        let Some(emb) = &embedding else {
            return Err(ApiError(
                StatusCode::BAD_REQUEST,
                "include_turns requires an embedding (or a query + a configured embedder)".into(),
            ));
        };
        let turns =
            memoturn_docstore::memory::search_turns(&h, req.session_id.as_deref(), emb, k).await?;
        body["turns"] = json!(turns);
    }
    Ok((txid_headers(h.txid()), Json(body)).into_response())
}

#[derive(Deserialize)]
struct AskReq {
    question: String,
    #[serde(default)]
    types: Option<Vec<String>>,
    #[serde(default)]
    session_id: Option<String>,
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
    Json(req): Json<AskReq>,
) -> Result<Response, ApiError> {
    let Some(answerer) = state.answerer.clone() else {
        return Err(ApiError(
            StatusCode::SERVICE_UNAVAILABLE,
            "answer synthesis is not configured on this node (set MEMOTURN_ASSISTANT_API_KEY)"
                .into(),
        ));
    };
    if req.question.trim().is_empty() {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "question must not be empty".into(),
        ));
    }
    let (name, branch) = profile_db(&ns, &profile, &headers, &q)?;
    // Unknown profile: no memories, no LLM call — same read posture as recall.
    if state.registry.get(&name).await.is_err() {
        return Ok((
            txid_headers(0),
            Json(json!({ "answer": null, "sources": [], "memories": [], "txid": 0 })),
        )
            .into_response());
    }
    let spec = format!("{name}@{branch}");
    let (h, _, _) = resolve_read(&state, &spec, min_txid_of(&headers)).await?;
    let types = req
        .types
        .map(|ts| {
            ts.iter()
                .map(|t| memoturn_docstore::memories::MemoryType::parse(t))
                .collect::<Result<Vec<_>, _>>()
        })
        .transpose()?;
    // Auto-embed the question so the vector channel contributes (best-effort,
    // same degradation as recall).
    let mut embedding = None;
    if let Some(embedder) = &state.embedder {
        match embedder
            .embed(&[req.question.clone()], embed::EmbedKind::Query)
            .await
        {
            Ok(mut vs) => embedding = vs.pop(),
            Err(e) => {
                tracing::warn!(error = %e, "question auto-embedding failed; vector channel skipped")
            }
        }
    }
    let memories = memoturn_docstore::memories::recall(
        &h,
        &memoturn_docstore::memories::RecallQuery {
            query: Some(req.question.clone()),
            embedding,
            topic_key: None,
            types,
            session_id: req.session_id,
            k: capped(req.k.unwrap_or(8)),
            include_superseded: req.include_superseded,
        },
    )
    .await?;
    if memories.is_empty() {
        return Ok((
            txid_headers(h.txid()),
            Json(json!({ "answer": null, "sources": [], "memories": [], "txid": h.txid() })),
        )
            .into_response());
    }
    let out = answerer
        .answer(&req.question, &memories)
        .await
        .map_err(|e| ApiError(StatusCode::BAD_GATEWAY, e))?;
    Ok((
        txid_headers(h.txid()),
        Json(json!({
            "answer": out.answer,
            "sources": out.sources,
            "memories": memories,
            "txid": h.txid(),
        })),
    )
        .into_response())
}

async fn memories_get(
    State(state): State<AppState>,
    Path((ns, profile, id)): Path<(String, String, String)>,
    headers: HeaderMap,
    Query(q): Query<HashMap<String, String>>,
) -> Result<Response, ApiError> {
    let (name, branch) = profile_db(&ns, &profile, &headers, &q)?;
    let spec = format!("{name}@{branch}");
    let (h, _, _) = resolve_read(&state, &spec, min_txid_of(&headers)).await?;
    match memoturn_docstore::memories::get(&h, &id).await? {
        Some(memory) => Ok((txid_headers(h.txid()), Json(memory)).into_response()),
        None => Err(ApiError(StatusCode::NOT_FOUND, "memory not found".into())),
    }
}

async fn memories_forget(
    State(state): State<AppState>,
    Path((ns, profile, id)): Path<(String, String, String)>,
    headers: HeaderMap,
    Query(q): Query<HashMap<String, String>>,
) -> Result<Response, ApiError> {
    let (name, branch) = profile_db(&ns, &profile, &headers, &q)?;
    let spec = format!("{name}@{branch}");
    let l = match resolve_write(&state, &spec).await? {
        WriteRoute::Remote { addr } => {
            return forward(
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
            .await;
        }
        WriteRoute::Local(l) => l,
    };
    let (deleted, txid) = memoturn_docstore::memories::forget(&l.h, &id).await?;
    if deleted == 0 {
        return Err(ApiError(StatusCode::NOT_FOUND, "memory not found".into()));
    }
    settle(&state, &l, false).await?;
    Ok((txid_headers(txid), StatusCode::NO_CONTENT).into_response())
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
            return Err(ApiError(StatusCode::NOT_FOUND, "profile not found".into()));
        }
        return Ok((txid_headers(0), Json(json!({ "sessions": [], "txid": 0 }))).into_response());
    }
    let spec = format!("{name}@{branch}");
    let (h, _, _) = resolve_read(&state, &spec, min_txid_of(&headers)).await?;
    let limit: u32 = capped(q.get("limit").and_then(|s| s.parse().ok()).unwrap_or(100));
    let sessions = memoturn_docstore::memories::list_sessions(&h, limit).await?;
    Ok((
        txid_headers(h.txid()),
        Json(json!({ "sessions": sessions, "txid": h.txid() })),
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
) -> Result<Response, ApiError> {
    let (name, branch) = profile_db(&ns, &profile, &headers, &q)?;
    let drop_turns = q.get("turns").map(String::as_str) == Some("true");
    let spec = format!("{name}@{branch}");
    let l = match resolve_write(&state, &spec).await? {
        WriteRoute::Remote { addr } => {
            let turns_qs = if drop_turns { "&turns=true" } else { "" };
            return forward(
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
            .await;
        }
        WriteRoute::Local(l) => l,
    };
    let mut txid = memoturn_docstore::memories::end_session(&l.h, &sid).await?;
    if drop_turns {
        txid = memoturn_docstore::memory::drop_session(&l.h, &sid).await?;
    }
    settle(&state, &l, false).await?;
    Ok((txid_headers(txid), StatusCode::NO_CONTENT).into_response())
}

/// Profiles under a namespace (registry prefix scan; namespace tokens only).
async fn profiles_list(
    State(state): State<AppState>,
    Path(ns): Path<String>,
) -> Result<Response, ApiError> {
    if !ns_part_ok(&ns) {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "invalid namespace".into(),
        ));
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
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "auth is disabled on this node".into(),
        ));
    };
    if !ns_part_ok(&ns) {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "invalid namespace".into(),
        ));
    }
    let ttl = req.expires_in.unwrap_or(3600) as i64;
    let token = keys
        .mint_ns(&ns, req.scope, ttl)
        .map_err(|e| ApiError(StatusCode::INTERNAL_SERVER_ERROR, e))?;
    Ok((
        StatusCode::CREATED,
        Json(json!({ "token": token, "expires_in": ttl })),
    ))
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
    let (h, _, _) = resolve_read(&state, &db, min_txid_of(&headers)).await?;
    match memoturn_kv::get(&h, &ns, &key).await? {
        Some(entry) => Ok((txid_headers(entry.txid), entry.value).into_response()),
        None => Err(ApiError(StatusCode::NOT_FOUND, "key not found".into())),
    }
}

async fn kv_delete(
    State(state): State<AppState>,
    Path((db, ns, key)): Path<(String, String, String)>,
) -> Result<Response, ApiError> {
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
) -> Result<impl IntoResponse, ApiError> {
    let (h, _, _) = resolve_read(&state, &db, min_txid_of(&headers)).await?;
    let prefix = q.get("prefix").map(String::as_str).unwrap_or("");
    let limit: u32 = capped(q.get("limit").and_then(|s| s.parse().ok()).unwrap_or(100));
    let keys = memoturn_kv::list(&h, &ns, prefix, limit).await?;
    Ok((txid_headers(h.txid()), Json(json!({ "keys": keys }))))
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
