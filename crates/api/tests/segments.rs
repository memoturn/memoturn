//! End-to-end for page-level segment replication: steady-state syncs ship
//! deltas (not snapshots), restore replays the chain correctly after total
//! local loss, compaction snapshots bound the chain, and checkpoint/rewind
//! and forks work mid-chain.

use axum::body::Body;
use axum::http::{Request, StatusCode};
use http_body_util::BodyExt;
use memoturn_api::{router, AppState};
use memoturn_engine::{LibsqlEngine, NodeConfig, NodeEngine, Registry};
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::Duration;
use tower::ServiceExt;

async fn state_with_store(
    dir: &std::path::Path,
    store: Arc<object_store::memory::InMemory>,
) -> AppState {
    let engine = Arc::new(LibsqlEngine);
    let node = Arc::new(NodeEngine::new(
        engine.clone(),
        NodeConfig {
            data_dir: dir.to_path_buf(),
            hot_cap: 100,
            hot_idle: Duration::from_secs(60),
            ..Default::default()
        },
    ));
    let registry = Arc::new(
        Registry::open(engine.as_ref(), &dir.join("registry.db"))
            .await
            .unwrap(),
    );
    let replicator = Arc::new(memoturn_replication::Replicator::new(store, "v1"));
    let mesh = Arc::new(memoturn_api::mesh::Mesh::new(reqwest::Client::new()));
    let shipper = Arc::new(memoturn_replication::Shipper::new(
        replicator.clone(),
        node.clone(),
        Some(mesh.clone()),
    ));
    AppState {
        node,
        registry,
        replicator,
        shipper,
        control: std::sync::Arc::new(memoturn_control::MemLeases::standalone("http://local")),
        mesh,
        auth: memoturn_api::auth::Auth::Disabled,
        http: reqwest::Client::new(),
        extractor: None,
        answerer: None,
        embedder: None,
        governance: std::sync::Arc::new(memoturn_api::governance::PolicyStore::in_memory()),
        embed_provenance: None,
        audit: memoturn_api::audit::AuditSink::noop(),
        erasures: std::sync::Arc::new(memoturn_governance::ErasureLedger::new(
            std::sync::Arc::new(object_store::memory::InMemory::new()),
            "v1",
        )),
    }
}

async fn call(
    app: &axum::Router,
    method: &str,
    uri: &str,
    body: Option<Value>,
) -> (StatusCode, Value) {
    let mut req = Request::builder().method(method).uri(uri);
    if body.is_some() {
        req = req.header("content-type", "application/json");
    }
    let req = req
        .body(Body::from(
            body.map(|b| b.to_string().into_bytes()).unwrap_or_default(),
        ))
        .unwrap();
    let resp = app.clone().oneshot(req).await.unwrap();
    let status = resp.status();
    let bytes = resp.into_body().collect().await.unwrap().to_bytes();
    let json = serde_json::from_slice(&bytes)
        .unwrap_or(Value::String(String::from_utf8_lossy(&bytes).into_owned()));
    (status, json)
}

async fn insert(app: &axum::Router, spec: &str, n: i64) {
    let (status, body) = call(
        app,
        "POST",
        &format!("/v1/db/{spec}/sql"),
        Some(json!({"stmts": [
            {"q": "CREATE TABLE IF NOT EXISTS t (n INTEGER)"},
            {"q": "INSERT INTO t VALUES (?)", "params": [n]}
        ]})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
}

async fn rows(app: &axum::Router, spec: &str) -> Vec<i64> {
    let (status, body) = call(
        app,
        "POST",
        &format!("/v1/db/{spec}/sql"),
        Some(json!({"stmts": [{"q": "SELECT n FROM t ORDER BY n"}]})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    body["results"][0]["rows"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r[0].as_i64().unwrap())
        .collect()
}

async fn sync(app: &axum::Router, spec: &str) {
    let (status, body) = call(app, "POST", &format!("/v1/db/{spec}/sync"), None).await;
    assert_eq!(status, StatusCode::OK, "{body}");
}

#[tokio::test]
async fn steady_state_ships_segments_not_snapshots() {
    let store = Arc::new(object_store::memory::InMemory::new());
    let dir = tempfile::tempdir().unwrap();
    let state = state_with_store(dir.path(), store).await;
    let app = router(state.clone());

    call(&app, "POST", "/v1/databases", Some(json!({"name": "a"}))).await;
    insert(&app, "a", 1).await;
    sync(&app, "a").await; // first ship: base snapshot
    insert(&app, "a", 2).await;
    sync(&app, "a").await; // delta segment
    insert(&app, "a", 3).await;
    insert(&app, "a", 4).await;
    sync(&app, "a").await; // delta segment covering two txids

    let uuid = state.registry.get("a").await.unwrap().uuid;
    let m = state
        .replicator
        .load_manifest(&uuid, "main")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(m.snapshots.len(), 1, "exactly one base snapshot");
    assert_eq!(m.segments.len(), 2, "steady-state syncs ship segments");
    // Chain is contiguous from the snapshot to the head.
    assert_eq!(m.segments[0].min_txid, m.snapshots[0].txid);
    assert_eq!(m.segments[1].min_txid, m.segments[0].max_txid);
    assert_eq!(m.head_txid, m.segments[1].max_txid);
}

#[tokio::test]
async fn chain_restore_survives_total_local_loss() {
    let store = Arc::new(object_store::memory::InMemory::new());
    let dir1 = tempfile::tempdir().unwrap();
    let state1 = state_with_store(dir1.path(), store.clone()).await;
    let app1 = router(state1.clone());

    call(&app1, "POST", "/v1/databases", Some(json!({"name": "a"}))).await;
    // Base snapshot + several delta segments, including doc/kv state.
    insert(&app1, "a", 1).await;
    sync(&app1, "a").await;
    for n in 2..=6 {
        insert(&app1, "a", n).await;
        sync(&app1, "a").await;
    }
    call(
        &app1,
        "POST",
        "/v1/db/a/docs/memories/insert",
        Some(json!({"docs": [{"kind": "fact", "text": "chain"}]})),
    )
    .await;
    sync(&app1, "a").await;

    // New node, same object store: chain restore must reproduce everything.
    let dir2 = tempfile::tempdir().unwrap();
    let state2 = state_with_store(dir2.path(), store).await;
    let orig = state1.registry.get("a").await.unwrap();
    state2
        .registry
        .create_with_uuid("a", &orig.uuid)
        .await
        .unwrap();
    let app2 = router(state2.clone());

    assert_eq!(rows(&app2, "a").await, vec![1, 2, 3, 4, 5, 6]);
    let (_, body) = call(
        &app2,
        "POST",
        "/v1/db/a/docs/memories/find",
        Some(json!({"filter": {}})),
    )
    .await;
    assert_eq!(body["docs"][0]["text"], json!("chain"));

    // Integrity of the restored file.
    let (status, body) = call(
        &app2,
        "POST",
        "/v1/db/a/sql",
        Some(json!({"stmts": [{"q": "PRAGMA integrity_check"}]})),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["results"][0]["rows"][0][0], json!("ok"));
}

#[tokio::test]
async fn compaction_snapshot_bounds_the_chain() {
    let store = Arc::new(object_store::memory::InMemory::new());
    let dir = tempfile::tempdir().unwrap();
    let state = state_with_store(dir.path(), store.clone()).await;
    let app = router(state.clone());

    call(&app, "POST", "/v1/databases", Some(json!({"name": "a"}))).await;
    // 1 base + 20 synced writes → compaction must have kicked in (every 16).
    for n in 1..=21 {
        insert(&app, "a", n).await;
        sync(&app, "a").await;
    }
    let uuid = state.registry.get("a").await.unwrap().uuid;
    let m = state
        .replicator
        .load_manifest(&uuid, "main")
        .await
        .unwrap()
        .unwrap();
    assert!(
        m.snapshots.len() >= 2,
        "compaction snapshot shipped: {}",
        m.snapshots.len()
    );
    assert!(
        m.chain_len() < 16,
        "chain bounded after compaction: {}",
        m.chain_len()
    );

    // Restore from the compacted chain on a fresh node.
    let dir2 = tempfile::tempdir().unwrap();
    let state2 = state_with_store(dir2.path(), store).await;
    state2.registry.create_with_uuid("a", &uuid).await.unwrap();
    let app2 = router(state2);
    assert_eq!(rows(&app2, "a").await, (1..=21).collect::<Vec<i64>>());
}

#[tokio::test]
async fn checkpoint_rewind_and_fork_mid_chain() {
    let store = Arc::new(object_store::memory::InMemory::new());
    let dir = tempfile::tempdir().unwrap();
    let state = state_with_store(dir.path(), store).await;
    let app = router(state.clone());

    call(&app, "POST", "/v1/databases", Some(json!({"name": "a"}))).await;
    insert(&app, "a", 1).await;
    sync(&app, "a").await; // base snapshot
    insert(&app, "a", 2).await;
    sync(&app, "a").await; // segment

    // Checkpoint lands on a segment boundary (checkpoint ships first).
    insert(&app, "a", 3).await;
    let (status, body) = call(
        &app,
        "POST",
        "/v1/db/a/branches/main/checkpoint",
        Some(json!({"name": "cp"})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");

    // More segments past the checkpoint, then a fork at head.
    insert(&app, "a", 4).await;
    insert(&app, "a", 5).await;
    let (status, _) = call(
        &app,
        "POST",
        "/v1/db/a/branches",
        Some(json!({"name": "exp"})),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    insert(&app, "a@exp", 100).await;

    // Rewind main to the mid-chain checkpoint.
    let (status, body) = call(
        &app,
        "POST",
        "/v1/db/a/branches/main/rewind",
        Some(json!({"to": "cp"})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(
        rows(&app, "a").await,
        vec![1, 2, 3],
        "rewound to checkpoint"
    );
    assert_eq!(
        rows(&app, "a@exp").await,
        vec![1, 2, 3, 4, 5, 100],
        "fork keeps the full pre-rewind chain plus its own writes"
    );

    // Writes continue on the rewound main and replicate correctly.
    insert(&app, "a", 6).await;
    sync(&app, "a").await;
    assert_eq!(rows(&app, "a").await, vec![1, 2, 3, 6]);
}
