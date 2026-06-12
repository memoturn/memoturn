//! Negative-path regression tests for the request-surface hardening and guards
//! (body limits, control-endpoint rate limiting, the SQL guard, and query caps).
//! These lock in the 4xx behaviours so a future refactor of the middleware stack
//! or the guards can't silently drop them.

use axum::body::Body;
use axum::http::{Request, StatusCode};
use http_body_util::BodyExt;
use memoturn_api::{router, AppState};
use memoturn_engine::{LibsqlEngine, NodeConfig, NodeEngine, Registry};
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::Duration;
use tower::ServiceExt;

async fn test_state(dir: &std::path::Path) -> AppState {
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
        control: Arc::new(memoturn_control::MemLeases::standalone("http://local")),
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
        strata: None,
    }
}

async fn call(
    app: &axum::Router,
    method: &str,
    uri: &str,
    body: Option<Value>,
) -> (StatusCode, Value) {
    call_raw(app, method, uri, body.map(|b| b.to_string().into_bytes())).await
}

async fn call_raw(
    app: &axum::Router,
    method: &str,
    uri: &str,
    body: Option<Vec<u8>>,
) -> (StatusCode, Value) {
    let mut req = Request::builder().method(method).uri(uri);
    if body.is_some() {
        req = req.header("content-type", "application/json");
    }
    let req = req.body(Body::from(body.unwrap_or_default())).unwrap();
    let resp = app.clone().oneshot(req).await.unwrap();
    let status = resp.status();
    let bytes = resp.into_body().collect().await.unwrap().to_bytes();
    let json = serde_json::from_slice(&bytes)
        .unwrap_or(Value::String(String::from_utf8_lossy(&bytes).into_owned()));
    (status, json)
}

async fn status(app: &axum::Router, method: &str, uri: &str, body: Option<Value>) -> StatusCode {
    call(app, method, uri, body).await.0
}

// ---- request-surface limits ----

#[tokio::test]
async fn oversized_body_is_rejected_with_413() {
    let dir = tempfile::tempdir().unwrap();
    let app = router(test_state(dir.path()).await);
    // 2 MiB body against the 1 MiB default cap on control endpoints. The size
    // check trips before JSON parsing, so the bytes need not be valid JSON.
    let big = vec![b'x'; 2 << 20];
    let (st, _) = call_raw(&app, "POST", "/v1/databases", Some(big)).await;
    assert_eq!(st, StatusCode::PAYLOAD_TOO_LARGE);
}

#[tokio::test]
async fn control_endpoints_are_rate_limited() {
    let dir = tempfile::tempdir().unwrap();
    let app = router(test_state(dir.path()).await);
    // Default control budget is 10 req/s with a burst of 20. A fresh router's
    // first request must pass; a rapid burst of 40 must trip 429 at least once.
    let mut codes = Vec::new();
    for _ in 0..40 {
        codes.push(status(&app, "GET", "/v1/databases", None).await);
    }
    assert_ne!(
        codes[0],
        StatusCode::TOO_MANY_REQUESTS,
        "first request not limited"
    );
    assert!(
        codes.contains(&StatusCode::TOO_MANY_REQUESTS),
        "a sustained burst must eventually hit 429; saw {codes:?}"
    );
}

// ---- SQL guard ----

#[tokio::test]
async fn reserved_table_sql_is_forbidden() {
    let dir = tempfile::tempdir().unwrap();
    let app = router(test_state(dir.path()).await);
    // The guard runs before write routing, so the database need not exist.
    let body = json!({ "stmts": [{ "q": "SELECT * FROM __memoturn_kv" }] });
    assert_eq!(
        status(&app, "POST", "/v1/db/anydb/sql", Some(body)).await,
        StatusCode::FORBIDDEN
    );
}

#[tokio::test]
async fn attach_escape_sql_is_forbidden() {
    let dir = tempfile::tempdir().unwrap();
    let app = router(test_state(dir.path()).await);
    let body = json!({ "stmts": [{ "q": "ATTACH DATABASE '/etc/passwd' AS x" }] });
    assert_eq!(
        status(&app, "POST", "/v1/db/anydb/sql", Some(body)).await,
        StatusCode::FORBIDDEN
    );
}

#[tokio::test]
async fn benign_pragma_is_allowed() {
    let dir = tempfile::tempdir().unwrap();
    let app = router(test_state(dir.path()).await);
    assert_eq!(
        status(
            &app,
            "POST",
            "/v1/databases",
            Some(json!({ "name": "pragdb" }))
        )
        .await,
        StatusCode::CREATED
    );
    // PRAGMA integrity_check is read-only introspection and must NOT be blocked.
    let (st, body) = call(
        &app,
        "POST",
        "/v1/db/pragdb/sql",
        Some(json!({ "stmts": [{ "q": "PRAGMA integrity_check" }] })),
    )
    .await;
    assert_eq!(st, StatusCode::OK);
    assert_eq!(body["results"][0]["rows"][0][0], json!("ok"));
}

// ---- query caps ----

#[tokio::test]
async fn oversized_filter_depth_is_rejected() {
    let dir = tempfile::tempdir().unwrap();
    let app = router(test_state(dir.path()).await);
    assert_eq!(
        status(
            &app,
            "POST",
            "/v1/databases",
            Some(json!({ "name": "fdb" }))
        )
        .await,
        StatusCode::CREATED
    );
    // Nest $not far past the depth cap (32); the compiler must reject rather
    // than recurse to a stack overflow.
    let mut filter = json!({ "a": 1 });
    for _ in 0..60 {
        filter = json!({ "$not": filter });
    }
    let st = status(
        &app,
        "POST",
        "/v1/db/fdb/docs/c/find",
        Some(json!({ "filter": filter })),
    )
    .await;
    assert_eq!(st, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn oversized_in_array_is_rejected() {
    let dir = tempfile::tempdir().unwrap();
    let app = router(test_state(dir.path()).await);
    assert_eq!(
        status(
            &app,
            "POST",
            "/v1/databases",
            Some(json!({ "name": "indb" }))
        )
        .await,
        StatusCode::CREATED
    );
    let big: Vec<i64> = (0..1001).collect();
    let filter = json!({ "x": { "$in": big } });
    let st = status(
        &app,
        "POST",
        "/v1/db/indb/docs/c/find",
        Some(json!({ "filter": filter })),
    )
    .await;
    assert_eq!(st, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn ingest_batch_over_cap_is_rejected() {
    let dir = tempfile::tempdir().unwrap();
    let app = router(test_state(dir.path()).await);
    let memories: Vec<Value> = (0..1001)
        .map(|i| json!({ "type": "event", "summary": i.to_string(), "content": {} }))
        .collect();
    let st = status(
        &app,
        "POST",
        "/v1/memory/acme/alice/memories",
        Some(json!({ "memories": memories })),
    )
    .await;
    assert_eq!(st, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn recall_k_is_clamped_not_unbounded() {
    let dir = tempfile::tempdir().unwrap();
    let app = router(test_state(dir.path()).await);
    // Seed one memory so the profile exists.
    assert_eq!(
        status(
            &app,
            "POST",
            "/v1/memory/acme/alice/memories",
            Some(json!({ "memories": [{ "type": "fact", "topic_key": "t", "summary": "s", "content": {} }] })),
        )
        .await,
        StatusCode::CREATED
    );
    // A pathological k must be clamped (handled, not OOM/erroring).
    let (st, body) = call(
        &app,
        "POST",
        "/v1/memory/acme/alice/recall",
        Some(json!({ "query": "s", "k": 10_000_000 })),
    )
    .await;
    assert_eq!(st, StatusCode::OK);
    assert!(
        body["memories"].as_array().map(|a| a.len()).unwrap_or(0) <= 1000,
        "result set stays within the cap"
    );
}

// ---- error envelope: { "error": <string>, "code": <stable code> } ----

/// The envelope shape is a public contract: both keys present, `error` a
/// human string, `code` a stable snake_case identifier clients branch on.
#[tokio::test]
async fn error_envelope_carries_message_and_code() {
    let dir = tempfile::tempdir().unwrap();
    let app = router(test_state(dir.path()).await);

    let (st, body) = call(
        &app,
        "POST",
        "/v1/db/nope/sql",
        Some(json!({ "stmts": [{ "q": "select 1" }] })),
    )
    .await;
    assert_eq!(st, StatusCode::NOT_FOUND);
    assert!(body["error"].is_string(), "error stays a bare string");
    assert_eq!(body["code"], "database_not_found");
}

#[tokio::test]
async fn branch_not_found_has_its_own_code() {
    let dir = tempfile::tempdir().unwrap();
    let app = router(test_state(dir.path()).await);
    let (st, _) = call(
        &app,
        "POST",
        "/v1/databases",
        Some(json!({ "name": "envdb" })),
    )
    .await;
    assert_eq!(st, StatusCode::CREATED);

    let (st, body) = call(
        &app,
        "POST",
        "/v1/db/envdb@ghost/sql",
        Some(json!({ "stmts": [{ "q": "select 1" }] })),
    )
    .await;
    assert_eq!(st, StatusCode::NOT_FOUND);
    assert_eq!(body["code"], "branch_not_found");
}

#[tokio::test]
async fn conflict_and_bad_request_codes() {
    let dir = tempfile::tempdir().unwrap();
    let app = router(test_state(dir.path()).await);
    let (st, _) = call(
        &app,
        "POST",
        "/v1/databases",
        Some(json!({ "name": "dup" })),
    )
    .await;
    assert_eq!(st, StatusCode::CREATED);

    let (st, body) = call(
        &app,
        "POST",
        "/v1/databases",
        Some(json!({ "name": "dup" })),
    )
    .await;
    assert_eq!(st, StatusCode::CONFLICT);
    assert_eq!(body["code"], "already_exists");

    let (st, body) = call(
        &app,
        "POST",
        "/v1/db/dup/sql",
        Some(json!({ "stmts": [{ "q": "definitely not sql" }] })),
    )
    .await;
    assert_eq!(st, StatusCode::BAD_REQUEST);
    assert_eq!(body["code"], "invalid_request");
}

#[tokio::test]
async fn unconfigured_ai_optins_are_distinguishable() {
    let dir = tempfile::tempdir().unwrap();
    let app = router(test_state(dir.path()).await);

    // No extractor on the test node: clients see `unconfigured`, the signal
    // to fall back to bring-your-own extraction.
    let (st, body) = call(
        &app,
        "POST",
        "/v1/memory/acme/alice/extract",
        Some(json!({ "turns": [{ "role": "user", "content": "hi" }] })),
    )
    .await;
    assert_eq!(st, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(body["code"], "unconfigured");

    let (st, body) = call(
        &app,
        "POST",
        "/v1/memory/acme/alice/ask",
        Some(json!({ "question": "hi" })),
    )
    .await;
    assert_eq!(st, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(body["code"], "unconfigured");
}

#[tokio::test]
async fn rate_limit_envelope_keeps_retry_after_and_code() {
    let dir = tempfile::tempdir().unwrap();
    let app = router(test_state(dir.path()).await);
    // Hammer a control endpoint past its budget; the shed response must keep
    // both the Retry-After header and the overloaded code.
    for i in 0..200 {
        let req = Request::builder()
            .method("POST")
            .uri("/v1/databases")
            .header("content-type", "application/json")
            .body(Body::from(json!({ "name": format!("rl{i}") }).to_string()))
            .unwrap();
        let resp = app.clone().oneshot(req).await.unwrap();
        if resp.status() == StatusCode::TOO_MANY_REQUESTS {
            assert_eq!(resp.headers().get("Retry-After").unwrap(), "1");
            let bytes = resp.into_body().collect().await.unwrap().to_bytes();
            let body: Value = serde_json::from_slice(&bytes).unwrap();
            assert_eq!(body["code"], "overloaded");
            return;
        }
    }
    panic!("control rate limit never tripped");
}
