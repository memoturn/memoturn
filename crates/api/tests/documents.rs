//! End-to-end: document collections (insert/find/update/delete with the
//! Mongo-style operator subset), expression indexes, vector search (DiskANN),
//! memory primitives, and the headline property — documents/vectors/memory
//! all fork and rewind with the database as one unit.

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

async fn seed(app: &axum::Router) {
    call(app, "POST", "/v1/databases", Some(json!({"name": "a"}))).await;
    let (status, body) = call(
        app,
        "POST",
        "/v1/db/a/docs/memories/insert",
        Some(json!({"docs": [
            {"kind": "fact", "text": "prefers dark mode", "score": 0.9},
            {"kind": "fact", "text": "lives in Lisbon", "score": 0.5},
            {"kind": "task", "text": "book flight", "score": 0.7, "tags": ["travel"]},
        ]})),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
}

#[tokio::test]
async fn docs_insert_find_with_operators() {
    let dir = tempfile::tempdir().unwrap();
    let app = router(test_state(dir.path()).await);
    seed(&app).await;

    // equality
    let (_, body) = call(
        &app,
        "POST",
        "/v1/db/a/docs/memories/find",
        Some(json!({"filter": {"kind": "fact"}})),
    )
    .await;
    assert_eq!(body["docs"].as_array().unwrap().len(), 2);

    // $gt + sort desc + limit
    let (_, body) = call(
        &app,
        "POST",
        "/v1/db/a/docs/memories/find",
        Some(json!({"filter": {"score": {"$gt": 0.6}}, "sort": {"score": -1}, "limit": 10})),
    )
    .await;
    let docs = body["docs"].as_array().unwrap();
    assert_eq!(docs.len(), 2);
    assert_eq!(docs[0]["text"], json!("prefers dark mode"));

    // $in and $or
    let (_, body) = call(
        &app,
        "POST",
        "/v1/db/a/docs/memories/find",
        Some(json!({"filter": {"$or": [
            {"kind": {"$in": ["task"]}},
            {"score": {"$gte": 0.9}}
        ]}})),
    )
    .await;
    assert_eq!(body["docs"].as_array().unwrap().len(), 2);

    // $exists on a field only some docs have
    let (_, body) = call(
        &app,
        "POST",
        "/v1/db/a/docs/memories/find",
        Some(json!({"filter": {"tags": {"$exists": true}}})),
    )
    .await;
    assert_eq!(body["docs"].as_array().unwrap().len(), 1);

    // unknown collection → empty, not an error
    let (status, body) = call(
        &app,
        "POST",
        "/v1/db/a/docs/nothing/find",
        Some(json!({"filter": {}})),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["docs"], json!([]));
}

#[tokio::test]
async fn docs_update_and_delete() {
    let dir = tempfile::tempdir().unwrap();
    let app = router(test_state(dir.path()).await);
    seed(&app).await;

    // $set + $inc
    let (status, body) = call(
        &app,
        "POST",
        "/v1/db/a/docs/memories/update",
        Some(json!({
            "filter": {"text": "prefers dark mode"},
            "update": {"$set": {"confirmed": true}, "$inc": {"hits": 1}}
        })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["modified"], json!(1));

    let (_, body) = call(
        &app,
        "POST",
        "/v1/db/a/docs/memories/find",
        Some(json!({"filter": {"confirmed": true}})),
    )
    .await;
    let doc = &body["docs"][0];
    assert_eq!(doc["hits"], json!(1));
    assert_eq!(doc["confirmed"], json!(true));

    // $push appends to an array
    call(
        &app,
        "POST",
        "/v1/db/a/docs/memories/update",
        Some(json!({
            "filter": {"kind": "task"},
            "update": {"$push": {"tags": "urgent"}}
        })),
    )
    .await;
    let (_, body) = call(
        &app,
        "POST",
        "/v1/db/a/docs/memories/find",
        Some(json!({"filter": {"kind": "task"}})),
    )
    .await;
    assert_eq!(body["docs"][0]["tags"], json!(["travel", "urgent"]));

    // delete multi
    let (_, body) = call(
        &app,
        "POST",
        "/v1/db/a/docs/memories/delete",
        Some(json!({"filter": {"kind": "fact"}, "multi": true})),
    )
    .await;
    assert_eq!(body["deleted"], json!(2));
}

#[tokio::test]
async fn docs_expression_index() {
    let dir = tempfile::tempdir().unwrap();
    let app = router(test_state(dir.path()).await);
    seed(&app).await;

    let (status, _) = call(
        &app,
        "POST",
        "/v1/db/a/docs/memories/indexes",
        Some(json!({"path": "score"})),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);

    // Index is used (EXPLAIN through the SQL escape hatch is blocked on
    // reserved tables, so assert behavior: queries still correct).
    let (_, body) = call(
        &app,
        "POST",
        "/v1/db/a/docs/memories/find",
        Some(json!({"filter": {"score": {"$lt": 0.6}}})),
    )
    .await;
    assert_eq!(body["docs"].as_array().unwrap().len(), 1);
}

#[tokio::test]
async fn vector_upsert_and_ann_search() {
    let dir = tempfile::tempdir().unwrap();
    let app = router(test_state(dir.path()).await);
    call(&app, "POST", "/v1/databases", Some(json!({"name": "a"}))).await;

    for (id, e) in [
        ("dark-mode", [1.0, 0.0, 0.0]),
        ("lisbon", [0.0, 1.0, 0.0]),
        ("flight", [0.0, 0.0, 1.0]),
    ] {
        let (status, body) = call(
            &app,
            "POST",
            "/v1/db/a/vectors/memories",
            Some(json!({"id": id, "embedding": e})),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
    }

    let (status, body) = call(
        &app,
        "POST",
        "/v1/db/a/vectors/memories/search",
        Some(json!({"vector": [0.9, 0.1, 0.0], "k": 2})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let hits = body["hits"].as_array().unwrap();
    assert_eq!(hits.len(), 2);
    assert_eq!(hits[0]["id"], json!("dark-mode"), "nearest neighbor first");
}

#[tokio::test]
async fn memory_turns_window_and_semantic_search() {
    let dir = tempfile::tempdir().unwrap();
    let app = router(test_state(dir.path()).await);
    call(&app, "POST", "/v1/databases", Some(json!({"name": "a"}))).await;

    for (role, text, emb) in [
        ("user", "I prefer aisle seats", Some([1.0_f32, 0.0, 0.0])),
        ("assistant", "Noted!", None),
        ("user", "Book me a flight to Lisbon", Some([0.0, 1.0, 0.0])),
    ] {
        let mut body = json!({"role": role, "content": {"text": text}});
        if let Some(e) = emb {
            body["embedding"] = json!(e);
        }
        let (status, b) = call(&app, "POST", "/v1/db/a/memory/s1/turns", Some(body)).await;
        assert_eq!(status, StatusCode::CREATED, "{b}");
    }

    // Window: ordered, last N.
    let (_, body) = call(&app, "GET", "/v1/db/a/memory/s1/turns?last=2", None).await;
    let turns = body["turns"].as_array().unwrap();
    assert_eq!(turns.len(), 2);
    assert_eq!(turns[0]["role"], json!("assistant"));
    assert_eq!(
        turns[1]["content"]["text"],
        json!("Book me a flight to Lisbon")
    );

    // Semantic: query near the seat-preference embedding.
    let (_, body) = call(
        &app,
        "POST",
        "/v1/db/a/memory/s1/search",
        Some(json!({"vector": [0.95, 0.05, 0.0], "k": 1})),
    )
    .await;
    let turns = body["turns"].as_array().unwrap();
    assert_eq!(turns.len(), 1);
    assert_eq!(turns[0]["content"]["text"], json!("I prefer aisle seats"));

    // Sessions are isolated.
    let (_, body) = call(&app, "GET", "/v1/db/a/memory/other/turns", None).await;
    assert_eq!(body["turns"], json!([]));
}

#[tokio::test]
async fn whole_database_forks_and_rewinds_as_one_unit() {
    let dir = tempfile::tempdir().unwrap();
    let app = router(test_state(dir.path()).await);
    call(&app, "POST", "/v1/databases", Some(json!({"name": "a"}))).await;

    // Mixed state: a doc, a vector, a memory turn.
    call(
        &app,
        "POST",
        "/v1/db/a/docs/memories/insert",
        Some(json!({"docs": [{"kind": "fact", "text": "v1"}]})),
    )
    .await;
    call(
        &app,
        "POST",
        "/v1/db/a/vectors/memories",
        Some(json!({"id": "m1", "embedding": [1.0, 0.0]})),
    )
    .await;
    call(
        &app,
        "POST",
        "/v1/db/a/memory/s1/turns",
        Some(json!({"role": "user", "content": {"text": "hello"}})),
    )
    .await;

    // Checkpoint, then mutate everything.
    let (status, _) = call(
        &app,
        "POST",
        "/v1/db/a/branches/main/checkpoint",
        Some(json!({"name": "cp"})),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    call(
        &app,
        "POST",
        "/v1/db/a/docs/memories/insert",
        Some(json!({"docs": [{"kind": "fact", "text": "v2"}]})),
    )
    .await;
    call(
        &app,
        "POST",
        "/v1/db/a/memory/s1/turns",
        Some(json!({"role": "assistant", "content": {"text": "world"}})),
    )
    .await;

    // Fork captures post-checkpoint state; rewinding main restores everything.
    let (status, _) = call(
        &app,
        "POST",
        "/v1/db/a/branches",
        Some(json!({"name": "exp"})),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);

    let (status, body) = call(
        &app,
        "POST",
        "/v1/db/a/branches/main/rewind",
        Some(json!({"to": "cp"})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");

    let (_, body) = call(
        &app,
        "POST",
        "/v1/db/a/docs/memories/find",
        Some(json!({"filter": {}})),
    )
    .await;
    assert_eq!(
        body["docs"].as_array().unwrap().len(),
        1,
        "doc v2 rewound away"
    );
    let (_, body) = call(&app, "GET", "/v1/db/a/memory/s1/turns", None).await;
    assert_eq!(
        body["turns"].as_array().unwrap().len(),
        1,
        "turn rewound away"
    );

    // The fork still has the later state (documents + turns).
    let (_, body) = call(
        &app,
        "POST",
        "/v1/db/a@exp/docs/memories/find",
        Some(json!({"filter": {}})),
    )
    .await;
    assert_eq!(body["docs"].as_array().unwrap().len(), 2, "fork keeps v2");
    let (_, body) = call(&app, "GET", "/v1/db/a@exp/memory/s1/turns", None).await;
    assert_eq!(body["turns"].as_array().unwrap().len(), 2);
    // And the vector survives in both.
    let (_, body) = call(
        &app,
        "POST",
        "/v1/db/a@exp/vectors/memories/search",
        Some(json!({"vector": [1.0, 0.0], "k": 1})),
    )
    .await;
    assert_eq!(body["hits"][0]["id"], json!("m1"));
}
