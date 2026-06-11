//! End-to-end: snapshot shipping to object storage, cold wake after total
//! local-state loss (disposable-node property), CoW fork divergence,
//! checkpoint/rewind, burner-branch GC.

use axum::body::Body;
use axum::http::{Request, StatusCode};
use http_body_util::BodyExt;
use memoturn_api::{gc_burner_branches, router, AppState};
use memoturn_engine::{LibsqlEngine, NodeConfig, NodeEngine, Registry};
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tower::ServiceExt;

/// Object store outlives the "node" so tests can simulate node loss by
/// rebuilding all local state around the same store.
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

async fn count(app: &axum::Router, spec: &str) -> i64 {
    let (status, body) = call(
        app,
        "POST",
        &format!("/v1/db/{spec}/sql"),
        Some(json!({"stmts": [{"q": "SELECT count(*) FROM t"}]})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    body["results"][0]["rows"][0][0].as_i64().unwrap()
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

#[tokio::test]
async fn cold_wake_survives_total_local_loss() {
    let store = Arc::new(object_store::memory::InMemory::new());
    let dir1 = tempfile::tempdir().unwrap();
    let state1 = state_with_store(dir1.path(), store.clone()).await;
    let app1 = router(state1.clone());

    call(&app1, "POST", "/v1/databases", Some(json!({"name": "a"}))).await;
    insert(&app1, "a", 1).await;
    insert(&app1, "a", 2).await;
    let (status, _) = call(&app1, "POST", "/v1/db/a/sync", None).await;
    assert_eq!(status, StatusCode::OK);

    // "Kill the node": new data dir, same object store. Registry is
    // control-plane state, so carry the record over.
    let dir2 = tempfile::tempdir().unwrap();
    let state2 = state_with_store(dir2.path(), store).await;
    state2.registry.create("a").await.unwrap();
    // Same uuid must resolve: copy the record by recreating with the original uuid.
    // (The prototype registry generates uuids; emulate the control plane by
    // pointing the new record at the shipped uuid via direct lookup.)
    let orig = state1.registry.get("a").await.unwrap();
    let app2 = router(state2.clone());
    // Patch: delete the placeholder and re-insert with original uuid via raw access.
    state2.registry.delete("a").await.unwrap();
    state2
        .registry
        .create_with_uuid("a", &orig.uuid)
        .await
        .unwrap();

    let start = Instant::now();
    assert_eq!(
        count(&app2, "a").await,
        2,
        "all synced data restored from object storage"
    );
    let wake = start.elapsed();
    assert!(wake < Duration::from_millis(200), "cold wake took {wake:?}");
}

#[tokio::test]
async fn fork_diverges_and_parent_is_isolated() {
    let store = Arc::new(object_store::memory::InMemory::new());
    let dir = tempfile::tempdir().unwrap();
    let app = router(state_with_store(dir.path(), store).await);

    call(&app, "POST", "/v1/databases", Some(json!({"name": "a"}))).await;
    insert(&app, "a", 1).await;

    let (status, body) = call(
        &app,
        "POST",
        "/v1/db/a/branches",
        Some(json!({"name": "experiment"})),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    assert_eq!(body["spec"], json!("a@experiment"));

    // Diverge: write only to the branch.
    insert(&app, "a@experiment", 100).await;
    insert(&app, "a@experiment", 101).await;
    assert_eq!(
        count(&app, "a@experiment").await,
        3,
        "branch sees fork + its writes"
    );
    assert_eq!(count(&app, "a").await, 1, "parent never sees branch writes");

    // And the other direction.
    insert(&app, "a", 2).await;
    assert_eq!(count(&app, "a").await, 2);
    assert_eq!(count(&app, "a@experiment").await, 3);
}

#[tokio::test]
async fn checkpoint_and_rewind() {
    let store = Arc::new(object_store::memory::InMemory::new());
    let dir = tempfile::tempdir().unwrap();
    let app = router(state_with_store(dir.path(), store).await);

    call(&app, "POST", "/v1/databases", Some(json!({"name": "a"}))).await;
    insert(&app, "a", 1).await;
    insert(&app, "a", 2).await;

    let (status, body) = call(
        &app,
        "POST",
        "/v1/db/a/branches/main/checkpoint",
        Some(json!({"name": "before-task"})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let cp_txid = body["txid"].as_u64().unwrap();

    // The "risky task" writes more rows.
    insert(&app, "a", 3).await;
    insert(&app, "a", 4).await;
    assert_eq!(count(&app, "a").await, 4);

    let (status, body) = call(
        &app,
        "POST",
        "/v1/db/a/branches/main/rewind",
        Some(json!({"to": "before-task"})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["rewound_to"].as_u64().unwrap(), cp_txid);
    assert_eq!(count(&app, "a").await, 2, "state is exactly the checkpoint");

    // Writing after rewind continues normally.
    insert(&app, "a", 5).await;
    assert_eq!(count(&app, "a").await, 3);
}

#[tokio::test]
async fn burner_branch_is_garbage_collected() {
    let store = Arc::new(object_store::memory::InMemory::new());
    let dir = tempfile::tempdir().unwrap();
    let state = state_with_store(dir.path(), store).await;
    let app = router(state.clone());

    call(&app, "POST", "/v1/databases", Some(json!({"name": "a"}))).await;
    insert(&app, "a", 1).await;
    let (status, _) = call(
        &app,
        "POST",
        "/v1/db/a/branches",
        Some(json!({"name": "burner", "ttl": 0})),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    insert(&app, "a@burner", 99).await;

    let incinerated = gc_burner_branches(&state).await;
    assert_eq!(incinerated, 1);
    let (status, _) = call(
        &app,
        "POST",
        "/v1/db/a@burner/sql",
        Some(json!({"stmts": [{"q": "SELECT 1"}]})),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND, "burner is gone");
    assert_eq!(count(&app, "a").await, 1, "parent untouched");
}

#[tokio::test]
async fn branch_create_is_fast() {
    let store = Arc::new(object_store::memory::InMemory::new());
    let dir = tempfile::tempdir().unwrap();
    let app = router(state_with_store(dir.path(), store).await);

    call(&app, "POST", "/v1/databases", Some(json!({"name": "a"}))).await;
    insert(&app, "a", 1).await;
    call(&app, "POST", "/v1/db/a/sync", None).await; // parent shipped

    let start = Instant::now();
    let (status, _) = call(
        &app,
        "POST",
        "/v1/db/a/branches",
        Some(json!({"name": "fast"})),
    )
    .await;
    let elapsed = start.elapsed();
    assert_eq!(status, StatusCode::CREATED);
    assert!(
        elapsed < Duration::from_millis(50),
        "branch create took {elapsed:?}"
    );
}
