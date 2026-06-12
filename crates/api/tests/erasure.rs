//! End-to-end verifiable erasure (ADR-0010 phase 3): erase → bounded-time
//! history rewrite → provable absence → signed receipt. Plus the honest
//! blockers (checkpoints), `purge_on_forget`, and target validation.

use axum::body::Body;
use axum::http::{Request, StatusCode};
use http_body_util::BodyExt;
use memoturn_api::auth::{Auth, AuthKeys, Scope};
use memoturn_api::{router, AppState};
use memoturn_engine::{LibsqlEngine, NodeConfig, NodeEngine, Registry};
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::Duration;
use tower::ServiceExt;

async fn test_state(dir: &std::path::Path) -> AppState {
    // The erasure verifier counts raw keys, so tests need GC to actually
    // delete: zero grace (each tests/*.rs file is its own process).
    std::env::set_var("MEMOTURN_GC_GRACE_SECS", "0");
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
    let store: Arc<dyn object_store::ObjectStore> = Arc::new(object_store::memory::InMemory::new());
    let replicator = Arc::new(memoturn_replication::Replicator::new(store.clone(), "v1"));
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
        auth: Auth::Disabled,
        http: reqwest::Client::new(),
        extractor: None,
        answerer: None,
        embedder: None,
        governance: Arc::new(memoturn_api::governance::PolicyStore::in_memory()),
        embed_provenance: None,
        audit: memoturn_api::audit::AuditSink::noop(),
        erasures: Arc::new(memoturn_governance::ErasureLedger::new(store, "v1")),
    }
}

async fn call(
    app: &axum::Router,
    method: &str,
    uri: &str,
    token: Option<&str>,
    body: Option<Value>,
) -> (StatusCode, Value, Option<String>) {
    let mut req = Request::builder().method(method).uri(uri);
    if let Some(t) = token {
        req = req.header("authorization", format!("Bearer {t}"));
    }
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
    let erasure_id = resp
        .headers()
        .get("Memoturn-Erasure-Id")
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);
    let bytes = resp.into_body().collect().await.unwrap().to_bytes();
    let json = serde_json::from_slice(&bytes)
        .unwrap_or(Value::String(String::from_utf8_lossy(&bytes).into_owned()));
    (status, json, erasure_id)
}

const P: &str = "/v1/memory/acme/alice";
const DB: &str = "acme--alice";

async fn ingest_fact(app: &axum::Router, token: Option<&str>, summary: &str, v: &str) -> Value {
    let (status, body, _) = call(
        app,
        "POST",
        &format!("{P}/memories"),
        token,
        Some(json!({"memories": [
            {"type": "fact", "topic_key": "user.address", "summary": summary,
             "content": {"v": v}, "keywords": "address home"}
        ]})),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    body
}

/// Bring the erasure to its end state: rewind the grace window, then drive
/// the maintenance passes exactly as the node's tick%20 block orders them.
async fn drive_erasure(state: &AppState, db: &str, id: &str) {
    let mut coupon = state.erasures.get(db, id).await.unwrap().unwrap();
    coupon.grace_until = 0;
    state.erasures.update(&coupon).await.unwrap();
    memoturn_api::process_erasures(state).await;
    memoturn_api::enforce_retention(state).await;
    // Age the just-dereferenced objects past the (zero) GC grace — same-ms
    // writes otherwise count as "too fresh, may be mid-commit".
    tokio::time::sleep(Duration::from_millis(25)).await;
    memoturn_api::gc_objects(state).await;
    memoturn_api::finalize_erasures(state).await;
}

#[tokio::test]
async fn full_lifecycle_erases_history_and_receipts() {
    let dir = tempfile::tempdir().unwrap();
    let state = test_state(dir.path()).await;
    let app = router(state.clone());

    // Two generations on one topic, each shipped — pre-erasure history exists
    // in object storage as restorable snapshots/segments.
    ingest_fact(&app, None, "lives at 1 Old Road", "old").await;
    call(
        &app,
        "POST",
        &format!("/v1/db/{DB}/sync"),
        None,
        Some(json!({})),
    )
    .await;
    let body = ingest_fact(&app, None, "lives at 9 New Lane", "new").await;
    call(
        &app,
        "POST",
        &format!("/v1/db/{DB}/sync"),
        None,
        Some(json!({})),
    )
    .await;
    let pre_t_txid = body["txid"].as_u64().unwrap() - 1;

    // Erase the whole topic — active row and superseded chain.
    let (status, body, _) = call(
        &app,
        "POST",
        &format!("{P}/erasures"),
        None,
        Some(json!({"topic_key": "user.address", "type": "fact"})),
    )
    .await;
    assert_eq!(status, StatusCode::ACCEPTED, "{body}");
    assert_eq!(body["status"], "pending");
    let id = body["erasure_id"].as_str().unwrap().to_string();
    let t = body["txid"].as_u64().unwrap();

    // The rows are gone immediately (forget semantics)…
    let (_, body, _) = call(
        &app,
        "POST",
        &format!("{P}/recall"),
        None,
        Some(json!({"topic_key": "user.address", "include_superseded": true})),
    )
    .await;
    assert_eq!(body["memories"], json!([]), "{body}");

    // …and after grace + maintenance, the history below T is provably gone.
    drive_erasure(&state, DB, &id).await;
    let (status, coupon, _) = call(&app, "GET", &format!("{P}/erasures/{id}"), None, None).await;
    assert_eq!(status, StatusCode::OK, "{coupon}");
    assert_eq!(coupon["status"], "completed", "{coupon}");
    assert_eq!(coupon["memory_ids"].as_array().unwrap().len(), 2);
    let receipt = &coupon["receipt"];
    assert_eq!(receipt["alg"], "none", "auth disabled → explicit unsigned");
    assert!(receipt["payload"]["evidence"]["clean"].as_bool().unwrap());
    assert!(
        receipt["payload"]["evidence"]["oldest_snapshot_txid"]
            .as_u64()
            .unwrap()
            >= t
    );

    // Pre-erasure state is unreachable: rewinding below T has no snapshot.
    let (status, body, _) = call(
        &app,
        "POST",
        &format!("/v1/db/{DB}/branches/main/rewind"),
        None,
        Some(json!({"to": pre_t_txid})),
    )
    .await;
    assert_ne!(status, StatusCode::OK, "pre-T restore must fail: {body}");

    // The coupon list surfaces it.
    let (_, body, _) = call(&app, "GET", &format!("{P}/erasures"), None, None).await;
    assert_eq!(body["erasures"].as_array().unwrap().len(), 1);
}

#[tokio::test]
async fn checkpoints_below_t_block_and_are_named() {
    let dir = tempfile::tempdir().unwrap();
    let state = test_state(dir.path()).await;
    let app = router(state.clone());

    let body = ingest_fact(&app, None, "secret fact", "s").await;
    let id = body["results"][0]["id"].as_str().unwrap().to_string();
    call(
        &app,
        "POST",
        &format!("/v1/db/{DB}/sync"),
        None,
        Some(json!({})),
    )
    .await;
    let (status, _, _) = call(
        &app,
        "POST",
        &format!("/v1/db/{DB}/branches/main/checkpoint"),
        None,
        Some(json!({"name": "pre-launch"})),
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    let (status, body, _) = call(
        &app,
        "POST",
        &format!("{P}/erasures"),
        None,
        Some(json!({"memory_id": id})),
    )
    .await;
    assert_eq!(status, StatusCode::ACCEPTED, "{body}");
    let ers = body["erasure_id"].as_str().unwrap().to_string();

    drive_erasure(&state, DB, &ers).await;
    let (_, coupon, _) = call(&app, "GET", &format!("{P}/erasures/{ers}"), None, None).await;
    assert_eq!(coupon["status"], "blocked", "{coupon}");
    assert_eq!(coupon["blocked_by"]["checkpoints"], json!(["pre-launch"]));
}

#[tokio::test]
async fn purge_on_forget_upgrades_plain_deletes() {
    let dir = tempfile::tempdir().unwrap();
    let state = test_state(dir.path()).await;
    let app = router(state.clone());
    call(
        &app,
        "PUT",
        "/v1/namespaces/acme/policy",
        None,
        Some(json!({"policy": {"erasure": {"purge_on_forget": true, "grace_secs": 60}}})),
    )
    .await;

    let body = ingest_fact(&app, None, "to be purged", "p").await;
    let id = body["results"][0]["id"].as_str().unwrap().to_string();
    let (status, _, erasure_id) =
        call(&app, "DELETE", &format!("{P}/memories/{id}"), None, None).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let erasure_id = erasure_id.expect("purge_on_forget must return Memoturn-Erasure-Id");
    let coupon = state.erasures.get(DB, &erasure_id).await.unwrap().unwrap();
    assert_eq!(coupon.status, memoturn_governance::ErasureStatus::Pending);
    assert_eq!(coupon.memory_ids, vec![id]);
    assert!(coupon.grace_until > coupon.requested_at);
}

#[tokio::test]
async fn erase_validates_targets() {
    let dir = tempfile::tempdir().unwrap();
    let app = router(test_state(dir.path()).await);
    ingest_fact(&app, None, "x", "x").await;

    for bad in [
        json!({}),
        json!({"memory_id": "mem_x", "session_id": "s1"}),
        json!({"topic_key": "user.address"}), // missing type
    ] {
        let (status, body, _) = call(&app, "POST", &format!("{P}/erasures"), None, Some(bad)).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    }
    let (status, _, _) = call(
        &app,
        "POST",
        &format!("{P}/erasures"),
        None,
        Some(json!({"memory_id": "mem_does_not_exist"})),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn receipts_are_signed_and_verify_when_auth_is_on() {
    let dir = tempfile::tempdir().unwrap();
    let mut state = test_state(dir.path()).await;
    let (keys, der) =
        AuthKeys::generate("platform-secret".into(), "cluster-secret".into()).unwrap();
    let keys = Arc::new(keys);
    state.auth = Auth::Enabled(keys.clone());
    let app = router(state.clone());
    let write = keys.mint("acme--alice", Scope::Write, 3600).unwrap();

    let body = ingest_fact(&app, Some(&write), "signed away", "s").await;
    let id = body["results"][0]["id"].as_str().unwrap().to_string();
    call(
        &app,
        "POST",
        &format!("/v1/db/{DB}/sync"),
        Some(&write),
        Some(json!({})),
    )
    .await;
    let (status, body, _) = call(
        &app,
        "POST",
        &format!("{P}/erasures"),
        Some(&write),
        Some(json!({"memory_id": id})),
    )
    .await;
    assert_eq!(status, StatusCode::ACCEPTED, "{body}");
    let ers = body["erasure_id"].as_str().unwrap().to_string();

    drive_erasure(&state, DB, &ers).await;
    let coupon = state.erasures.get(DB, &ers).await.unwrap().unwrap();
    assert_eq!(coupon.status, memoturn_governance::ErasureStatus::Completed);
    let receipt = coupon.receipt.expect("completed coupons carry a receipt");
    assert_eq!(receipt.alg, "ed25519");

    // The receipt verifies offline against the cluster public key.
    let pair = ring::signature::Ed25519KeyPair::from_pkcs8(&der).unwrap();
    use ring::signature::KeyPair;
    assert!(memoturn_governance::verify_receipt(
        pair.public_key().as_ref(),
        &receipt
    ));
    // …and a tampered payload does not.
    let mut tampered = receipt.clone();
    tampered.payload["db"] = json!("acme--mallory");
    assert!(!memoturn_governance::verify_receipt(
        pair.public_key().as_ref(),
        &tampered
    ));
}
