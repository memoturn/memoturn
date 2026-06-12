//! End-to-end: a memory profile running on the strata engine behind the
//! namespace flag (ADR-0011 graduation step), through the real HTTP API.
//! The selected namespace serves memory/KV/docs/transcripts/branching from
//! strata; an unselected namespace on the same node stays on libSQL —
//! per-database engine coexistence is the point.

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
    let store: Arc<dyn object_store::ObjectStore> = Arc::new(object_store::memory::InMemory::new());
    let replicator = Arc::new(memoturn_replication::Replicator::new(store.clone(), "v1"));
    let mesh = Arc::new(memoturn_api::mesh::Mesh::new(reqwest::Client::new()));
    let shipper = Arc::new(memoturn_replication::Shipper::new(
        replicator.clone(),
        node.clone(),
        Some(mesh.clone()),
    ));
    // The flag under test: namespace `acme` runs on strata — same object
    // store as the libSQL replicator, disjoint root.
    let strata = Some(memoturn_api::strata_backend::StrataHost::with_selection(
        "acme".to_string(),
        store.clone(),
        dir.join("strata"),
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
        governance: Arc::new(memoturn_api::governance::PolicyStore::in_memory()),
        embed_provenance: None,
        audit: memoturn_api::audit::AuditSink::noop(),
        erasures: Arc::new(memoturn_governance::ErasureLedger::new(
            Arc::new(object_store::memory::InMemory::new()),
            "v1",
        )),
        strata,
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

const P: &str = "/v1/memory/acme/assistant";
const DB: &str = "acme--assistant";

#[tokio::test]
async fn memory_loop_runs_on_strata_end_to_end() {
    let dir = tempfile::tempdir().unwrap();
    let app = router(test_state(dir.path()).await);

    // Ingest auto-creates the profile on the strata engine.
    let (status, body) = call(
        &app,
        "POST",
        &format!("{P}/memories"),
        Some(json!({"memories": [
            {"type": "fact", "topic_key": "user.theme", "summary": "prefers dark mode",
             "content": {"v": "dark"}, "keywords": "theme ui", "embedding": [1.0, 0.0]},
            {"type": "event", "summary": "logged in from new device", "content": {"d": 1}},
        ]})),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    assert_eq!(body["results"][0]["status"], json!("created"));
    let theme_id = body["results"][0]["id"].as_str().unwrap().to_string();
    let txid = body["txid"].as_u64().unwrap();
    assert!(txid > 0);

    // Duplicate detection (content-addressed ids work across engines).
    let (_, body) = call(
        &app,
        "POST",
        &format!("{P}/memories"),
        Some(json!({"memories": [
            {"type": "fact", "topic_key": "user.theme", "summary": "prefers dark mode",
             "content": {"v": "dark"}},
        ]})),
    )
    .await;
    assert_eq!(body["results"][0]["status"], json!("duplicate"), "{body}");

    // Supersession by topic.
    let (_, body) = call(
        &app,
        "POST",
        &format!("{P}/memories"),
        Some(json!({"memories": [
            {"type": "fact", "topic_key": "user.theme", "summary": "switched to light mode",
             "content": {"v": "light"}, "embedding": [0.0, 1.0]},
        ]})),
    )
    .await;
    assert_eq!(body["results"][0]["superseded"], json!([theme_id.clone()]));

    // Hybrid recall: topic + keyword + vector channels fuse; only the
    // active fact surfaces.
    let (status, body) = call(
        &app,
        "POST",
        &format!("{P}/recall"),
        Some(json!({"query": "what mode theme", "embedding": [0.0, 1.0],
                    "topic_key": "user.theme", "k": 4})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let memories = body["memories"].as_array().unwrap();
    assert_eq!(memories.len(), 1, "{body}");
    assert_eq!(memories[0]["content"], json!({"v": "light"}));
    let chans = memories[0]["channels"].as_array().unwrap();
    assert!(
        chans.contains(&json!("topic")) && chans.contains(&json!("vector")),
        "{chans:?}"
    );

    // Get exposes the supersession chain.
    let (status, body) = call(&app, "GET", &format!("{P}/memories/{theme_id}"), None).await;
    assert_eq!(status, StatusCode::OK);
    assert!(body["superseded_by"].is_string(), "{body}");

    // Forget hard-deletes.
    let (status, _) = call(&app, "DELETE", &format!("{P}/memories/{theme_id}"), None).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let (status, _) = call(&app, "GET", &format!("{P}/memories/{theme_id}"), None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn branching_checkpoints_and_rewind_on_strata() {
    let dir = tempfile::tempdir().unwrap();
    let app = router(test_state(dir.path()).await);

    call(
        &app,
        "POST",
        &format!("{P}/memories"),
        Some(json!({"memories": [
            {"type": "fact", "topic_key": "plan", "summary": "free plan", "content": {"p": "free"}},
        ]})),
    )
    .await;
    let (status, body) = call(
        &app,
        "POST",
        &format!("/v1/db/{DB}/branches/main/checkpoint"),
        Some(json!({"name": "before"})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");

    // Burner branch forks the whole profile.
    let (status, body) = call(
        &app,
        "POST",
        &format!("/v1/db/{DB}/branches"),
        Some(json!({"name": "what-if", "ttl": 3600})),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{body}");

    // Supersede on the branch; main is untouched (structural isolation).
    let (status, body) = call(
        &app,
        "POST",
        &format!("{P}/memories?branch=what-if"),
        Some(json!({"memories": [
            {"type": "fact", "topic_key": "plan", "summary": "pro plan", "content": {"p": "pro"}},
        ]})),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    let (_, body) = call(
        &app,
        "POST",
        &format!("{P}/recall?branch=what-if"),
        Some(json!({"topic_key": "plan", "k": 4})),
    )
    .await;
    assert_eq!(
        body["memories"][0]["content"],
        json!({"p": "pro"}),
        "{body}"
    );
    let (_, body) = call(
        &app,
        "POST",
        &format!("{P}/recall"),
        Some(json!({"topic_key": "plan", "k": 4})),
    )
    .await;
    assert_eq!(
        body["memories"][0]["content"],
        json!({"p": "free"}),
        "{body}"
    );

    // Rewind main to the checkpoint, then past it: state matches.
    call(
        &app,
        "POST",
        &format!("{P}/memories"),
        Some(json!({"memories": [
            {"type": "event", "summary": "noise after checkpoint", "content": {}},
        ]})),
    )
    .await;
    let (status, body) = call(
        &app,
        "POST",
        &format!("/v1/db/{DB}/branches/main/rewind"),
        Some(json!({"to": "before"})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let (_, body) = call(
        &app,
        "POST",
        &format!("{P}/recall"),
        Some(json!({"query": "noise checkpoint", "k": 4})),
    )
    .await;
    assert_eq!(body["memories"].as_array().unwrap().len(), 0, "{body}");
}

#[tokio::test]
async fn kv_docs_and_transcripts_run_on_strata() {
    let dir = tempfile::tempdir().unwrap();
    let app = router(test_state(dir.path()).await);
    // Profile must exist (ingest auto-creates the registry record).
    call(
        &app,
        "POST",
        &format!("{P}/memories"),
        Some(json!({"memories": [{"type": "event", "summary": "hello", "content": {}}]})),
    )
    .await;

    // KV with TTL semantics.
    let (status, _) = call(
        &app,
        "PUT",
        &format!("/v1/db/{DB}/kv/app/user:1"),
        Some(json!("scratch-value")),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    // KV stores raw bytes; the JSON body round-trips verbatim.
    let (status, body) = call(&app, "GET", &format!("/v1/db/{DB}/kv/app/user:1"), None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body, json!("scratch-value"));
    let (_, body) = call(
        &app,
        "GET",
        &format!("/v1/db/{DB}/kv/app?prefix=user:"),
        None,
    )
    .await;
    assert_eq!(body["keys"], json!(["user:1"]));

    // Docs: insert, index, planner-served find, update.
    let (status, body) = call(
        &app,
        "POST",
        &format!("/v1/db/{DB}/docs/orders/insert"),
        Some(json!({"docs": [
            {"_id": "o1", "status": "open", "total": 10},
            {"_id": "o2", "status": "closed", "total": 20},
        ]})),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    call(
        &app,
        "POST",
        &format!("/v1/db/{DB}/docs/orders/indexes"),
        Some(json!({"path": "status"})),
    )
    .await;
    let (_, body) = call(
        &app,
        "POST",
        &format!("/v1/db/{DB}/docs/orders/find"),
        Some(json!({"filter": {"status": "open"}})),
    )
    .await;
    assert_eq!(body["docs"].as_array().unwrap().len(), 1, "{body}");
    assert_eq!(body["docs"][0]["_id"], json!("o1"));
    let (_, body) = call(
        &app,
        "POST",
        &format!("/v1/db/{DB}/docs/orders/update"),
        Some(json!({"filter": {"_id": "o1"}, "update": {"$set": {"status": "closed"}}})),
    )
    .await;
    assert_eq!(body["modified"], json!(1), "{body}");

    // Transcripts: append, window, semantic search.
    for (role, text, emb) in [
        ("user", "my bill is wrong", Some(vec![1.0f32, 0.0])),
        ("assistant", "let me check", None),
    ] {
        let mut turn = json!({"role": role, "content": {"text": text}});
        if let Some(e) = emb {
            turn["embedding"] = json!(e);
        }
        let (status, body) = call(
            &app,
            "POST",
            &format!("/v1/db/{DB}/memory/s1/turns"),
            Some(turn),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED, "{body}");
    }
    let (_, body) = call(
        &app,
        "GET",
        &format!("/v1/db/{DB}/memory/s1/turns?last=1"),
        None,
    )
    .await;
    assert_eq!(body["turns"][0]["content"]["text"], json!("let me check"));
    let (_, body) = call(
        &app,
        "POST",
        &format!("/v1/db/{DB}/memory/s1/search"),
        Some(json!({"vector": [0.9, 0.1], "k": 2})),
    )
    .await;
    assert_eq!(body["turns"].as_array().unwrap().len(), 1, "{body}");

    // /sync is the strata durability point (flush to object storage).
    let (status, body) = call(&app, "POST", &format!("/v1/db/{DB}/sync"), Some(json!({}))).await;
    assert_eq!(status, StatusCode::OK, "{body}");
}

#[tokio::test]
async fn unsupported_surfaces_reject_cleanly_and_libsql_coexists() {
    let dir = tempfile::tempdir().unwrap();
    let app = router(test_state(dir.path()).await);
    call(
        &app,
        "POST",
        &format!("{P}/memories"),
        Some(json!({"memories": [{"type": "event", "summary": "x", "content": {}}]})),
    )
    .await;

    // No SQL surface on the strata engine.
    let (status, body) = call(
        &app,
        "POST",
        &format!("/v1/db/{DB}/sql"),
        Some(json!({"stmts": [{"q": "SELECT 1"}]})),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    assert!(
        body["error"].as_str().unwrap_or("").contains("strata"),
        "{body}"
    );

    // No standalone vector collections; memory embeddings ride ingest.
    let (status, _) = call(
        &app,
        "POST",
        &format!("/v1/db/{DB}/vectors/embeddings/search"),
        Some(json!({"vector": [1.0, 0.0]})),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    // Erasing a memory that doesn't exist is a 404, not a silent coupon.
    let (status, _) = call(
        &app,
        "POST",
        &format!("{P}/erasures"),
        Some(json!({"memory_id": "mem_00000000000000000000000000000000"})),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    // An unselected namespace on the same node runs the libSQL path —
    // including the SQL surface the strata profile just got refused.
    let other = "/v1/memory/oss/bot";
    let (status, body) = call(
        &app,
        "POST",
        &format!("{other}/memories"),
        Some(json!({"memories": [{"type": "fact", "topic_key": "k", "summary": "libsql fact", "content": {"v": 1}}]})),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    let (status, body) = call(
        &app,
        "POST",
        "/v1/db/oss--bot/sql",
        Some(json!({"stmts": [{"q": "SELECT 1 AS one"}]})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let (_, body) = call(
        &app,
        "POST",
        &format!("{other}/recall"),
        Some(json!({"query": "libsql fact", "k": 4})),
    )
    .await;
    assert_eq!(body["memories"].as_array().unwrap().len(), 1, "{body}");
}

#[tokio::test]
async fn erasure_lifecycle_completes_with_receipt_on_strata() {
    std::env::set_var("MEMOTURN_GC_GRACE_SECS", "0");
    let dir = tempfile::tempdir().unwrap();
    let state = test_state(dir.path()).await;
    let app = router(state.clone());

    // Two generations on one topic, each flushed — pre-erasure history
    // exists in segments, not just the WAL tail.
    for v in ["1 Main St", "2 Oak Ave"] {
        let (status, body) = call(
            &app,
            "POST",
            &format!("{P}/memories"),
            Some(json!({"memories": [
                {"type": "fact", "topic_key": "user.address", "summary": format!("lives at {v}"),
                 "content": {"v": v}, "keywords": "address home"},
            ]})),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED, "{body}");
        call(&app, "POST", &format!("/v1/db/{DB}/sync"), Some(json!({}))).await;
    }

    // Erase the whole topic chain: 202 + a pending coupon.
    let (status, body) = call(
        &app,
        "POST",
        &format!("{P}/erasures"),
        Some(json!({"topic_key": "user.address", "type": "fact"})),
    )
    .await;
    assert_eq!(status, StatusCode::ACCEPTED, "{body}");
    let erasure_id = body["erasure_id"].as_str().unwrap().to_string();
    let forget_txid = body["txid"].as_u64().unwrap();

    // Rewind the grace window, then drive the maintenance passes exactly as
    // the node's tick orders them (same shape as the libSQL erasure test).
    let mut coupon = state.erasures.get(DB, &erasure_id).await.unwrap().unwrap();
    coupon.grace_until = 0;
    state.erasures.update(&coupon).await.unwrap();
    memoturn_api::process_erasures(&state).await;
    tokio::time::sleep(Duration::from_millis(25)).await;
    memoturn_api::gc_objects(&state).await;
    memoturn_api::finalize_erasures(&state).await;

    let coupon = state.erasures.get(DB, &erasure_id).await.unwrap().unwrap();
    assert_eq!(
        serde_json::to_value(coupon.status).unwrap(),
        json!("completed"),
        "{coupon:?}"
    );
    let receipt = coupon.receipt.expect("signed receipt");
    let evidence = serde_json::to_value(&receipt).unwrap();
    assert!(
        evidence.to_string().contains("clean"),
        "receipt carries the listing evidence: {evidence}"
    );

    // Nothing on the topic survives — not even superseded history.
    let (_, body) = call(
        &app,
        "POST",
        &format!("{P}/recall"),
        Some(json!({"topic_key": "user.address", "include_superseded": true, "k": 16})),
    )
    .await;
    assert_eq!(body["memories"].as_array().unwrap().len(), 0, "{body}");
    // And the engine-level proof passes below the forget txid.
    let host = state.strata.as_ref().unwrap();
    let rec = state.registry.get(DB).await.unwrap();
    let ev = host
        .store
        .verify_erased_before(&rec.uuid, forget_txid)
        .await
        .unwrap();
    assert!(ev.clean, "{ev:?}");
}

#[tokio::test]
async fn maintenance_sweep_reclaims_expired_tasks_and_kv() {
    let dir = tempfile::tempdir().unwrap();
    let state = test_state(dir.path()).await;
    let app = router(state.clone());

    // A task that expires immediately and a KV key with zero TTL.
    let (status, body) = call(
        &app,
        "POST",
        &format!("{P}/memories"),
        Some(json!({"memories": [
            {"type": "task", "summary": "ephemeral follow-up", "content": {}, "ttl": 0},
            {"type": "fact", "topic_key": "k", "summary": "durable", "content": {"v": 1}},
        ]})),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    call(
        &app,
        "PUT",
        &format!("/v1/db/{DB}/kv/app/tmp?ttl=0"),
        Some(json!("x")),
    )
    .await;

    let swept = memoturn_api::sweep_expired(&state).await;
    assert!(swept >= 2, "task + kv swept, got {swept}");
    let (_, body) = call(
        &app,
        "POST",
        &format!("{P}/recall"),
        Some(json!({"query": "ephemeral follow-up durable", "include_superseded": true, "k": 16})),
    )
    .await;
    let summaries: Vec<_> = body["memories"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| m["summary"].as_str().unwrap().to_string())
        .collect();
    assert_eq!(summaries, vec!["durable".to_string()], "{body}");
}

#[tokio::test]
async fn background_flusher_converges_replicas_without_sync() {
    let dir = tempfile::tempdir().unwrap();
    let state = test_state(dir.path()).await;
    let app = router(state.clone());

    // A Standard-mode write: acked on the local log only, shipped by the
    // host's background flusher (no /sync, no durable header).
    let (status, body) = call(
        &app,
        "PUT",
        &format!("/v1/db/{DB_FLUSH}/kv/app/flushed"),
        Some(json!("standard-write")),
    )
    .await;
    // KV put auto-creates nothing: the profile must exist first.
    assert_eq!(status, StatusCode::NOT_FOUND, "{body}");
    call(
        &app,
        "POST",
        "/v1/memory/acme/flush-probe/memories",
        Some(json!({"memories": [{"type": "event", "summary": "seed", "content": {}}]})),
    )
    .await;
    let (status, _) = call(
        &app,
        "PUT",
        &format!("/v1/db/{DB_FLUSH}/kv/app/flushed"),
        Some(json!("standard-write")),
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    // A fresh replica reads from object storage alone; it must converge
    // within a few flusher intervals (200 ms each).
    let host = state.strata.as_ref().unwrap();
    let rec = state.registry.get(DB_FLUSH).await.unwrap();
    let mut converged = false;
    for _ in 0..20 {
        tokio::time::sleep(Duration::from_millis(100)).await;
        let Ok(replica) = host.store.replica(&rec.uuid, "main").await else {
            continue;
        };
        let v =
            replica.with_view(|v| memoturn_strata::surface::kv::get(v, "app", "flushed").unwrap());
        if v == Some(b"\"standard-write\"".to_vec()) {
            converged = true;
            break;
        }
    }
    assert!(converged, "background flusher shipped the standard write");
}

const DB_FLUSH: &str = "acme--flush-probe";
