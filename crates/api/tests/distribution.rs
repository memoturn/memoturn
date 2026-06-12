//! End-to-end with two real HTTP nodes sharing one object store and one
//! lease table: lazy ownership, write forwarding to the owner, failover with
//! epoch bump + state reconciliation from object storage, zombie fencing at
//! the manifest CAS, and replica reads with Memoturn-Min-Txid.

use memoturn_api::AppState;
use memoturn_control::{MemLeaseTable, MemLeases, NodeIdentity};
use memoturn_engine::{LibsqlEngine, NodeConfig, NodeEngine, Registry};
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::Duration;

struct TestNode {
    base: String,
    state: AppState,
    _dir: tempfile::TempDir,
}

/// Spawn a full node: its own data dir + registry, shared store + leases.
async fn spawn_node(
    name: &str,
    store: Arc<object_store::memory::InMemory>,
    leases: MemLeaseTable,
) -> TestNode {
    let dir = tempfile::tempdir().unwrap();
    let engine = Arc::new(LibsqlEngine);
    let node = Arc::new(NodeEngine::new(
        engine.clone(),
        NodeConfig {
            data_dir: dir.path().to_path_buf(),
            hot_cap: 100,
            hot_idle: Duration::from_secs(60),
            ..Default::default()
        },
    ));
    let registry = Arc::new(
        Registry::open(engine.as_ref(), &dir.path().join("registry.db"))
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
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = format!("http://{}", listener.local_addr().unwrap());
    let control = Arc::new(MemLeases::new(
        leases,
        NodeIdentity {
            node_id: name.to_string(),
            addr: addr.clone(),
        },
    ));
    let state = AppState {
        node,
        registry,
        replicator,
        shipper,
        control,
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
    };
    let app = memoturn_api::router(state.clone());
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    TestNode {
        base: addr,
        state,
        _dir: dir,
    }
}

/// Emulate the control-plane catalog: the database exists on every node's
/// registry under the same uuid.
async fn catalog_create(nodes: &[&TestNode], name: &str) -> String {
    let rec = nodes[0].state.registry.create(name).await.unwrap();
    for n in &nodes[1..] {
        n.state
            .registry
            .create_with_uuid(name, &rec.uuid)
            .await
            .unwrap();
    }
    rec.uuid
}

async fn http(
    method: &str,
    url: &str,
    body: Option<Value>,
    headers: &[(&str, String)],
) -> (u16, Value, Option<u64>) {
    let client = reqwest::Client::new();
    let mut req = match method {
        "GET" => client.get(url),
        "POST" => client.post(url),
        "PUT" => client.put(url),
        "DELETE" => client.delete(url),
        _ => unreachable!(),
    };
    if let Some(b) = body {
        req = req.json(&b);
    }
    for (k, v) in headers {
        req = req.header(*k, v);
    }
    let resp = req.send().await.unwrap();
    let status = resp.status().as_u16();
    let txid = resp
        .headers()
        .get("Memoturn-Txid")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.parse().ok());
    let text = resp.text().await.unwrap();
    let json = serde_json::from_str(&text).unwrap_or(Value::String(text));
    (status, json, txid)
}

async fn insert(base: &str, spec: &str, n: i64) -> (u16, Value, Option<u64>) {
    http(
        "POST",
        &format!("{base}/v1/db/{spec}/sql"),
        Some(json!({"stmts": [
            {"q": "CREATE TABLE IF NOT EXISTS t (n INTEGER)"},
            {"q": "INSERT INTO t VALUES (?)", "params": [n]}
        ]})),
        &[],
    )
    .await
}

async fn count_at(base: &str, spec: &str) -> i64 {
    let (status, body, _) = http(
        "POST",
        &format!("{base}/v1/db/{spec}/sql"),
        Some(json!({"stmts": [{"q": "SELECT count(*) FROM t"}]})),
        &[],
    )
    .await;
    assert_eq!(status, 200, "{body}");
    body["results"][0]["rows"][0][0].as_i64().unwrap()
}

#[tokio::test]
async fn lazy_ownership_and_write_forwarding() {
    let store = Arc::new(object_store::memory::InMemory::new());
    let leases = MemLeaseTable::new();
    let a = spawn_node("node-a", store.clone(), leases.clone()).await;
    let b = spawn_node("node-b", store, leases).await;
    let uuid = catalog_create(&[&a, &b], "db1").await;

    // First write lands at A → A lazily acquires ownership at epoch 1.
    let (status, body, txid) = insert(&a.base, "db1", 1).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(txid, Some(1));
    let owner = a
        .state
        .control
        .lookup(&format!("{uuid}@main"))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(owner.node_id, "node-a");
    assert_eq!(owner.epoch, 1);

    // A write sent to B is forwarded to A — single-writer preserved, the
    // relayed response carries A's txid, and A sees both rows.
    let (status, body, txid) = insert(&b.base, "db1", 2).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(txid, Some(2), "forwarded write relays the owner txid");
    assert_eq!(count_at(&a.base, "db1").await, 2);
    // Ownership did not move.
    let owner = b
        .state
        .control
        .lookup(&format!("{uuid}@main"))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(owner.node_id, "node-a");
}

#[tokio::test]
async fn failover_acquires_next_epoch_and_restores_state() {
    let store = Arc::new(object_store::memory::InMemory::new());
    let leases = MemLeaseTable::new();
    let a = spawn_node("node-a", store.clone(), leases.clone()).await;
    let b = spawn_node("node-b", store, leases).await;
    let uuid = catalog_create(&[&a, &b], "db1").await;

    insert(&a.base, "db1", 1).await;
    insert(&a.base, "db1", 2).await;
    let (status, _, _) = http(
        "POST",
        &format!("{}/v1/db/db1/sync", a.base),
        Some(json!({})),
        &[],
    )
    .await;
    assert_eq!(status, 200);

    // Node A dies: its leases evaporate (etcd lease expiry equivalent).
    a.state.control.release_all().await.unwrap();

    // Next write at B: lazy acquisition at epoch 2, local state reconciled
    // from object storage before serving (B never saw this DB before).
    let (status, body, _) = insert(&b.base, "db1", 3).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(count_at(&b.base, "db1").await, 3, "shipped rows + new row");
    let owner = b
        .state
        .control
        .lookup(&format!("{uuid}@main"))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(owner.node_id, "node-b");
    assert_eq!(owner.epoch, 2, "failover bumps the epoch");
}

#[tokio::test]
async fn zombie_writer_is_fenced_at_the_manifest() {
    let store = Arc::new(object_store::memory::InMemory::new());
    let leases = MemLeaseTable::new();
    let a = spawn_node("node-a", store.clone(), leases.clone()).await;
    let b = spawn_node("node-b", store, leases).await;
    let uuid = catalog_create(&[&a, &b], "db1").await;

    insert(&a.base, "db1", 1).await;
    http(
        "POST",
        &format!("{}/v1/db/db1/sync", a.base),
        Some(json!({})),
        &[],
    )
    .await;

    // A is partitioned away; B takes over at epoch 2 and ships.
    a.state.control.release_all().await.unwrap();
    insert(&b.base, "db1", 2).await;
    http(
        "POST",
        &format!("{}/v1/db/db1/sync", b.base),
        Some(json!({})),
        &[],
    )
    .await;

    // Zombie A still has its old handle + epoch 1 and tries to ship directly.
    let file = a.state.node.db_file(&uuid, "main");
    let h = a
        .state
        .node
        .handle(&format!("{uuid}@main"), &file)
        .await
        .unwrap();
    // Make A's copy dirty so shipping is attempted.
    h.write_batch(&[memoturn_engine::Stmt {
        q: "INSERT INTO t VALUES (99)".into(),
        params: vec![],
    }])
    .await
    .unwrap();
    let err = a
        .state
        .replicator
        .ship_snapshot(&h, &uuid, "main", 1)
        .await
        .unwrap_err();
    assert!(
        matches!(
            err,
            memoturn_replication::ReplicationError::ZombieFenced { .. }
        ),
        "zombie ship must be fenced, got: {err}"
    );
    // The new owner's data is intact.
    assert_eq!(count_at(&b.base, "db1").await, 2);
}

#[tokio::test]
async fn memory_ingest_forwards_to_the_profile_owner() {
    let store = Arc::new(object_store::memory::InMemory::new());
    let leases = MemLeaseTable::new();
    let a = spawn_node("node-a", store.clone(), leases.clone()).await;
    let b = spawn_node("node-b", store, leases).await;
    // Profile databases come from the shared catalog in production; emulate
    // it so auto-create is a no-op and both nodes agree on the uuid.
    let uuid = catalog_create(&[&a, &b], "acme--alice").await;

    // First ingest lands at A → A owns the profile.
    let mem = |summary: &str, days: i64| {
        json!({"memories": [{"type": "fact", "topic_key": "refund.window",
            "summary": summary, "content": {"days": days}, "keywords": "refund policy"}]})
    };
    let (status, body, txid) = http(
        "POST",
        &format!("{}/v1/memory/acme/alice/memories", a.base),
        Some(mem("refunds within 30 days", 30)),
        &[],
    )
    .await;
    assert_eq!(status, 201, "{body}");
    let first_txid = txid.unwrap();
    let first_id = body["results"][0]["id"].as_str().unwrap().to_string();
    let owner = a
        .state
        .control
        .lookup(&format!("{uuid}@main"))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(owner.node_id, "node-a");

    // Ingest at B forwards to A: single writer preserved, supersession
    // applied on the owner copy, relayed txid advances.
    let (status, body, txid) = http(
        "POST",
        &format!("{}/v1/memory/acme/alice/memories", b.base),
        Some(mem("refunds within 60 days", 60)),
        &[],
    )
    .await;
    assert_eq!(status, 201, "{body}");
    assert!(
        txid.unwrap() > first_txid,
        "forwarded ingest relays the owner txid"
    );
    assert_eq!(body["results"][0]["superseded"], json!([first_id]));
    let owner = b
        .state
        .control
        .lookup(&format!("{uuid}@main"))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(owner.node_id, "node-a", "ownership did not move");

    // Ship, then recall at B with Min-Txid: the replica refreshes and serves
    // the post-supersession view of the profile.
    http(
        "POST",
        &format!("{}/v1/db/acme--alice/sync", a.base),
        Some(json!({})),
        &[],
    )
    .await;
    let (status, body, _) = http(
        "POST",
        &format!("{}/v1/memory/acme/alice/recall", b.base),
        Some(json!({"topic_key": "refund.window"})),
        &[("Memoturn-Min-Txid", txid.unwrap().to_string())],
    )
    .await;
    assert_eq!(status, 200, "{body}");
    let hits = body["memories"].as_array().unwrap();
    assert_eq!(hits.len(), 1, "{body}");
    assert_eq!(hits[0]["summary"], json!("refunds within 60 days"));
}

#[tokio::test]
async fn replica_read_with_min_txid_refreshes_from_object_storage() {
    let store = Arc::new(object_store::memory::InMemory::new());
    let leases = MemLeaseTable::new();
    let a = spawn_node("node-a", store.clone(), leases.clone()).await;
    let b = spawn_node("node-b", store, leases).await;
    catalog_create(&[&a, &b], "db1").await;

    // Owner A writes and ships v1.
    let url_put = format!("{}/v1/db/db1/kv/s/k", a.base);
    let client = reqwest::Client::new();
    client.put(&url_put).body("v1").send().await.unwrap();
    http(
        "POST",
        &format!("{}/v1/db/db1/sync", a.base),
        Some(json!({})),
        &[],
    )
    .await;

    // B serves the read from its replica copy (cold-waked from object
    // storage) and discloses the txid it served at.
    let (status, body, txid) =
        http("GET", &format!("{}/v1/db/db1/kv/s/k", b.base), None, &[]).await;
    assert_eq!(status, 200);
    assert_eq!(body, Value::String("v1".into()));
    let served_txid = txid.unwrap();

    // Owner writes v2 and ships. B's local copy is now stale.
    let resp = client.put(&url_put).body("v2").send().await.unwrap();
    let new_txid: u64 = resp
        .headers()
        .get("Memoturn-Txid")
        .unwrap()
        .to_str()
        .unwrap()
        .parse()
        .unwrap();
    assert!(new_txid > served_txid);
    http(
        "POST",
        &format!("{}/v1/db/db1/sync", a.base),
        Some(json!({})),
        &[],
    )
    .await;

    // Plain read at B may be stale (eventual consistency contract)…
    let (_, body, _) = http("GET", &format!("{}/v1/db/db1/kv/s/k", b.base), None, &[]).await;
    assert!(body == Value::String("v1".into()) || body == Value::String("v2".into()));

    // …but Min-Txid forces read-your-writes.
    let (status, body, txid) = http(
        "GET",
        &format!("{}/v1/db/db1/kv/s/k", b.base),
        None,
        &[("Memoturn-Min-Txid", new_txid.to_string())],
    )
    .await;
    assert_eq!(status, 200);
    assert_eq!(
        body,
        Value::String("v2".into()),
        "min_txid read must see the write"
    );
    assert!(txid.unwrap() >= new_txid);
}

async fn ingest_fact(base: &str, ns: &str, profile: &str, summary: &str) -> (u16, Value) {
    let (status, body, _) = http(
        "POST",
        &format!("{base}/v1/memory/{ns}/{profile}/memories"),
        Some(json!({"memories": [{
            "type": "fact", "topic_key": "t.k", "summary": summary, "content": {}
        }]})),
        &[],
    )
    .await;
    (status, body)
}

#[tokio::test]
async fn create_db_converges_through_shared_catalog() {
    let store = Arc::new(object_store::memory::InMemory::new());
    let leases = MemLeaseTable::new();
    let a = spawn_node("node-a", store.clone(), leases.clone()).await;
    let b = spawn_node("node-b", store, leases).await;

    let (status, body, _) = http(
        "POST",
        &format!("{}/v1/databases", a.base),
        Some(json!({"name": "shared"})),
        &[],
    )
    .await;
    assert_eq!(status, 201, "{body}");
    let uuid_a = body["uuid"].as_str().unwrap().to_string();

    // A racing create on the other node conflicts instead of minting a
    // divergent uuid — and the loser adopts the canonical record so it can
    // serve the database locally.
    let (status, body, _) = http(
        "POST",
        &format!("{}/v1/databases", b.base),
        Some(json!({"name": "shared"})),
        &[],
    )
    .await;
    assert_eq!(status, 409, "{body}");
    assert_eq!(
        b.state.registry.get("shared").await.unwrap().uuid,
        uuid_a,
        "conflicting create adopts the catalog uuid"
    );
}

#[tokio::test]
async fn deleted_profile_recreates_fresh_instead_of_resurrecting() {
    let store = Arc::new(object_store::memory::InMemory::new());
    let leases = MemLeaseTable::new();
    let a = spawn_node("node-a", store.clone(), leases.clone()).await;
    let b = spawn_node("node-b", store, leases).await;

    // Auto-create via A, then write via B: both registries converge on one uuid.
    let (status, body) = ingest_fact(&a.base, "acme", "alice", "v1 via a").await;
    assert_eq!(status, 201, "{body}");
    let (status, body) = ingest_fact(&b.base, "acme", "alice", "v1 via b").await;
    assert_eq!(status, 201, "{body}");
    let original = a.state.registry.get("acme--alice").await.unwrap().uuid;
    assert_eq!(
        b.state.registry.get("acme--alice").await.unwrap().uuid,
        original,
        "auto-create converged before the delete"
    );

    // Delete on A: catalog mapping dropped, tombstone written. B still holds
    // a stale registry record pointing at the deleted uuid.
    let (status, _, _) = http(
        "DELETE",
        &format!("{}/v1/databases/acme--alice", a.base),
        None,
        &[],
    )
    .await;
    assert_eq!(status, 204);

    // Re-create through B (the node with the stale record): it must drop the
    // stale record and mint a FRESH uuid — not resurrect the deleted one
    // whose object-storage prefix is gone.
    tokio::time::sleep(std::time::Duration::from_millis(5)).await; // cross the tombstone ms
    let (status, body) = ingest_fact(&b.base, "acme", "alice", "v2 via b").await;
    assert_eq!(status, 201, "{body}");
    let recreated = b.state.registry.get("acme--alice").await.unwrap().uuid;
    assert_ne!(recreated, original, "deleted uuid must not be resurrected");

    // And A converges on the recreated uuid through the catalog.
    let (status, body) = ingest_fact(&a.base, "acme", "alice", "v2 via a").await;
    assert_eq!(status, 201, "{body}");
    assert_eq!(
        a.state.registry.get("acme--alice").await.unwrap().uuid,
        recreated
    );

    // The recreated profile contains only post-delete memories.
    let (status, body, _) = http(
        "POST",
        &format!("{}/v1/memory/acme/alice/recall", b.base),
        Some(json!({"topic_key": "t.k", "include_superseded": true})),
        &[],
    )
    .await;
    assert_eq!(status, 200, "{body}");
    let summaries: Vec<&str> = body["memories"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|m| m["summary"].as_str())
        .collect();
    assert!(
        summaries.iter().all(|s| s.starts_with("v2")),
        "pre-delete memories must be gone: {summaries:?}"
    );
}

#[tokio::test]
async fn registry_tombstones_reseed_the_control_plane() {
    let store = Arc::new(object_store::memory::InMemory::new());
    let node = spawn_node("node-a", store, MemLeaseTable::new()).await;

    // A durable tombstone exists in the registry (written by a delete before
    // a restart); the fresh in-process control plane knows nothing.
    node.state
        .registry
        .set_tombstone("acme--alice", 12345)
        .await
        .unwrap();
    assert_eq!(
        node.state.control.deleted_at("acme--alice").await.unwrap(),
        None
    );

    // Boot-time re-seed restores the revocation list, so write tokens minted
    // before the deletion stay revoked across a pod replacement.
    let n = memoturn_api::seed_tombstones(&node.state).await;
    assert_eq!(n, 1);
    assert_eq!(
        node.state.control.deleted_at("acme--alice").await.unwrap(),
        Some(12345)
    );
}
