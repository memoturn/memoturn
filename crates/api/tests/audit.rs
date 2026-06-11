//! End-to-end audit logging (ADR-0010 phase 2, docs/architecture/08):
//! per-namespace policy gating, semantic event emission, actor attribution,
//! egress-denial events, the read API with its auth carve-out, and the
//! metadata-only guarantee.

use axum::body::Body;
use axum::http::{Request, StatusCode};
use http_body_util::BodyExt;
use memoturn_api::audit::AuditSink;
use memoturn_api::auth::{Auth, AuthKeys, Scope};
use memoturn_api::{router, AppState};
use memoturn_engine::{LibsqlEngine, NodeConfig, NodeEngine, Registry};
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::Duration;
use tower::ServiceExt;

/// Test state with a REAL audit sink (long tick; tests drive `flush_now`).
async fn test_state(dir: &std::path::Path) -> AppState {
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
        audit: AuditSink::spawn(store, "v1", "node-test", 60_000),
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
    token: Option<&str>,
    body: Option<Value>,
) -> (StatusCode, Value) {
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
    let bytes = resp.into_body().collect().await.unwrap().to_bytes();
    let json = serde_json::from_slice(&bytes)
        .unwrap_or(Value::String(String::from_utf8_lossy(&bytes).into_owned()));
    (status, json)
}

const NS: &str = "/v1/namespaces/acme/policy";
const P: &str = "/v1/memory/acme/alice";

async fn read_events(state: &AppState, app: &axum::Router, query: &str) -> Vec<Value> {
    state.audit.flush_now().await;
    let (status, body) = call(
        app,
        "GET",
        &format!("/v1/namespaces/acme/audit{query}"),
        None,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    body["events"].as_array().unwrap().clone()
}

#[tokio::test]
async fn mutations_and_denials_are_recorded_metadata_only() {
    let dir = tempfile::tempdir().unwrap();
    let state = test_state(dir.path()).await;
    let app = router(state.clone());
    call(
        &app,
        "PUT",
        NS,
        None,
        Some(json!({"policy": {"audit": {"enabled": true}, "ai_egress": {"extract": "deny"}}})),
    )
    .await;

    // A write, a delete, and a policy-denied extract.
    let (status, body) = call(
        &app,
        "POST",
        &format!("{P}/memories"),
        None,
        Some(json!({"memories": [
            {"type": "fact", "topic_key": "user.theme", "summary": "secret preference",
             "content": {"secret": "payload"}}
        ]})),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    let id = body["results"][0]["id"].as_str().unwrap().to_string();
    let txid = body["txid"].as_u64().unwrap();
    let (status, _) = call(&app, "DELETE", &format!("{P}/memories/{id}"), None, None).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let (status, _) = call(
        &app,
        "POST",
        &format!("{P}/extract"),
        None,
        Some(json!({"turns": [{"role": "user", "content": {"text": "hi"}}]})),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);

    let events = read_events(&state, &app, "").await;
    let actions: Vec<&str> = events
        .iter()
        .map(|e| e["action"].as_str().unwrap())
        .collect();
    // policy.update is the stream's first record (the change that enabled it).
    assert_eq!(
        actions,
        vec![
            "policy.update",
            "memory.ingest",
            "memory.forget",
            "ai.extract"
        ],
        "{events:?}"
    );
    let ingest = &events[1];
    assert_eq!(ingest["profile"], "alice");
    assert_eq!(ingest["txid"].as_u64().unwrap(), txid);
    assert_eq!(ingest["count"], 1);
    assert_eq!(ingest["outcome"], "ok");
    let forget = &events[2];
    assert_eq!(forget["resource"].as_str().unwrap(), id);
    let denied = &events[3];
    assert_eq!(denied["outcome"], "denied");

    // Metadata only: the memory's summary/content never reach the stream.
    let raw = serde_json::to_string(&events).unwrap();
    assert!(!raw.contains("secret preference"), "{raw}");
    assert!(!raw.contains("payload"), "{raw}");
}

#[tokio::test]
async fn reads_gate_on_include_reads() {
    let dir = tempfile::tempdir().unwrap();
    let state = test_state(dir.path()).await;
    let app = router(state.clone());
    call(
        &app,
        "PUT",
        NS,
        None,
        Some(json!({"policy": {"audit": {"enabled": true}}})),
    )
    .await;
    call(
        &app,
        "POST",
        &format!("{P}/memories"),
        None,
        Some(json!({"memories": [
            {"type": "fact", "topic_key": "t", "summary": "fact", "content": {}, "keywords": "fact"}
        ]})),
    )
    .await;

    // Recall is not audited by default…
    call(
        &app,
        "POST",
        &format!("{P}/recall"),
        None,
        Some(json!({"query": "fact"})),
    )
    .await;
    let events = read_events(&state, &app, "?action=memory.recall").await;
    assert!(events.is_empty(), "{events:?}");

    // …until include_reads is on.
    call(
        &app,
        "PUT",
        NS,
        None,
        Some(json!({"policy": {"audit": {"enabled": true, "include_reads": true}}})),
    )
    .await;
    call(
        &app,
        "POST",
        &format!("{P}/recall"),
        None,
        Some(json!({"query": "fact"})),
    )
    .await;
    let events = read_events(&state, &app, "?action=memory.recall").await;
    assert_eq!(events.len(), 1, "{events:?}");
    assert_eq!(events[0]["count"], 1);
}

#[tokio::test]
async fn disabled_audit_emits_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let state = test_state(dir.path()).await;
    let app = router(state.clone());
    // No policy at all: writes flow, stream stays empty.
    call(
        &app,
        "POST",
        &format!("{P}/memories"),
        None,
        Some(json!({"memories": [{"type": "event", "summary": "e", "content": {}}]})),
    )
    .await;
    let events = read_events(&state, &app, "").await;
    assert!(events.is_empty(), "{events:?}");
}

#[tokio::test]
async fn audit_read_auth_platform_or_ns_admin() {
    let dir = tempfile::tempdir().unwrap();
    let mut state = test_state(dir.path()).await;
    let (keys, _) = AuthKeys::generate("platform-secret".into(), "cluster-secret".into()).unwrap();
    let keys = Arc::new(keys);
    state.auth = Auth::Enabled(keys.clone());
    let app = router(state.clone());
    call(
        &app,
        "PUT",
        NS,
        Some("platform-secret"),
        Some(json!({"policy": {"audit": {"enabled": true}}})),
    )
    .await;
    let write = keys.mint_ns("acme", Scope::Write, 3600).unwrap();
    let admin = keys.mint_ns("acme", Scope::Admin, 3600).unwrap();
    let other_admin = keys.mint_ns("globex", Scope::Admin, 3600).unwrap();
    let (status, body) = call(
        &app,
        "POST",
        &format!("{P}/memories"),
        Some(&write),
        Some(json!({"memories": [{"type": "event", "summary": "e", "content": {}}]})),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    state.audit.flush_now().await;

    // No credential / wrong-namespace admin / write scope: denied.
    for tok in [None, Some(other_admin.as_str()), Some(write.as_str())] {
        let (status, _) = call(&app, "GET", "/v1/namespaces/acme/audit", tok, None).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "token {tok:?}");
    }
    // Platform key and the namespace's own admin token both read.
    for tok in ["platform-secret", admin.as_str()] {
        let (status, body) = call(&app, "GET", "/v1/namespaces/acme/audit", Some(tok), None).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        let events = body["events"].as_array().unwrap();
        assert!(!events.is_empty());
        let ingest = events
            .iter()
            .find(|e| e["action"] == "memory.ingest")
            .expect("ingest event");
        // Actor attribution: credential hash + claims, never the token.
        assert_eq!(ingest["actor"]["kind"], "token");
        assert_eq!(ingest["actor"]["scope"], "write");
        assert_eq!(ingest["actor"]["claim_ns"], "acme");
        let hash = ingest["actor"]["token_hash"].as_str().unwrap();
        assert_eq!(hash.len(), 16);
        assert!(!serde_json::to_string(&body).unwrap().contains(&write));
    }
}

#[tokio::test]
async fn ai_egress_events_carry_metadata() {
    struct FixedEmbedder;
    #[async_trait::async_trait]
    impl memoturn_api::embed::Embedder for FixedEmbedder {
        async fn embed(
            &self,
            texts: &[String],
            _kind: memoturn_api::embed::EmbedKind,
        ) -> Result<Vec<Vec<f32>>, String> {
            Ok(texts.iter().map(|_| vec![1.0, 0.0]).collect())
        }
    }
    let dir = tempfile::tempdir().unwrap();
    let mut state = test_state(dir.path()).await;
    state.embedder = Some(Arc::new(FixedEmbedder));
    state.embed_provenance = Some(memoturn_api::embed::EmbedProvenance {
        provider: "openai".into(),
        model: "nomic-embed-text".into(),
        endpoint_host: "localhost".into(),
        self_hosted: true,
    });
    let app = router(state.clone());
    call(
        &app,
        "PUT",
        NS,
        None,
        Some(json!({"policy": {"audit": {"enabled": true}}})),
    )
    .await;
    call(
        &app,
        "POST",
        &format!("{P}/memories"),
        None,
        Some(json!({"memories": [
            {"type": "fact", "topic_key": "t", "summary": "prefers dark mode", "content": {}}
        ]})),
    )
    .await;

    let events = read_events(&state, &app, "?action=ai.embed").await;
    assert_eq!(events.len(), 1, "{events:?}");
    let eg = &events[0]["egress"];
    assert_eq!(eg["provider"], "openai");
    assert_eq!(eg["model"], "nomic-embed-text");
    assert_eq!(eg["self_hosted"], true);
    assert_eq!(eg["input_items"], 1);
    assert!(eg["input_bytes"].as_u64().unwrap() > 0);
    assert_eq!(eg["output_items"], 1);
    // The embedded text itself never reaches the stream.
    assert!(!serde_json::to_string(&events)
        .unwrap()
        .contains("dark mode"));
}
