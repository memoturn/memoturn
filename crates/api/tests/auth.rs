//! End-to-end authorization: platform key on the control plane, per-database
//! Ed25519 JWTs with read < write < admin on the data plane, the /sql
//! read-only allowance, db-binding, expiry, and the cluster-key internal hop.

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

const PLATFORM: &str = "platform-secret";
const CLUSTER: &str = "cluster-secret";

async fn secured_state(dir: &std::path::Path) -> (AppState, Arc<AuthKeys>) {
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
    let store = Arc::new(object_store::memory::InMemory::new());
    let replicator = Arc::new(memoturn_replication::Replicator::new(store, "v1"));
    let mesh = Arc::new(memoturn_api::mesh::Mesh::new(reqwest::Client::new()));
    let shipper = Arc::new(memoturn_replication::Shipper::new(
        replicator.clone(),
        node.clone(),
        Some(mesh.clone()),
    ));
    let (keys, _der) = AuthKeys::generate(PLATFORM.to_string(), CLUSTER.to_string()).unwrap();
    let keys = Arc::new(keys);
    let state = AppState {
        node,
        registry,
        replicator,
        shipper,
        control: Arc::new(memoturn_control::MemLeases::standalone("http://local")),
        mesh,
        auth: Auth::Enabled(keys.clone()),
        http: reqwest::Client::new(),
        extractor: None,
        embedder: None,
    };
    (state, keys)
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

#[tokio::test]
async fn platform_key_gates_the_control_plane() {
    let dir = tempfile::tempdir().unwrap();
    let (state, _) = secured_state(dir.path()).await;
    let app = router(state);

    let (status, _) = call(&app, "GET", "/v1/databases", None, None).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let (status, _) = call(&app, "GET", "/v1/databases", Some("wrong"), None).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let (status, _) = call(&app, "GET", "/v1/databases", Some(PLATFORM), None).await;
    assert_eq!(status, StatusCode::OK);

    // Token minting is a control-plane operation.
    call(
        &app,
        "POST",
        "/v1/databases",
        Some(PLATFORM),
        Some(json!({"name": "a"})),
    )
    .await;
    let (status, body) = call(
        &app,
        "POST",
        "/v1/databases/a/tokens",
        Some(PLATFORM),
        Some(json!({"scope": "write"})),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    assert!(
        body["token"].as_str().unwrap().split('.').count() == 3,
        "a JWT"
    );
}

#[tokio::test]
async fn scopes_are_enforced_and_db_bound() {
    let dir = tempfile::tempdir().unwrap();
    let (state, keys) = secured_state(dir.path()).await;
    let app = router(state);
    call(
        &app,
        "POST",
        "/v1/databases",
        Some(PLATFORM),
        Some(json!({"name": "a"})),
    )
    .await;
    call(
        &app,
        "POST",
        "/v1/databases",
        Some(PLATFORM),
        Some(json!({"name": "b"})),
    )
    .await;

    let read = keys.mint("a", Scope::Read, 3600).unwrap();
    let write = keys.mint("a", Scope::Write, 3600).unwrap();
    let admin = keys.mint("a", Scope::Admin, 3600).unwrap();
    let other = keys.mint("b", Scope::Admin, 3600).unwrap();

    // No token → 401. Garbage token → 401.
    let (status, _) = call(&app, "GET", "/v1/db/a/kv/s/k", None, None).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let (status, _) = call(&app, "GET", "/v1/db/a/kv/s/k", Some("not.a.jwt"), None).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);

    // Write scope writes; read scope cannot.
    let put = |token: &'static str| {
        Request::builder()
            .method("PUT")
            .uri("/v1/db/a/kv/s/k")
            .header("authorization", format!("Bearer {token}"))
            .body(Body::from("v"))
            .unwrap()
    };
    let write_static: &'static str = Box::leak(write.clone().into_boxed_str());
    let read_static: &'static str = Box::leak(read.clone().into_boxed_str());
    assert_eq!(
        app.clone()
            .oneshot(put(write_static))
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    assert_eq!(
        app.clone()
            .oneshot(put(read_static))
            .await
            .unwrap()
            .status(),
        StatusCode::FORBIDDEN
    );

    // Read scope reads.
    let (status, body) = call(&app, "GET", "/v1/db/a/kv/s/k", Some(&read), None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body, Value::String("v".into()));

    // Branch operations need admin.
    let (status, _) = call(
        &app,
        "POST",
        "/v1/db/a/branches",
        Some(&write),
        Some(json!({"name": "x"})),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, _) = call(
        &app,
        "POST",
        "/v1/db/a/branches",
        Some(&admin),
        Some(json!({"name": "x"})),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);

    // A token for database b cannot touch a.
    let (status, _) = call(&app, "GET", "/v1/db/a/kv/s/k", Some(&other), None).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    // …including via branch addressing.
    let (status, _) = call(&app, "GET", "/v1/db/a@x/kv/s/k", Some(&other), None).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn sql_read_only_allowance() {
    let dir = tempfile::tempdir().unwrap();
    let (state, keys) = secured_state(dir.path()).await;
    let app = router(state);
    call(
        &app,
        "POST",
        "/v1/databases",
        Some(PLATFORM),
        Some(json!({"name": "a"})),
    )
    .await;

    let write = keys.mint("a", Scope::Write, 3600).unwrap();
    let read = keys.mint("a", Scope::Read, 3600).unwrap();
    call(
        &app,
        "POST",
        "/v1/db/a/sql",
        Some(&write),
        Some(json!({"stmts": [
            {"q": "CREATE TABLE t (n INTEGER)"},
            {"q": "INSERT INTO t VALUES (1)"}
        ]})),
    )
    .await;

    // SELECT with read scope: allowed.
    let (status, body) = call(
        &app,
        "POST",
        "/v1/db/a/sql",
        Some(&read),
        Some(json!({"stmts": [{"q": "SELECT count(*) FROM t"}]})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["results"][0]["rows"][0][0], json!(1));

    // Mutation with read scope: forbidden (and rolled into nothing).
    let (status, _) = call(
        &app,
        "POST",
        "/v1/db/a/sql",
        Some(&read),
        Some(json!({"stmts": [
            {"q": "SELECT 1"},
            {"q": "INSERT INTO t VALUES (2)"}
        ]})),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (_, body) = call(
        &app,
        "POST",
        "/v1/db/a/sql",
        Some(&read),
        Some(json!({"stmts": [{"q": "SELECT count(*) FROM t"}]})),
    )
    .await;
    assert_eq!(
        body["results"][0]["rows"][0][0],
        json!(1),
        "nothing was written"
    );
}

#[tokio::test]
async fn expired_tokens_are_rejected() {
    let dir = tempfile::tempdir().unwrap();
    let (state, keys) = secured_state(dir.path()).await;
    let app = router(state);
    call(
        &app,
        "POST",
        "/v1/databases",
        Some(PLATFORM),
        Some(json!({"name": "a"})),
    )
    .await;

    let expired = keys.mint("a", Scope::Admin, -120).unwrap();
    let (status, body) = call(&app, "GET", "/v1/db/a/kv/s/k", Some(&expired), None).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "{body}");
}

#[tokio::test]
async fn namespace_tokens_cover_profiles_and_nothing_else() {
    let dir = tempfile::tempdir().unwrap();
    let (state, keys) = secured_state(dir.path()).await;
    let app = router(state);
    call(
        &app,
        "POST",
        "/v1/databases",
        Some(PLATFORM),
        Some(json!({"name": "plain-db"})),
    )
    .await;

    // A database name containing the `--` delimiter is rejected, so it can't be
    // smuggled inside a namespace token's authority (regression: covers_db hole).
    let (status, _) = call(
        &app,
        "POST",
        "/v1/databases",
        Some(PLATFORM),
        Some(json!({"name": "acme--prod"})),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    // Minting a namespace token is a control-plane operation.
    let (status, _) = call(
        &app,
        "POST",
        "/v1/namespaces/acme/tokens",
        None,
        Some(json!({"scope": "write"})),
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let (status, body) = call(
        &app,
        "POST",
        "/v1/namespaces/acme/tokens",
        Some(PLATFORM),
        Some(json!({"scope": "write"})),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    let ns_write = body["token"].as_str().unwrap().to_string();
    let ns_read = keys.mint_ns("acme", Scope::Read, 3600).unwrap();
    let ns_admin = keys.mint_ns("acme", Scope::Admin, 3600).unwrap();
    let other_ns = keys.mint_ns("evil", Scope::Admin, 3600).unwrap();

    // A namespace write token reaches every profile under acme…
    let memory = json!({"memories": [
        {"type": "fact", "topic_key": "k", "summary": "s", "content": {"v": 1}}
    ]});
    for profile in ["bot-a", "bot-b"] {
        let (status, body) = call(
            &app,
            "POST",
            &format!("/v1/memory/acme/{profile}/memories"),
            Some(&ns_write),
            Some(memory.clone()),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED, "{profile}: {body}");
    }
    // …and nothing outside it.
    let (status, _) = call(
        &app,
        "POST",
        "/v1/memory/acme/bot-a/memories",
        Some(&other_ns),
        Some(memory.clone()),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);

    // Read scope recalls but cannot ingest or forget.
    let (status, body) = call(
        &app,
        "POST",
        "/v1/memory/acme/bot-a/recall",
        Some(&ns_read),
        Some(json!({"topic_key": "k"})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let id = body["memories"][0]["id"].as_str().unwrap().to_string();
    let (status, _) = call(
        &app,
        "POST",
        "/v1/memory/acme/bot-a/memories",
        Some(&ns_read),
        Some(memory.clone()),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, _) = call(
        &app,
        "DELETE",
        &format!("/v1/memory/acme/bot-a/memories/{id}"),
        Some(&ns_read),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);

    // A per-database token is the agent posture: exactly one profile.
    let db_token = keys.mint("acme--bot-a", Scope::Write, 3600).unwrap();
    let (status, _) = call(
        &app,
        "POST",
        "/v1/memory/acme/bot-a/memories",
        Some(&db_token),
        Some(memory.clone()),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    let (status, _) = call(
        &app,
        "POST",
        "/v1/memory/acme/bot-b/memories",
        Some(&db_token),
        Some(memory.clone()),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);

    // Profile listing is namespace-token-only.
    let (status, body) = call(&app, "GET", "/v1/memory/acme", Some(&ns_read), None).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["profiles"].as_array().unwrap().len(), 2);
    let (status, _) = call(&app, "GET", "/v1/memory/acme", Some(&db_token), None).await;
    assert_eq!(status, StatusCode::FORBIDDEN);

    // Namespace admin tokens manage profile databases under /v1/db (branch
    // ops = checkpoint an agent's mind) — but never an unrelated database.
    let (status, body) = call(
        &app,
        "POST",
        "/v1/db/acme--bot-a/branches/main/checkpoint",
        Some(&ns_admin),
        Some(json!({"name": "cp"})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let (status, _) = call(
        &app,
        "POST",
        "/v1/db/plain-db/branches/main/checkpoint",
        Some(&ns_admin),
        Some(json!({"name": "cp"})),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn cluster_key_authenticates_internal_hops() {
    let dir = tempfile::tempdir().unwrap();
    let (state, _) = secured_state(dir.path()).await;
    let app = router(state);
    call(
        &app,
        "POST",
        "/v1/databases",
        Some(PLATFORM),
        Some(json!({"name": "a"})),
    )
    .await;

    // Internal endpoints demand the cluster key.
    let req = Request::builder()
        .method("POST")
        .uri("/internal/replica/subscribe")
        .header("content-type", "application/json")
        .body(Body::from(
            json!({"uuid": "u", "branch": "main", "addr": "http://x"}).to_string(),
        ))
        .unwrap();
    assert_eq!(
        app.clone().oneshot(req).await.unwrap().status(),
        StatusCode::UNAUTHORIZED
    );

    // A forwarded data-plane hop authenticates with the cluster key alone
    // (the edge already verified the user token).
    let req = Request::builder()
        .method("POST")
        .uri("/v1/db/a/sql")
        .header("X-Memoturn-Internal", CLUSTER)
        .header("content-type", "application/json")
        .body(Body::from(
            json!({"stmts": [{"q": "SELECT 1"}]}).to_string(),
        ))
        .unwrap();
    assert_eq!(
        app.clone().oneshot(req).await.unwrap().status(),
        StatusCode::OK
    );
}

#[tokio::test]
async fn deletion_tombstone_revokes_stale_write_tokens() {
    let dir = tempfile::tempdir().unwrap();
    let (state, keys) = secured_state(dir.path()).await;
    let app = router(state);

    // A namespace token covers every acme--* profile.
    let ns_token = keys.mint_ns("acme", Scope::Write, 3600).unwrap();
    let ingest = json!({"memories": [
        {"type": "fact", "topic_key": "t", "summary": "s", "content": {}}
    ]});

    // It can ingest — the profile auto-creates.
    let (st, _) = call(
        &app,
        "POST",
        "/v1/memory/acme/alice/memories",
        Some(&ns_token),
        Some(ingest.clone()),
    )
    .await;
    assert!(st.is_success(), "initial ingest: {st}");

    // The platform owner deletes the profile (writes a revocation tombstone).
    let (st, _) = call(
        &app,
        "DELETE",
        "/v1/databases/acme--alice",
        Some(PLATFORM),
        None,
    )
    .await;
    assert_eq!(st, StatusCode::NO_CONTENT);

    // The same still-unexpired token must NOT resurrect the deleted profile.
    let (st, body) = call(
        &app,
        "POST",
        "/v1/memory/acme/alice/memories",
        Some(&ns_token),
        Some(ingest.clone()),
    )
    .await;
    assert_eq!(
        st,
        StatusCode::FORBIDDEN,
        "stale token should be revoked: {body}"
    );

    // A token minted after the deletion re-provisions normally. iat is
    // second-granular, so cross a second boundary to clear the tombstone.
    tokio::time::sleep(Duration::from_millis(1100)).await;
    let fresh = keys.mint_ns("acme", Scope::Write, 3600).unwrap();
    let (st, _) = call(
        &app,
        "POST",
        "/v1/memory/acme/alice/memories",
        Some(&fresh),
        Some(ingest),
    )
    .await;
    assert!(st.is_success(), "post-deletion token should work: {st}");

    // Reads were never blocked by the tombstone (recall is read-scope).
    let (st, _) = call(
        &app,
        "POST",
        "/v1/memory/acme/alice/recall",
        Some(&ns_token),
        Some(json!({"query": "s"})),
    )
    .await;
    assert!(st.is_success(), "stale token may still read: {st}");
}
