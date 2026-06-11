//! End-to-end: typed agent memory (docs/architecture/07, ADR-0009) —
//! idempotent ingest, supersession by topic, hybrid recall across the
//! topic/keyword/vector channels, task TTL, forget, and the headline
//! property: a profile's whole memory forks and rewinds as one database.

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

const P: &str = "/v1/memory/acme/support-bot";

fn fact(topic: &str, summary: &str, v: &str, embedding: Vec<f32>) -> Value {
    json!({
        "type": "fact", "topic_key": topic, "summary": summary,
        "content": {"value": v}, "keywords": "policy refund",
        "embedding": embedding,
    })
}

#[tokio::test]
async fn ingest_is_idempotent_and_supersedes_by_topic() {
    let dir = tempfile::tempdir().unwrap();
    let app = router(test_state(dir.path()).await);

    // First ingest auto-creates the profile.
    let (status, body) = call(
        &app,
        "POST",
        &format!("{P}/memories"),
        Some(json!({"memories": [fact("refund.window", "refunds within 30 days", "30d", vec![1.0, 0.0])]})),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    let first_id = body["results"][0]["id"].as_str().unwrap().to_string();
    assert_eq!(body["results"][0]["status"], json!("created"));
    assert_eq!(body["results"][0]["superseded"], json!([]));

    // Same payload again → duplicate, same id, nothing superseded.
    let (status, body) = call(
        &app,
        "POST",
        &format!("{P}/memories"),
        Some(json!({"memories": [fact("refund.window", "refunds within 30 days", "30d", vec![1.0, 0.0])]})),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    assert_eq!(body["results"][0]["status"], json!("duplicate"));
    assert_eq!(body["results"][0]["id"].as_str().unwrap(), first_id);

    // New fact on the same topic supersedes the old one.
    let (status, body) = call(
        &app,
        "POST",
        &format!("{P}/memories"),
        Some(json!({"memories": [fact("refund.window", "refunds within 60 days", "60d", vec![0.9, 0.1])]})),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    let new_id = body["results"][0]["id"].as_str().unwrap().to_string();
    assert_eq!(body["results"][0]["superseded"], json!([first_id.clone()]));

    // The old memory is preserved with the full chain, not deleted.
    let (status, body) = call(&app, "GET", &format!("{P}/memories/{first_id}"), None).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["superseded_by"].as_str().unwrap(), new_id);
    let (_, body) = call(&app, "GET", &format!("{P}/memories/{new_id}"), None).await;
    assert_eq!(body["supersedes"], json!([first_id]));
}

#[tokio::test]
async fn recall_merges_topic_keyword_and_vector_channels() {
    let dir = tempfile::tempdir().unwrap();
    let app = router(test_state(dir.path()).await);

    let (status, body) = call(
        &app,
        "POST",
        &format!("{P}/memories"),
        Some(json!({"memories": [
            {"type": "fact", "topic_key": "user.theme", "summary": "prefers dark mode",
             "content": {"theme": "dark"}, "keywords": "theme ui", "embedding": [1.0, 0.0, 0.0]},
            {"type": "event", "summary": "deployed v2 to production",
             "content": {"version": "v2"}, "keywords": "deploy release", "embedding": [0.0, 1.0, 0.0]},
            {"type": "instruction", "summary": "always reply in formal tone",
             "content": {"tone": "formal"}, "embedding": [0.0, 0.0, 1.0]},
        ]})),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{body}");

    // Keyword channel only.
    let (status, body) = call(
        &app,
        "POST",
        &format!("{P}/recall"),
        Some(json!({"query": "what theme does the user prefer?"})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let hits = body["memories"].as_array().unwrap();
    assert_eq!(hits[0]["summary"], json!("prefers dark mode"), "{body}");
    assert!(hits[0]["channels"]
        .as_array()
        .unwrap()
        .contains(&json!("keyword")));

    // Topic channel outranks everything (weighted highest).
    let (_, body) = call(
        &app,
        "POST",
        &format!("{P}/recall"),
        Some(json!({"topic_key": "user.theme", "query": "deployed production"})),
    )
    .await;
    let hits = body["memories"].as_array().unwrap();
    assert_eq!(hits[0]["topic_key"], json!("user.theme"), "{body}");
    assert!(hits[0]["channels"]
        .as_array()
        .unwrap()
        .contains(&json!("topic")));

    // Vector channel: nearest embedding wins.
    let (_, body) = call(
        &app,
        "POST",
        &format!("{P}/recall"),
        Some(json!({"embedding": [0.0, 0.95, 0.05], "k": 2})),
    )
    .await;
    let hits = body["memories"].as_array().unwrap();
    assert_eq!(
        hits[0]["summary"],
        json!("deployed v2 to production"),
        "{body}"
    );
    assert!(hits[0]["channels"]
        .as_array()
        .unwrap()
        .contains(&json!("vector")));

    // Type filter.
    let (_, body) = call(
        &app,
        "POST",
        &format!("{P}/recall"),
        Some(json!({"query": "theme deploy formal", "types": ["instruction"]})),
    )
    .await;
    for hit in body["memories"].as_array().unwrap() {
        assert_eq!(hit["type"], json!("instruction"));
    }

    // Recall never pads: nonsense query on a real profile is empty.
    let (status, body) = call(
        &app,
        "POST",
        &format!("{P}/recall"),
        Some(json!({"query": "zzzqqqxxx"})),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["memories"], json!([]));

    // Unknown profile: empty, never auto-created by a read.
    let (status, body) = call(
        &app,
        "POST",
        "/v1/memory/acme/nobody/recall",
        Some(json!({"query": "anything"})),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["memories"], json!([]));
    let (_, body) = call(&app, "GET", "/v1/memory/acme", None).await;
    let profiles = body["profiles"].as_array().unwrap();
    assert_eq!(profiles.len(), 1, "{body}");
    assert_eq!(profiles[0]["profile"], json!("support-bot"));
}

#[tokio::test]
async fn re_asserting_a_superseded_fact_revives_it() {
    // Regression: dark → light → dark again must make dark active again, not
    // report a no-op duplicate that leaves "light" the answer forever.
    let dir = tempfile::tempdir().unwrap();
    let app = router(test_state(dir.path()).await);
    let assert_seat = |app: axum::Router, want: &'static str| async move {
        let (_, body) = call(
            &app,
            "POST",
            &format!("{P}/recall"),
            Some(json!({"topic_key": "user.theme"})),
        )
        .await;
        assert_eq!(body["memories"][0]["content"]["v"], json!(want), "{body}");
        assert_eq!(body["memories"].as_array().unwrap().len(), 1);
    };
    let put = |v: &'static str| {
        json!({"memories": [{"type": "fact", "topic_key": "user.theme",
            "summary": format!("theme {v}"), "content": {"v": v}}]})
    };

    call(&app, "POST", &format!("{P}/memories"), Some(put("dark"))).await;
    call(&app, "POST", &format!("{P}/memories"), Some(put("light"))).await;
    assert_seat(app.clone(), "light").await;

    let (_, body) = call(&app, "POST", &format!("{P}/memories"), Some(put("dark"))).await;
    assert_eq!(body["results"][0]["status"], json!("revived"), "{body}");
    assert_seat(app.clone(), "dark").await;

    // And an already-active re-assert is still a plain duplicate (no thrash).
    let (_, body) = call(&app, "POST", &format!("{P}/memories"), Some(put("dark"))).await;
    assert_eq!(body["results"][0]["status"], json!("duplicate"), "{body}");
}

#[tokio::test]
async fn type_filter_is_not_starved_by_higher_ranked_other_types() {
    // Regression: many events outrank a few tasks for the same keyword; a
    // types:["task"] recall must still find the tasks (filter pushed into SQL),
    // not return empty because the candidate window filled with events.
    let dir = tempfile::tempdir().unwrap();
    let app = router(test_state(dir.path()).await);
    let mut mems: Vec<Value> = (0..60)
        .map(|i| {
            json!({"type": "event", "summary": format!("deploy event {i}"),
            "content": {"n": i}, "keywords": "deploy release"})
        })
        .collect();
    mems.push(json!({"type": "task", "summary": "deploy the hotfix",
        "content": {}, "keywords": "deploy", "session_id": "s-1"}));
    call(
        &app,
        "POST",
        &format!("{P}/memories"),
        Some(json!({"memories": mems})),
    )
    .await;

    let (status, body) = call(
        &app,
        "POST",
        &format!("{P}/recall"),
        Some(json!({"query": "deploy", "types": ["task"], "k": 5})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let hits = body["memories"].as_array().unwrap();
    assert_eq!(hits.len(), 1, "{body}");
    assert_eq!(hits[0]["summary"], json!("deploy the hotfix"));

    // Session filter is pushed down the same way.
    let (_, body) = call(
        &app,
        "POST",
        &format!("{P}/recall"),
        Some(json!({"query": "deploy", "session_id": "s-1"})),
    )
    .await;
    assert_eq!(body["memories"].as_array().unwrap().len(), 1, "{body}");
}

#[tokio::test]
async fn mismatched_embedding_dimension_does_not_poison_ingest_or_recall() {
    // Regression: once the vec table is fixed at dim 2, a later dim-3 embedding
    // must be skipped (keyword/topic rows still land), and a dim-mismatched
    // recall embedding degrades to keyword+topic instead of erroring.
    let dir = tempfile::tempdir().unwrap();
    let app = router(test_state(dir.path()).await);
    call(
        &app,
        "POST",
        &format!("{P}/memories"),
        Some(
            json!({"memories": [{"type": "event", "summary": "first with 2-dim vec",
            "content": {"n": 1}, "keywords": "alpha", "embedding": [1.0, 0.0]}]}),
        ),
    )
    .await;
    // Wrong-dimension embedding: ingest still succeeds, row still keyword-findable.
    let (status, body) = call(
        &app,
        "POST",
        &format!("{P}/memories"),
        Some(
            json!({"memories": [{"type": "event", "summary": "second with 3-dim vec",
            "content": {"n": 2}, "keywords": "beta", "embedding": [1.0, 0.0, 0.0]}]}),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    let (_, body) = call(
        &app,
        "POST",
        &format!("{P}/recall"),
        Some(json!({"query": "beta"})),
    )
    .await;
    assert_eq!(
        body["memories"][0]["summary"],
        json!("second with 3-dim vec"),
        "{body}"
    );

    // Recall with a wrong-dim embedding degrades, doesn't 400.
    let (status, body) = call(
        &app,
        "POST",
        &format!("{P}/recall"),
        Some(json!({"query": "alpha", "embedding": [0.5, 0.5, 0.5]})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(
        body["memories"][0]["summary"],
        json!("first with 2-dim vec"),
        "{body}"
    );
}

#[tokio::test]
async fn unknown_profile_read_honors_min_txid() {
    let dir = tempfile::tempdir().unwrap();
    let app = router(test_state(dir.path()).await);
    // No Min-Txid → empty, not 404 (recall never creates).
    let (status, body) = call(
        &app,
        "POST",
        "/v1/memory/acme/nobody/recall",
        Some(json!({"query": "x"})),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["memories"], json!([]));
    // Min-Txid > 0 on an unknown profile → 404, so a read-your-writes client
    // isn't told "no memories, txid 0" below its watermark.
    let req = Request::builder()
        .method("POST")
        .uri("/v1/memory/acme/nobody/recall")
        .header("content-type", "application/json")
        .header("Memoturn-Min-Txid", "7")
        .body(Body::from(json!({"query": "x"}).to_string()))
        .unwrap();
    let resp = app.clone().oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn recall_hides_superseded_unless_asked() {
    let dir = tempfile::tempdir().unwrap();
    let app = router(test_state(dir.path()).await);

    for v in ["30d", "60d"] {
        let summary = format!("refunds within {v}");
        call(
            &app,
            "POST",
            &format!("{P}/memories"),
            Some(json!({"memories": [
                {"type": "fact", "topic_key": "refund.window", "summary": summary,
                 "content": {"value": v}, "keywords": "refund policy"}
            ]})),
        )
        .await;
    }

    let (_, body) = call(
        &app,
        "POST",
        &format!("{P}/recall"),
        Some(json!({"topic_key": "refund.window"})),
    )
    .await;
    let hits = body["memories"].as_array().unwrap();
    assert_eq!(hits.len(), 1, "{body}");
    assert_eq!(hits[0]["summary"], json!("refunds within 60d"));

    let (_, body) = call(
        &app,
        "POST",
        &format!("{P}/recall"),
        Some(json!({"topic_key": "refund.window", "include_superseded": true})),
    )
    .await;
    assert_eq!(body["memories"].as_array().unwrap().len(), 2, "{body}");
}

#[tokio::test]
async fn tasks_expire_and_sessions_end() {
    let dir = tempfile::tempdir().unwrap();
    let app = router(test_state(dir.path()).await);

    let (status, body) = call(
        &app,
        "POST",
        &format!("{P}/memories"),
        Some(json!({"memories": [
            {"type": "task", "summary": "follow up on ticket 88",
             "content": {"ticket": 88}, "session_id": "s-1", "ttl": 3600},
            {"type": "task", "summary": "already expired chore",
             "content": {"n": 1}, "session_id": "s-1", "ttl": 0},
            {"type": "fact", "topic_key": "user.name", "summary": "user is named Ada",
             "content": {"name": "Ada"}, "session_id": "s-1"},
        ]})),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{body}");

    // ttl=0 expired immediately; live task + fact remain findable.
    let (_, body) = call(
        &app,
        "POST",
        &format!("{P}/recall"),
        Some(json!({"query": "follow up expired chore Ada"})),
    )
    .await;
    let summaries: Vec<&str> = body["memories"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| m["summary"].as_str().unwrap())
        .collect();
    assert!(summaries.contains(&"follow up on ticket 88"), "{body}");
    assert!(!summaries.contains(&"already expired chore"), "{body}");

    let (_, body) = call(&app, "GET", &format!("{P}/sessions"), None).await;
    assert_eq!(body["sessions"].as_array().unwrap().len(), 1);
    assert_eq!(body["sessions"][0]["id"], json!("s-1"));

    // Ending the session deletes its tasks; durable memories survive.
    let (status, _) = call(&app, "DELETE", &format!("{P}/sessions/s-1"), None).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let (_, body) = call(
        &app,
        "POST",
        &format!("{P}/recall"),
        Some(json!({"query": "follow up ticket Ada"})),
    )
    .await;
    let summaries: Vec<&str> = body["memories"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| m["summary"].as_str().unwrap())
        .collect();
    assert!(!summaries.contains(&"follow up on ticket 88"), "{body}");
    assert!(summaries.contains(&"user is named Ada"), "{body}");
    let (_, body) = call(&app, "GET", &format!("{P}/sessions"), None).await;
    assert_eq!(body["sessions"], json!([]));
}

#[tokio::test]
async fn recall_raw_turn_channel_searches_the_transcript() {
    let dir = tempfile::tempdir().unwrap();
    let app = router(test_state(dir.path()).await);

    // A typed memory plus transcript turns in two sessions — only some of
    // what was said became a memory.
    call(
        &app,
        "POST",
        &format!("{P}/memories"),
        Some(json!({"memories": [
            {"type": "fact", "topic_key": "user.theme", "summary": "prefers dark mode",
             "content": {"theme": "dark"}, "embedding": [1.0, 0.0]}
        ]})),
    )
    .await;
    for (session, text, emb) in [
        ("s-1", "my cat is named Turing", [0.0, 1.0]),
        ("s-2", "I work night shifts", [0.7, 0.7]),
    ] {
        let (status, body) = call(
            &app,
            "POST",
            &format!("/v1/db/acme--support-bot/memory/{session}/turns"),
            Some(json!({"role": "user", "content": {"text": text}, "embedding": emb})),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED, "{body}");
    }

    // include_turns surfaces the verbatim moment in a separate array.
    let (status, body) = call(
        &app,
        "POST",
        &format!("{P}/recall"),
        Some(json!({"embedding": [0.0, 1.0], "include_turns": true, "k": 2})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let turns = body["turns"].as_array().unwrap();
    assert_eq!(
        turns[0]["content"]["text"],
        json!("my cat is named Turing"),
        "{body}"
    );
    assert_eq!(turns[0]["session_id"], json!("s-1"));
    assert!(
        !body["memories"].as_array().unwrap().is_empty(),
        "memories still ranked"
    );

    // Session-scoped: s-2 only.
    let (_, body) = call(
        &app,
        "POST",
        &format!("{P}/recall"),
        Some(json!({"embedding": [0.0, 1.0], "include_turns": true, "session_id": "s-2"})),
    )
    .await;
    let turns = body["turns"].as_array().unwrap();
    assert_eq!(turns.len(), 1);
    assert_eq!(turns[0]["content"]["text"], json!("I work night shifts"));

    // Without include_turns there is no turns key; with it but no embedding → 400.
    let (_, body) = call(
        &app,
        "POST",
        &format!("{P}/recall"),
        Some(json!({"embedding": [0.0, 1.0]})),
    )
    .await;
    assert!(body.get("turns").is_none());
    let (status, _) = call(
        &app,
        "POST",
        &format!("{P}/recall"),
        Some(json!({"query": "cat", "include_turns": true})),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn forget_removes_from_recall() {
    let dir = tempfile::tempdir().unwrap();
    let app = router(test_state(dir.path()).await);

    let (_, body) = call(
        &app,
        "POST",
        &format!("{P}/memories"),
        Some(json!({"memories": [
            {"type": "event", "summary": "user reported a billing bug",
             "content": {"area": "billing"}, "keywords": "billing bug"}
        ]})),
    )
    .await;
    let id = body["results"][0]["id"].as_str().unwrap().to_string();

    let (status, _) = call(&app, "DELETE", &format!("{P}/memories/{id}"), None).await;
    assert_eq!(status, StatusCode::NO_CONTENT);

    let (_, body) = call(
        &app,
        "POST",
        &format!("{P}/recall"),
        Some(json!({"query": "billing bug"})),
    )
    .await;
    assert_eq!(body["memories"], json!([]), "{body}");
    let (status, _) = call(&app, "GET", &format!("{P}/memories/{id}"), None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    // Forgetting twice is a clean 404, not an error.
    let (status, _) = call(&app, "DELETE", &format!("{P}/memories/{id}"), None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn profile_memory_forks_and_rewinds_as_one_database() {
    let dir = tempfile::tempdir().unwrap();
    let app = router(test_state(dir.path()).await);

    call(
        &app,
        "POST",
        &format!("{P}/memories"),
        Some(json!({"memories": [fact("refund.window", "refunds within 30 days", "30d", vec![1.0, 0.0])]})),
    )
    .await;

    // Checkpoint the profile's whole memory (profile = database).
    let (status, body) = call(
        &app,
        "POST",
        "/v1/db/acme--support-bot/branches/main/checkpoint",
        Some(json!({"name": "before-learning"})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");

    // Learn something newer on the same topic…
    let (_, body) = call(
        &app,
        "POST",
        &format!("{P}/memories"),
        Some(json!({"memories": [fact("refund.window", "refunds within 90 days", "90d", vec![0.8, 0.2])]})),
    )
    .await;
    assert_eq!(body["results"][0]["status"], json!("created"), "{body}");
    let (_, body) = call(
        &app,
        "POST",
        &format!("{P}/recall"),
        Some(json!({"topic_key": "refund.window"})),
    )
    .await;
    assert_eq!(
        body["memories"][0]["summary"],
        json!("refunds within 90 days")
    );

    // …then rewind the mind: pre-supersession memory is active again.
    let (status, body) = call(
        &app,
        "POST",
        "/v1/db/acme--support-bot/branches/main/rewind",
        Some(json!({"to": "before-learning"})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let (_, body) = call(
        &app,
        "POST",
        &format!("{P}/recall"),
        Some(json!({"topic_key": "refund.window"})),
    )
    .await;
    let hits = body["memories"].as_array().unwrap();
    assert_eq!(hits.len(), 1, "{body}");
    assert_eq!(hits[0]["summary"], json!("refunds within 30 days"));
    assert_eq!(hits[0]["superseded_by"], json!(null));
}

/// Test extractor: deterministically distills any transcript into one fact
/// (the LLM is out of scope here — extract.rs unit-tests the Claude client).
struct FixedExtractor;

#[async_trait::async_trait]
impl memoturn_api::extract::Extractor for FixedExtractor {
    async fn extract(
        &self,
        turns: &[memoturn_api::extract::Turn],
    ) -> Result<Vec<memoturn_api::extract::ExtractedMemory>, String> {
        assert!(!turns.is_empty());
        Ok(vec![memoturn_api::extract::ExtractedMemory {
            mtype: "fact".into(),
            topic_key: Some("user.diet".into()),
            summary: "vegetarian since 2024".into(),
            details: "The user has been vegetarian since 2024.".into(),
            keywords: "diet food preference".into(),
        }])
    }
}

#[tokio::test]
async fn extract_distills_turns_into_ingested_memories() {
    let dir = tempfile::tempdir().unwrap();
    let mut state = test_state(dir.path()).await;
    state.extractor = Some(Arc::new(FixedExtractor));
    let app = router(state);

    let turns = json!({"turns": [
        {"role": "user", "content": {"text": "I'm vegetarian, have been since 2024"}},
        {"role": "assistant", "content": {"text": "Noted!"}}
    ], "session_id": "s-9"});

    // Dry run proposes without writing — the profile is never created.
    let (status, body) = call(
        &app,
        "POST",
        &format!("{P}/extract"),
        Some(json!({"turns": turns["turns"], "dry_run": true})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["proposed"][0]["topic_key"], json!("user.diet"));
    let (_, body) = call(
        &app,
        "POST",
        &format!("{P}/recall"),
        Some(json!({"query": "diet"})),
    )
    .await;
    assert_eq!(body["memories"], json!([]), "dry run must not ingest");

    // Real extraction lands in the profile via the idempotent ingest path.
    let (status, body) = call(&app, "POST", &format!("{P}/extract"), Some(turns.clone())).await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    assert_eq!(body["results"][0]["status"], json!("created"));
    let (status, body) = call(&app, "POST", &format!("{P}/extract"), Some(turns)).await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    assert_eq!(
        body["results"][0]["status"],
        json!("duplicate"),
        "extraction is idempotent too"
    );

    let (_, body) = call(
        &app,
        "POST",
        &format!("{P}/recall"),
        Some(json!({"topic_key": "user.diet"})),
    )
    .await;
    assert_eq!(
        body["memories"][0]["summary"],
        json!("vegetarian since 2024")
    );
    assert_eq!(body["memories"][0]["session_id"], json!("s-9"));
}

#[tokio::test]
async fn extract_without_extractor_is_unavailable() {
    let dir = tempfile::tempdir().unwrap();
    let app = router(test_state(dir.path()).await);
    let (status, _) = call(
        &app,
        "POST",
        &format!("{P}/extract"),
        Some(json!({"turns": [{"role": "user", "content": "hi"}]})),
    )
    .await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
}

/// Test answerer: echoes the top recalled memory back as the answer (the LLM
/// is out of scope here — answer.rs unit-tests the Claude client).
struct FixedAnswerer;

#[async_trait::async_trait]
impl memoturn_api::answer::Answerer for FixedAnswerer {
    async fn answer(
        &self,
        question: &str,
        memories: &[Value],
    ) -> Result<memoturn_api::answer::SynthesizedAnswer, String> {
        assert!(!question.is_empty());
        assert!(
            !memories.is_empty(),
            "ask must not call the LLM on empty recall"
        );
        Ok(memoturn_api::answer::SynthesizedAnswer {
            answer: format!("Per memory: {}", memories[0]["summary"].as_str().unwrap()),
            sources: vec![memories[0]["id"].as_str().unwrap().to_string()],
        })
    }
}

#[tokio::test]
async fn ask_synthesizes_answer_from_recalled_memories() {
    let dir = tempfile::tempdir().unwrap();
    let mut state = test_state(dir.path()).await;
    state.answerer = Some(Arc::new(FixedAnswerer));
    let app = router(state);

    let (status, body) = call(
        &app,
        "POST",
        &format!("{P}/memories"),
        Some(json!({"memories": [fact("refund.window", "refunds within 30 days", "30d", vec![1.0, 0.0])]})),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    let id = body["results"][0]["id"].as_str().unwrap().to_string();

    let (status, body) = call(
        &app,
        "POST",
        &format!("{P}/ask"),
        Some(json!({"question": "what is the refund policy?"})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["answer"], json!("Per memory: refunds within 30 days"));
    assert_eq!(body["sources"], json!([id]));
    assert!(
        !body["memories"].as_array().unwrap().is_empty(),
        "supporting memories are returned for attribution"
    );

    // Nothing recalled → null answer, no LLM call (FixedAnswerer asserts).
    let (status, body) = call(
        &app,
        "POST",
        &format!("{P}/ask"),
        Some(json!({"question": "zzzz qqqq unrelated nonsense"})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["answer"], json!(null));
    assert_eq!(body["sources"], json!([]));

    // Unknown profile: empty answer, never a 404 (reads never create).
    let (status, body) = call(
        &app,
        "POST",
        "/v1/memory/acme/nobody/ask",
        Some(json!({"question": "anything?"})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["answer"], json!(null));
}

#[tokio::test]
async fn ask_without_answerer_is_unavailable() {
    let dir = tempfile::tempdir().unwrap();
    let app = router(test_state(dir.path()).await);
    let (status, _) = call(
        &app,
        "POST",
        &format!("{P}/ask"),
        Some(json!({"question": "anything?"})),
    )
    .await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
}

/// Test embedder: a crude bag-of-words vector so "similar text" actually
/// lands near in cosine space (the real provider is unit-tested in embed.rs).
struct WordEmbedder;

#[async_trait::async_trait]
impl memoturn_api::embed::Embedder for WordEmbedder {
    async fn embed(
        &self,
        texts: &[String],
        _kind: memoturn_api::embed::EmbedKind,
    ) -> Result<Vec<Vec<f32>>, String> {
        Ok(texts
            .iter()
            .map(|t| {
                let t = t.to_lowercase();
                vec![
                    t.contains("dark") as i32 as f32,
                    t.contains("deploy") as i32 as f32,
                    1.0,
                ]
            })
            .collect())
    }
}

#[tokio::test]
async fn auto_embedding_completes_hybrid_recall_for_bare_text() {
    let dir = tempfile::tempdir().unwrap();
    let mut state = test_state(dir.path()).await;
    state.embedder = Some(Arc::new(WordEmbedder));
    let app = router(state);

    // No client embeddings anywhere — the node embeds summaries at ingest.
    let (status, body) = call(
        &app,
        "POST",
        &format!("{P}/memories"),
        Some(json!({"memories": [
            {"type": "fact", "topic_key": "user.theme", "summary": "prefers dark mode",
             "content": {"theme": "dark"}},
            {"type": "event", "summary": "deployed v2 to production", "content": {"v": 2}},
            {"type": "task", "summary": "follow up tomorrow", "content": {}, "session_id": "s-1"},
        ]})),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{body}");

    // …and embeds the bare query at recall: the vector channel lights up.
    let (status, body) = call(
        &app,
        "POST",
        &format!("{P}/recall"),
        Some(json!({"query": "dark", "k": 1})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let hit = &body["memories"][0];
    assert_eq!(hit["summary"], json!("prefers dark mode"), "{body}");
    assert!(
        hit["channels"]
            .as_array()
            .unwrap()
            .contains(&json!("vector")),
        "auto-embedded query must reach the vector channel: {body}"
    );

    // include_turns now works with a bare query too.
    call(
        &app,
        "POST",
        "/v1/db/acme--support-bot/memory/s-1/turns",
        Some(json!({"role": "user", "content": {"text": "x"}, "embedding": [1.0, 0.0, 1.0]})),
    )
    .await;
    let (status, body) = call(
        &app,
        "POST",
        &format!("{P}/recall"),
        Some(json!({"query": "dark", "include_turns": true})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["turns"].as_array().unwrap().len(), 1, "{body}");
}

#[tokio::test]
async fn invalid_inputs_are_rejected() {
    let dir = tempfile::tempdir().unwrap();
    let app = router(test_state(dir.path()).await);

    // Bad names never reach the registry.
    for uri in [
        "/v1/memory/Acme/bot/memories",
        "/v1/memory/acme/has--dashes/memories",
        "/v1/memory/acme/sp%20ace/memories",
    ] {
        let (status, _) = call(
            &app,
            "POST",
            uri,
            Some(json!({"memories": [{"type": "fact", "summary": "x", "content": {}}]})),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{uri}");
    }

    // Unknown type / topic_key on an event / recall without inputs.
    let (status, _) = call(
        &app,
        "POST",
        &format!("{P}/memories"),
        Some(json!({"memories": [{"type": "opinion", "summary": "x", "content": {}}]})),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, _) = call(
        &app,
        "POST",
        &format!("{P}/memories"),
        Some(json!({"memories": [{"type": "event", "topic_key": "k", "summary": "x", "content": {}}]})),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, _) = call(&app, "POST", &format!("{P}/recall"), Some(json!({}))).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn ingest_stores_source_and_recall_filters_by_it() {
    let dir = tempfile::tempdir().unwrap();
    let app = router(test_state(dir.path()).await);
    let (status, body) = call(
        &app,
        "POST",
        &format!("{P}/memories"),
        Some(json!({"memories": [
            {"type": "event", "summary": "refactored the auth module",
             "content": {"n": 1}, "keywords": "auth", "source": "claude-code"},
            {"type": "event", "summary": "reviewed the auth module",
             "content": {"n": 2}, "keywords": "auth", "source": "cursor"},
            {"type": "event", "summary": "deployed the auth module",
             "content": {"n": 3}, "keywords": "auth"},
        ]})),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    let first_id = body["results"][0]["id"].as_str().unwrap().to_string();

    // Unfiltered recall returns every memory's source, including null.
    let (status, body) = call(
        &app,
        "POST",
        &format!("{P}/recall"),
        Some(json!({"query": "auth", "k": 10})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let hits = body["memories"].as_array().unwrap();
    assert_eq!(hits.len(), 3, "{body}");
    let sources: Vec<&Value> = hits.iter().map(|m| &m["source"]).collect();
    assert!(sources.contains(&&json!("claude-code")), "{body}");
    assert!(sources.contains(&&json!("cursor")), "{body}");
    assert!(sources.contains(&&Value::Null), "{body}");

    // Source filter narrows to one agent's memories.
    let (_, body) = call(
        &app,
        "POST",
        &format!("{P}/recall"),
        Some(json!({"query": "auth", "source": "cursor"})),
    )
    .await;
    let hits = body["memories"].as_array().unwrap();
    assert_eq!(hits.len(), 1, "{body}");
    assert_eq!(hits[0]["source"], json!("cursor"));

    // get() carries source too.
    let (status, body) = call(&app, "GET", &format!("{P}/memories/{first_id}"), None).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["source"], json!("claude-code"));
}

#[tokio::test]
async fn duplicate_and_revival_do_not_overwrite_source() {
    // Source is provenance, not identity: it is excluded from the
    // content-addressed id, so the first writer's attribution sticks.
    let dir = tempfile::tempdir().unwrap();
    let app = router(test_state(dir.path()).await);
    let mem = |source: &str| {
        json!({"memories": [{"type": "fact", "topic_key": "user.shell",
            "summary": "uses zsh", "content": {"shell": "zsh"}, "source": source}]})
    };
    let (_, body) = call(
        &app,
        "POST",
        &format!("{P}/memories"),
        Some(mem("claude-code")),
    )
    .await;
    let id = body["results"][0]["id"].as_str().unwrap().to_string();
    assert_eq!(body["results"][0]["status"], json!("created"));

    // Identical content from another agent → duplicate, attribution unchanged.
    let (_, body) = call(&app, "POST", &format!("{P}/memories"), Some(mem("cursor"))).await;
    assert_eq!(body["results"][0]["status"], json!("duplicate"));
    assert_eq!(body["results"][0]["id"].as_str().unwrap(), id);
    let (_, body) = call(&app, "GET", &format!("{P}/memories/{id}"), None).await;
    assert_eq!(body["source"], json!("claude-code"));

    // Supersede, then re-assert from another agent → revived, source still
    // the original writer's (revive clears the tombstone, nothing else).
    call(
        &app,
        "POST",
        &format!("{P}/memories"),
        Some(
            json!({"memories": [{"type": "fact", "topic_key": "user.shell",
            "summary": "uses fish", "content": {"shell": "fish"}, "source": "cursor"}]}),
        ),
    )
    .await;
    let (_, body) = call(&app, "POST", &format!("{P}/memories"), Some(mem("cursor"))).await;
    assert_eq!(body["results"][0]["status"], json!("revived"), "{body}");
    let (_, body) = call(&app, "GET", &format!("{P}/memories/{id}"), None).await;
    assert_eq!(body["source"], json!("claude-code"));
}

#[tokio::test]
async fn supersession_crosses_sources() {
    // Cross-agent sharing is the point: supersession stays profile-wide by
    // (type, topic_key) regardless of which agent wrote either memory.
    let dir = tempfile::tempdir().unwrap();
    let app = router(test_state(dir.path()).await);
    let (_, body) = call(
        &app,
        "POST",
        &format!("{P}/memories"),
        Some(
            json!({"memories": [{"type": "fact", "topic_key": "user.editor",
            "summary": "uses vim", "content": {"editor": "vim"}, "source": "claude-code"}]}),
        ),
    )
    .await;
    let first_id = body["results"][0]["id"].as_str().unwrap().to_string();
    let (_, body) = call(
        &app,
        "POST",
        &format!("{P}/memories"),
        Some(
            json!({"memories": [{"type": "fact", "topic_key": "user.editor",
            "summary": "uses helix", "content": {"editor": "helix"}, "source": "cursor"}]}),
        ),
    )
    .await;
    assert_eq!(
        body["results"][0]["superseded"],
        json!([first_id]),
        "{body}"
    );
    let (_, body) = call(&app, "GET", &format!("{P}/memories/{first_id}"), None).await;
    assert!(!body["superseded_by"].is_null(), "{body}");
}

#[tokio::test]
async fn source_filter_is_not_starved_by_higher_ranked_other_sources() {
    // Same shape as the type-filter regression: many memories from one agent
    // outrank one from another for the same keyword; a source-filtered recall
    // must still find it (filter pushed into the channel SQL).
    let dir = tempfile::tempdir().unwrap();
    let app = router(test_state(dir.path()).await);
    let mut mems: Vec<Value> = (0..60)
        .map(|i| {
            json!({"type": "event", "summary": format!("deploy event {i}"),
            "content": {"n": i}, "keywords": "deploy release", "source": "claude-code"})
        })
        .collect();
    mems.push(json!({"type": "event", "summary": "deploy reviewed",
        "content": {}, "keywords": "deploy", "source": "cursor"}));
    call(
        &app,
        "POST",
        &format!("{P}/memories"),
        Some(json!({"memories": mems})),
    )
    .await;

    let (status, body) = call(
        &app,
        "POST",
        &format!("{P}/recall"),
        Some(json!({"query": "deploy", "source": "cursor", "k": 5})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let hits = body["memories"].as_array().unwrap();
    assert_eq!(hits.len(), 1, "{body}");
    assert_eq!(hits[0]["summary"], json!("deploy reviewed"));
}

/// The pre-`source` schema, as shipped before the column existed. Seeded
/// directly to prove the migrate-on-write/read-tolerance contract against a
/// real old database (a rewound branch can resurrect this schema at any time).
const OLD_DDL: &[&str] = &[
    "CREATE TABLE __memoturn_memories (
       id TEXT NOT NULL UNIQUE,
       type TEXT NOT NULL CHECK (type IN ('fact','event','instruction','task')),
       topic_key TEXT,
       summary TEXT NOT NULL,
       content BLOB NOT NULL,
       keywords TEXT NOT NULL DEFAULT '',
       session_id TEXT,
       created_at INTEGER NOT NULL,
       expires_at INTEGER,
       superseded_by TEXT,
       superseded_at INTEGER
     )",
    "CREATE INDEX __memoturn_memories_active
       ON __memoturn_memories (type, topic_key) WHERE superseded_by IS NULL",
    "CREATE INDEX __memoturn_memories_session
       ON __memoturn_memories (session_id) WHERE session_id IS NOT NULL",
    "CREATE VIRTUAL TABLE __memoturn_memories_fts
       USING fts5(summary, keywords, content=__memoturn_memories, content_rowid=rowid)",
    "CREATE TABLE __memoturn_memory_sessions (
       id TEXT PRIMARY KEY,
       created_at INTEGER NOT NULL,
       last_active_at INTEGER NOT NULL
     ) WITHOUT ROWID",
];

#[tokio::test]
async fn old_schema_db_migrates_on_first_write_and_reads_never_migrate() {
    let dir = tempfile::tempdir().unwrap();
    let state = test_state(dir.path()).await;
    let registry = state.registry.clone();
    let node = state.node.clone();
    let app = router(state);

    // Seed a profile database with the pre-`source` schema and one row.
    let rec = registry.create("acme--support-bot").await.unwrap();
    let file = node.db_file(&rec.uuid, "main");
    let h = node
        .handle(&format!("{}@main", rec.uuid), &file)
        .await
        .unwrap();
    let mut stmts: Vec<(String, Vec<memoturn_engine::Value>)> =
        OLD_DDL.iter().map(|d| (d.to_string(), vec![])).collect();
    stmts.push((
        "INSERT INTO __memoturn_memories
           (id, type, topic_key, summary, content, keywords, session_id, created_at)
         VALUES ('mem_old', 'event', NULL, 'legacy deploy ran', jsonb('{\"n\":0}'), 'deploy', NULL, 1)"
            .to_string(),
        vec![],
    ));
    stmts.push((
        "INSERT INTO __memoturn_memories_fts (rowid, summary, keywords)
         SELECT rowid, summary, keywords FROM __memoturn_memories WHERE id = 'mem_old'"
            .to_string(),
        vec![],
    ));
    h.write_trusted_batch(&stmts).await.unwrap();
    let source_col_missing = || async {
        h.read_trusted("SELECT source FROM __memoturn_memories LIMIT 0", vec![])
            .await
            .is_err()
    };
    assert!(
        source_col_missing().await,
        "seed must lack the source column"
    );

    // Reads work against the old schema and never migrate it.
    let (status, body) = call(
        &app,
        "POST",
        &format!("{P}/recall"),
        Some(json!({"query": "deploy"})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["memories"][0]["summary"], json!("legacy deploy ran"));
    assert_eq!(body["memories"][0]["source"], Value::Null, "{body}");

    // A source-filtered recall on an un-migrated DB is empty, not an error.
    let (status, body) = call(
        &app,
        "POST",
        &format!("{P}/recall"),
        Some(json!({"query": "deploy", "source": "cursor"})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["memories"], json!([]));

    // get() tolerates the old schema too.
    let (status, body) = call(&app, "GET", &format!("{P}/memories/mem_old"), None).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["source"], Value::Null);
    assert!(source_col_missing().await, "reads must not migrate");

    // First write migrates (failed batch → ALTER → retry) and lands the row.
    let (status, body) = call(
        &app,
        "POST",
        &format!("{P}/memories"),
        Some(
            json!({"memories": [{"type": "event", "summary": "deploy reviewed",
            "content": {}, "keywords": "deploy", "source": "cursor"}]}),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    assert!(!source_col_missing().await, "first write must migrate");

    // Both generations now recall together, old row's source null.
    let (_, body) = call(
        &app,
        "POST",
        &format!("{P}/recall"),
        Some(json!({"query": "deploy", "k": 10})),
    )
    .await;
    let hits = body["memories"].as_array().unwrap();
    assert_eq!(hits.len(), 2, "{body}");
    let (_, body) = call(
        &app,
        "POST",
        &format!("{P}/recall"),
        Some(json!({"query": "deploy", "source": "cursor"})),
    )
    .await;
    assert_eq!(body["memories"].as_array().unwrap().len(), 1, "{body}");
}
