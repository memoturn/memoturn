//! End-to-end data governance (ADR-0010, docs/architecture/08): namespace
//! policies with tighten-only profile overrides, task-TTL clamping, policy-
//! driven retention windows, memory-age sweeps, and the AI egress gate
//! (extract/ask deny → 403; auto-embed deny → silent skip).

use axum::body::Body;
use axum::http::{Request, StatusCode};
use http_body_util::BodyExt;
use memoturn_api::auth::{Auth, AuthKeys, Scope};
use memoturn_api::{router, AppState};
use memoturn_engine::{LibsqlEngine, NodeConfig, NodeEngine, Registry};
use serde_json::{json, Value};
use std::sync::atomic::{AtomicUsize, Ordering};
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
        auth: Auth::Disabled,
        http: reqwest::Client::new(),
        extractor: None,
        answerer: None,
        embedder: None,
        governance: Arc::new(memoturn_api::governance::PolicyStore::in_memory()),
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

#[tokio::test]
async fn namespace_policy_roundtrip_and_profile_view() {
    let dir = tempfile::tempdir().unwrap();
    let app = router(test_state(dir.path()).await);

    // No policy yet.
    let (status, _) = call(&app, "GET", NS, None, None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    let (status, body) = call(
        &app,
        "PUT",
        NS,
        None,
        Some(json!({"policy": {
            "retention": {"pitr_secs": 3600},
            "memory": {"task_ttl_max_secs": 600},
            "ai_egress": {"extract": "deny"},
        }})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["revision"], json!(1));

    let (status, body) = call(&app, "GET", NS, None, None).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["policy"]["retention"]["pitr_secs"], json!(3600));

    // The profile view folds env ceilings: with default env (86400/30d) the
    // namespace's tighter 3600 wins, and the env snapshot tier appears.
    let (status, body) = call(&app, "GET", &format!("{P}/policy"), None, None).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["override"], json!(null));
    assert_eq!(body["effective"]["pitr_secs"], json!(3600));
    assert_eq!(body["effective"]["task_ttl_max_secs"], json!(600));
    assert_eq!(body["effective"]["extract"], json!("deny"));

    // Invalid policies are rejected with the offending field.
    let (status, body) = call(
        &app,
        "PUT",
        NS,
        None,
        Some(json!({"policy": {"retention": {"pitr_secs": 1}}})),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    assert!(body["error"].as_str().unwrap().contains("pitr_secs"));
}

#[tokio::test]
async fn profile_override_tightens_only() {
    let dir = tempfile::tempdir().unwrap();
    let app = router(test_state(dir.path()).await);
    call(
        &app,
        "PUT",
        NS,
        None,
        Some(json!({"policy": {"retention": {"pitr_secs": 3600}}})),
    )
    .await;

    // Loosening is a 409 naming the field.
    let (status, body) = call(
        &app,
        "PUT",
        &format!("{P}/policy"),
        None,
        Some(json!({"policy": {"retention": {"pitr_secs": 7200}}})),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert!(body["error"].as_str().unwrap().contains("pitr_secs"));

    // Tightening lands; effective reflects the override.
    let (status, body) = call(
        &app,
        "PUT",
        &format!("{P}/policy"),
        None,
        Some(json!({"policy": {"retention": {"pitr_secs": 600}}})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["effective"]["pitr_secs"], json!(600));

    // Sibling profiles keep the namespace value.
    let (_, body) = call(&app, "GET", "/v1/memory/acme/bob/policy", None, None).await;
    assert_eq!(body["effective"]["pitr_secs"], json!(3600));

    // Clearing the override restores the namespace policy.
    let (status, body) = call(
        &app,
        "PUT",
        &format!("{P}/policy"),
        None,
        Some(json!({"policy": null})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["override"], json!(null));
    assert_eq!(body["effective"]["pitr_secs"], json!(3600));
}

#[tokio::test]
async fn policy_auth_platform_key_and_scopes() {
    let dir = tempfile::tempdir().unwrap();
    let mut state = test_state(dir.path()).await;
    let (keys, _der) =
        AuthKeys::generate("platform-secret".into(), "cluster-secret".into()).unwrap();
    let keys = Arc::new(keys);
    state.auth = Auth::Enabled(keys.clone());
    let app = router(state);

    // Namespace policy is control-plane: platform key required.
    let body = json!({"policy": {"retention": {"pitr_secs": 3600}}});
    let (status, _) = call(&app, "PUT", NS, None, Some(body.clone())).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let (status, _) = call(&app, "PUT", NS, Some("platform-secret"), Some(body)).await;
    assert_eq!(status, StatusCode::OK);

    // Profile override needs admin scope; reading the effective policy needs
    // only read scope. Policy precedes data — no ingest has happened.
    let read = keys.mint("acme--alice", Scope::Read, 3600).unwrap();
    let admin = keys.mint("acme--alice", Scope::Admin, 3600).unwrap();
    let over = json!({"policy": {"retention": {"pitr_secs": 600}}});
    let (status, _) = call(
        &app,
        "PUT",
        &format!("{P}/policy"),
        Some(&read),
        Some(over.clone()),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, body) = call(
        &app,
        "PUT",
        &format!("{P}/policy"),
        Some(&admin),
        Some(over),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let (status, body) = call(&app, "GET", &format!("{P}/policy"), Some(&read), None).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["effective"]["pitr_secs"], json!(600));
}

#[tokio::test]
async fn task_ttl_is_clamped_by_policy() {
    let dir = tempfile::tempdir().unwrap();
    let app = router(test_state(dir.path()).await);
    call(
        &app,
        "PUT",
        NS,
        None,
        Some(json!({"policy": {"memory": {"task_ttl_max_secs": 600}}})),
    )
    .await;

    // An explicit TTL above the cap and the (86400s) default both clamp.
    // Distinct content per task — the id is content-addressed.
    for (summary, ttl) in [("explicit", Some(99_999u64)), ("defaulted", None)] {
        let mut m = json!({"type": "task", "summary": summary, "content": {"t": summary},
                           "session_id": "s1"});
        if let Some(t) = ttl {
            m["ttl"] = json!(t);
        }
        let (status, body) = call(
            &app,
            "POST",
            &format!("{P}/memories"),
            None,
            Some(json!({"memories": [m]})),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED, "{body}");
        let id = body["results"][0]["id"].as_str().unwrap().to_string();
        let (_, mem) = call(&app, "GET", &format!("{P}/memories/{id}"), None, None).await;
        let created = mem["created_at"].as_i64().unwrap();
        let expires = mem["expires_at"].as_i64().unwrap();
        assert_eq!(expires - created, 600 * 1000, "{summary}: {mem}");
    }

    // A TTL under the cap is untouched.
    let (_, body) = call(
        &app,
        "POST",
        &format!("{P}/memories"),
        None,
        Some(json!({"memories": [
            {"type": "task", "summary": "short", "content": {"t": "short"}, "session_id": "s1",
             "ttl": 120}
        ]})),
    )
    .await;
    let id = body["results"][0]["id"].as_str().unwrap().to_string();
    let (_, mem) = call(&app, "GET", &format!("{P}/memories/{id}"), None, None).await;
    assert_eq!(
        mem["expires_at"].as_i64().unwrap() - mem["created_at"].as_i64().unwrap(),
        120 * 1000
    );
}

#[tokio::test]
async fn retention_windows_take_the_strictest_of_env_and_policy() {
    let env_fine = Duration::from_secs(86_400);
    let env_snap = Duration::from_secs(2_592_000);
    let doc: memoturn_api::governance::PolicyDoc = serde_json::from_value(json!({
        "schema_version": 1, "namespace": "acme", "revision": 1, "updated_at": 0,
        "policy": {"retention": {"pitr_secs": 3600, "pitr_snapshot_secs": 604800}},
        "profiles": {"alice": {"retention": {"pitr_secs": 600}}},
    }))
    .unwrap();
    let policies = std::collections::HashMap::from([("acme".to_string(), doc)]);

    // Profile override < namespace < env.
    let (fine, snap) =
        memoturn_api::retention_windows("acme--alice", env_fine, env_snap, &policies);
    assert_eq!(fine, Duration::from_secs(600));
    assert_eq!(snap, Duration::from_secs(604_800));
    // Namespace policy alone for sibling profiles.
    let (fine, _) = memoturn_api::retention_windows("acme--bob", env_fine, env_snap, &policies);
    assert_eq!(fine, Duration::from_secs(3600));
    // No policy / plain database names: env ceilings unchanged.
    let (fine, snap) = memoturn_api::retention_windows("other--x", env_fine, env_snap, &policies);
    assert_eq!((fine, snap), (env_fine, env_snap));
    let (fine, _) = memoturn_api::retention_windows("plaindb", env_fine, env_snap, &policies);
    assert_eq!(fine, env_fine);
}

#[tokio::test]
async fn memory_sweep_enforces_superseded_history_cap() {
    let dir = tempfile::tempdir().unwrap();
    let state = test_state(dir.path()).await;
    let app = router(state.clone());
    call(
        &app,
        "PUT",
        NS,
        None,
        Some(json!({"policy": {"memory": {"superseded_max_count": 1}}})),
    )
    .await;

    // Three generations on one topic → two superseded rows.
    for v in ["v1", "v2", "v3"] {
        let (status, body) = call(
            &app,
            "POST",
            &format!("{P}/memories"),
            None,
            Some(json!({"memories": [
                {"type": "fact", "topic_key": "user.plan", "summary": format!("plan {v}"),
                 "content": {"v": v}}
            ]})),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED, "{body}");
    }
    let recall_all = json!({"topic_key": "user.plan", "include_superseded": true, "k": 10});
    let (_, body) = call(
        &app,
        "POST",
        &format!("{P}/recall"),
        None,
        Some(recall_all.clone()),
    )
    .await;
    assert_eq!(body["memories"].as_array().unwrap().len(), 3, "{body}");

    // The maintenance sweep applies the policy: only the newest superseded
    // row survives alongside the active one.
    let swept = memoturn_api::sweep_expired(&state).await;
    assert_eq!(swept, 1, "exactly the oldest superseded row goes");
    let (_, body) = call(&app, "POST", &format!("{P}/recall"), None, Some(recall_all)).await;
    let remaining: Vec<_> = body["memories"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| m["summary"].as_str().unwrap().to_string())
        .collect();
    assert_eq!(remaining.len(), 2, "{body}");
    assert!(remaining.contains(&"plan v3".to_string()));
    assert!(remaining.contains(&"plan v2".to_string()));
    assert!(!remaining.contains(&"plan v1".to_string()));
}

/// Extractor stub that counts invocations — proves a denied request never
/// reaches the provider.
struct CountingExtractor(Arc<AtomicUsize>);

#[async_trait::async_trait]
impl memoturn_api::extract::Extractor for CountingExtractor {
    async fn extract(
        &self,
        _turns: &[memoturn_api::extract::Turn],
    ) -> Result<Vec<memoturn_api::extract::ExtractedMemory>, String> {
        self.0.fetch_add(1, Ordering::SeqCst);
        Ok(vec![])
    }
}

#[tokio::test]
async fn extract_denied_by_policy_is_403_and_never_calls_provider() {
    let dir = tempfile::tempdir().unwrap();
    let calls = Arc::new(AtomicUsize::new(0));
    let mut state = test_state(dir.path()).await;
    state.extractor = Some(Arc::new(CountingExtractor(calls.clone())));
    let app = router(state);
    call(
        &app,
        "PUT",
        NS,
        None,
        Some(json!({"policy": {"ai_egress": {"extract": "deny"}}})),
    )
    .await;

    let (status, body) = call(
        &app,
        "POST",
        &format!("{P}/extract"),
        None,
        Some(json!({"turns": [{"role": "user", "content": {"text": "hi"}}]})),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    assert!(body["error"]
        .as_str()
        .unwrap()
        .contains("ai_egress.extract"));
    assert_eq!(
        calls.load(Ordering::SeqCst),
        0,
        "provider must not be called"
    );

    // Other namespaces are unaffected.
    let (status, _) = call(
        &app,
        "POST",
        "/v1/memory/globex/alice/extract",
        None,
        Some(json!({"turns": [{"role": "user", "content": {"text": "hi"}}]})),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(calls.load(Ordering::SeqCst), 1);
}

/// Answerer stub that counts invocations.
struct CountingAnswerer(Arc<AtomicUsize>);

#[async_trait::async_trait]
impl memoturn_api::answer::Answerer for CountingAnswerer {
    async fn answer(
        &self,
        _question: &str,
        memories: &[Value],
    ) -> Result<memoturn_api::answer::SynthesizedAnswer, String> {
        self.0.fetch_add(1, Ordering::SeqCst);
        Ok(memoturn_api::answer::SynthesizedAnswer {
            answer: "ok".into(),
            sources: vec![memories[0]["id"].as_str().unwrap_or("").to_string()],
        })
    }
}

#[tokio::test]
async fn ask_denied_by_policy_is_403_and_never_calls_provider() {
    let dir = tempfile::tempdir().unwrap();
    let calls = Arc::new(AtomicUsize::new(0));
    let mut state = test_state(dir.path()).await;
    state.answerer = Some(Arc::new(CountingAnswerer(calls.clone())));
    let app = router(state);
    call(
        &app,
        "PUT",
        NS,
        None,
        Some(json!({"policy": {"ai_egress": {"ask": "deny"}}})),
    )
    .await;
    call(
        &app,
        "POST",
        &format!("{P}/memories"),
        None,
        Some(json!({"memories": [
            {"type": "fact", "topic_key": "t", "summary": "refunds in 30 days",
             "content": {}, "keywords": "refund"}
        ]})),
    )
    .await;

    let (status, body) = call(
        &app,
        "POST",
        &format!("{P}/ask"),
        None,
        Some(json!({"question": "refund window?"})),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    assert!(body["error"].as_str().unwrap().contains("ai_egress.ask"));
    assert_eq!(
        calls.load(Ordering::SeqCst),
        0,
        "provider must not be called"
    );
}

/// Embedder stub that counts invocations and returns constant vectors.
struct CountingEmbedder(Arc<AtomicUsize>);

#[async_trait::async_trait]
impl memoturn_api::embed::Embedder for CountingEmbedder {
    async fn embed(
        &self,
        texts: &[String],
        _kind: memoturn_api::embed::EmbedKind,
    ) -> Result<Vec<Vec<f32>>, String> {
        self.0.fetch_add(1, Ordering::SeqCst);
        Ok(texts.iter().map(|_| vec![1.0, 0.0]).collect())
    }
}

#[tokio::test]
async fn embed_deny_skips_silently_and_keyword_recall_still_works() {
    let dir = tempfile::tempdir().unwrap();
    let calls = Arc::new(AtomicUsize::new(0));
    let mut state = test_state(dir.path()).await;
    state.embedder = Some(Arc::new(CountingEmbedder(calls.clone())));
    let app = router(state);
    call(
        &app,
        "PUT",
        NS,
        None,
        Some(json!({"policy": {"ai_egress": {"embed": "deny"}}})),
    )
    .await;

    // Ingest succeeds — the denied embed behaves like an unconfigured embedder.
    let (status, body) = call(
        &app,
        "POST",
        &format!("{P}/memories"),
        None,
        Some(json!({"memories": [
            {"type": "fact", "topic_key": "user.theme", "summary": "prefers dark mode",
             "content": {}, "keywords": "theme dark"}
        ]})),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{body}");

    // Keyword recall works; the vector channel never lights up; the provider
    // was never called for the items or the query.
    let (status, body) = call(
        &app,
        "POST",
        &format!("{P}/recall"),
        None,
        Some(json!({"query": "dark"})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let hit = &body["memories"][0];
    assert_eq!(hit["summary"], json!("prefers dark mode"), "{body}");
    assert!(
        !hit["channels"]
            .as_array()
            .unwrap()
            .contains(&json!("vector")),
        "no vectors may exist under embed deny: {body}"
    );
    assert_eq!(
        calls.load(Ordering::SeqCst),
        0,
        "provider must not be called"
    );
}

#[tokio::test]
async fn embed_self_hosted_only_requires_self_hosted_provenance() {
    let dir = tempfile::tempdir().unwrap();
    let calls = Arc::new(AtomicUsize::new(0));
    let mut state = test_state(dir.path()).await;
    state.embedder = Some(Arc::new(CountingEmbedder(calls.clone())));
    // Provenance says the embedder egresses to a public endpoint.
    state.embed_provenance = Some(memoturn_api::embed::EmbedProvenance {
        provider: "voyage".into(),
        model: "voyage-3.5".into(),
        endpoint_host: "api.voyageai.com".into(),
        self_hosted: false,
    });
    let app = router(state.clone());
    call(
        &app,
        "PUT",
        NS,
        None,
        Some(json!({"policy": {"ai_egress": {"embed": "self_hosted_only"}}})),
    )
    .await;

    let ingest = json!({"memories": [
        {"type": "fact", "topic_key": "user.theme", "summary": "prefers dark mode",
         "content": {}, "keywords": "theme dark"}
    ]});
    let (status, _) = call(
        &app,
        "POST",
        &format!("{P}/memories"),
        None,
        Some(ingest.clone()),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(
        calls.load(Ordering::SeqCst),
        0,
        "public embedder must be skipped"
    );

    // The same policy with a self-hosted embedder embeds normally.
    let mut state2 = state;
    state2.embed_provenance = Some(memoturn_api::embed::EmbedProvenance {
        provider: "openai".into(),
        model: "nomic-embed-text".into(),
        endpoint_host: "localhost".into(),
        self_hosted: true,
    });
    let app2 = router(state2);
    let (status, _) = call(
        &app2,
        "POST",
        "/v1/memory/acme/bob/memories",
        None,
        Some(ingest),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(
        calls.load(Ordering::SeqCst),
        1,
        "self-hosted embedder may embed"
    );
}
