//! End-to-end: instant provisioning, SQL batches with txid, KV with TTL,
//! hot-pool eviction (warm-tier reopen), reserved-table guard.

use axum::body::Body;
use axum::http::{Request, StatusCode};
use http_body_util::BodyExt;
use memoturn_api::{router, AppState};
use memoturn_engine::{LibsqlEngine, NodeConfig, NodeEngine, Registry};
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tower::ServiceExt;

async fn test_state(dir: &std::path::Path, hot_cap: u64) -> AppState {
    let engine = Arc::new(LibsqlEngine);
    let node = Arc::new(NodeEngine::new(
        engine.clone(),
        NodeConfig {
            data_dir: dir.to_path_buf(),
            hot_cap,
            hot_idle: Duration::from_secs(60),
            ..Default::default()
        },
    ));
    let registry = Arc::new(
        Registry::open(engine.as_ref(), &dir.join("registry.db"))
            .await
            .unwrap(),
    );
    let store = Arc::new(object_store::memory::InMemory::new());
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
) -> (StatusCode, Value, Option<u64>) {
    call_raw(app, method, uri, body.map(|b| b.to_string().into_bytes())).await
}

async fn call_raw(
    app: &axum::Router,
    method: &str,
    uri: &str,
    body: Option<Vec<u8>>,
) -> (StatusCode, Value, Option<u64>) {
    let mut req = Request::builder().method(method).uri(uri);
    if body.is_some() {
        req = req.header("content-type", "application/json");
    }
    let req = req.body(Body::from(body.unwrap_or_default())).unwrap();
    let resp = app.clone().oneshot(req).await.unwrap();
    let status = resp.status();
    let txid = resp
        .headers()
        .get("Memoturn-Txid")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.parse().ok());
    let bytes = resp.into_body().collect().await.unwrap().to_bytes();
    let json = serde_json::from_slice(&bytes)
        .unwrap_or(Value::String(String::from_utf8_lossy(&bytes).into_owned()));
    (status, json, txid)
}

#[tokio::test]
async fn provision_is_instant_and_metadata_only() {
    let dir = tempfile::tempdir().unwrap();
    let app = router(test_state(dir.path(), 100).await);

    // Warm up the registry handle, then measure.
    call(
        &app,
        "POST",
        "/v1/databases",
        Some(json!({"name": "warmup"})),
    )
    .await;
    let start = Instant::now();
    let (status, body, _) = call(
        &app,
        "POST",
        "/v1/databases",
        Some(json!({"name": "agent-1"})),
    )
    .await;
    let elapsed = start.elapsed();
    assert_eq!(status, StatusCode::CREATED, "{body}");
    assert!(
        elapsed < Duration::from_millis(100),
        "provision took {elapsed:?}"
    );
    // No data file exists until first use.
    let uuid = body["uuid"].as_str().unwrap();
    assert!(!dir.path().join("dbs").join(&uuid[..2]).join(uuid).exists());

    // Duplicate name → 409.
    let (status, _, _) = call(
        &app,
        "POST",
        "/v1/databases",
        Some(json!({"name": "agent-1"})),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);

    let (status, body, _) = call(&app, "GET", "/v1/databases", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["databases"].as_array().unwrap().len(), 2);
}

#[tokio::test]
async fn sql_batch_roundtrip_with_txid() {
    let dir = tempfile::tempdir().unwrap();
    let app = router(test_state(dir.path(), 100).await);
    call(&app, "POST", "/v1/databases", Some(json!({"name": "a"}))).await;

    let (status, body, txid) = call(
        &app,
        "POST",
        "/v1/db/a/sql",
        Some(json!({"stmts": [
            {"q": "CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)"},
            {"q": "INSERT INTO t (name) VALUES (?), (?)", "params": ["x", "y"]},
            {"q": "SELECT count(*) AS n FROM t"}
        ]})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["results"][2]["rows"][0][0], json!(2));
    assert_eq!(txid, Some(1), "first effective write is txid 1");

    // A second write bumps txid; a pure read does not.
    let (_, body, _) = call(
        &app,
        "POST",
        "/v1/db/a/sql",
        Some(json!({"stmts": [{"q": "INSERT INTO t (name) VALUES ('z')"}]})),
    )
    .await;
    assert_eq!(body["txid"], json!(2));
    let (_, body, _) = call(
        &app,
        "POST",
        "/v1/db/a/sql",
        Some(json!({"stmts": [{"q": "SELECT * FROM t"}]})),
    )
    .await;
    assert_eq!(body["txid"], json!(2), "reads must not bump txid");

    // Failed batches roll back atomically.
    let (status, _, _) = call(
        &app,
        "POST",
        "/v1/db/a/sql",
        Some(json!({"stmts": [
            {"q": "INSERT INTO t (name) VALUES ('w')"},
            {"q": "INSERT INTO nonexistent VALUES (1)"}
        ]})),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (_, body, _) = call(
        &app,
        "POST",
        "/v1/db/a/sql",
        Some(json!({"stmts": [{"q": "SELECT count(*) AS n FROM t"}]})),
    )
    .await;
    assert_eq!(
        body["results"][0]["rows"][0][0],
        json!(3),
        "rollback must undo 'w'"
    );
}

#[tokio::test]
async fn kv_put_get_delete_list_and_ttl() {
    let dir = tempfile::tempdir().unwrap();
    let app = router(test_state(dir.path(), 100).await);
    call(&app, "POST", "/v1/databases", Some(json!({"name": "a"}))).await;

    let (status, _, txid) = call_raw(
        &app,
        "PUT",
        "/v1/db/a/kv/scratch/plan",
        Some(b"step one".to_vec()),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert!(txid.unwrap() >= 1);

    let (status, body, txid) = call(&app, "GET", "/v1/db/a/kv/scratch/plan", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body, Value::String("step one".into()));
    assert!(txid.is_some(), "every KV read carries Memoturn-Txid");

    // List with prefix.
    call_raw(
        &app,
        "PUT",
        "/v1/db/a/kv/scratch/step:1",
        Some(b"a".to_vec()),
    )
    .await;
    call_raw(
        &app,
        "PUT",
        "/v1/db/a/kv/scratch/step:2",
        Some(b"b".to_vec()),
    )
    .await;
    let (_, body, _) = call(&app, "GET", "/v1/db/a/kv/scratch?prefix=step:", None).await;
    assert_eq!(body["keys"], json!(["step:1", "step:2"]));

    // TTL: ttl=0 expires immediately (lazy expiry on read).
    call_raw(
        &app,
        "PUT",
        "/v1/db/a/kv/scratch/ephemeral?ttl=0",
        Some(b"x".to_vec()),
    )
    .await;
    let (status, _, _) = call(&app, "GET", "/v1/db/a/kv/scratch/ephemeral", None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    // Delete.
    let (status, _, _) = call(&app, "DELETE", "/v1/db/a/kv/scratch/plan", None).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let (status, _, _) = call(&app, "GET", "/v1/db/a/kv/scratch/plan", None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn hot_pool_eviction_demotes_to_warm_and_reopens() {
    let dir = tempfile::tempdir().unwrap();
    // hot_cap=1: the second database must evict the first (hot → warm).
    let state = test_state(dir.path(), 1).await;
    let app = router(state.clone());
    call(&app, "POST", "/v1/databases", Some(json!({"name": "a"}))).await;
    call(&app, "POST", "/v1/databases", Some(json!({"name": "b"}))).await;

    for db in ["a", "b", "a", "b"] {
        let (status, body, _) = call(
            &app,
            "POST",
            &format!("/v1/db/{db}/sql"),
            Some(json!({"stmts": [
                {"q": "CREATE TABLE IF NOT EXISTS t (n INTEGER)"},
                {"q": "INSERT INTO t VALUES (1)"}
            ]})),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
    }
    // Both databases kept their data across demotion/reopen cycles.
    for db in ["a", "b"] {
        let (_, body, _) = call(
            &app,
            "POST",
            &format!("/v1/db/{db}/sql"),
            Some(json!({"stmts": [{"q": "SELECT count(*) FROM t"}]})),
        )
        .await;
        assert_eq!(body["results"][0]["rows"][0][0], json!(2), "db {db}");
    }
}

#[tokio::test]
async fn reserved_tables_are_guarded() {
    let dir = tempfile::tempdir().unwrap();
    let app = router(test_state(dir.path(), 100).await);
    call(&app, "POST", "/v1/databases", Some(json!({"name": "a"}))).await;
    let (status, _, _) = call(
        &app,
        "POST",
        "/v1/db/a/sql",
        Some(json!({"stmts": [{"q": "DELETE FROM __memoturn_kv"}]})),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn unknown_database_is_404() {
    let dir = tempfile::tempdir().unwrap();
    let app = router(test_state(dir.path(), 100).await);
    let (status, _, _) = call(
        &app,
        "POST",
        "/v1/db/nope/sql",
        Some(json!({"stmts": [{"q": "SELECT 1"}]})),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}
