//! True multi-node integration: the same lazy-ownership / forwarding / failover
//! / fencing guarantees as `distribution.rs`, but coordinated through a *real
//! etcd* (`EtcdLeases`) instead of an in-process lease table — the production
//! path. Gated on `ETCD_ENDPOINTS`, so it skips without etcd:
//!
//!   docker run -d --rm -p 2379:2379 quay.io/coreos/etcd:v3.5.21 \
//!     etcd --listen-client-urls http://0.0.0.0:2379 \
//!          --advertise-client-urls http://0.0.0.0:2379
//!   ETCD_ENDPOINTS=http://127.0.0.1:2379 cargo test -p memoturn-api --test distribution_etcd

use memoturn_api::AppState;
use memoturn_control::{EtcdLeases, NodeIdentity};
use memoturn_engine::{LibsqlEngine, NodeConfig, NodeEngine, Registry};
use serde_json::{json, Value};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

fn endpoints() -> Option<Vec<String>> {
    std::env::var("ETCD_ENDPOINTS")
        .ok()
        .map(|s| s.split(',').map(str::to_string).collect())
}

/// Fresh name per run so etcd keys (epoch/uuid/tombstone) never collide with a
/// previous run or a parallel test — etcd persists across the suite.
fn unique(prefix: &str) -> String {
    static N: AtomicU64 = AtomicU64::new(0);
    let n = N.fetch_add(1, Ordering::Relaxed);
    format!("{prefix}-{}-{n}", std::process::id())
}

struct TestNode {
    base: String,
    state: AppState,
    _dir: tempfile::TempDir,
}

async fn spawn_node(
    name: &str,
    store: Arc<object_store::memory::InMemory>,
    eps: &[String],
) -> TestNode {
    let dir = tempfile::tempdir().unwrap();
    let engine = Arc::new(LibsqlEngine);
    let node = Arc::new(NodeEngine::new(
        engine.clone(),
        NodeConfig {
            data_dir: dir.path().to_path_buf(),
            hot_cap: 100,
            hot_idle: Duration::from_secs(60),
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
    // The fidelity upgrade over distribution.rs: one real etcd lease per node.
    let control = Arc::new(
        EtcdLeases::connect(
            eps,
            NodeIdentity {
                node_id: name.to_string(),
                addr: addr.clone(),
            },
            10,
        )
        .await
        .unwrap(),
    );
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
/// registry under the same uuid (a unique name per run keeps etcd keys fresh).
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

async fn http(method: &str, url: &str, body: Option<Value>) -> (u16, Value, Option<u64>) {
    let client = reqwest::Client::new();
    let mut req = match method {
        "POST" => client.post(url),
        _ => client.get(url),
    };
    if let Some(b) = body {
        req = req.json(&b);
    }
    let resp = req.send().await.unwrap();
    let status = resp.status().as_u16();
    let txid = resp
        .headers()
        .get("Memoturn-Txid")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.parse().ok());
    let text = resp.text().await.unwrap();
    (
        status,
        serde_json::from_str(&text).unwrap_or(Value::String(text)),
        txid,
    )
}

async fn insert(base: &str, spec: &str, n: i64) -> (u16, Value, Option<u64>) {
    http(
        "POST",
        &format!("{base}/v1/db/{spec}/sql"),
        Some(json!({"stmts": [
            {"q": "CREATE TABLE IF NOT EXISTS t (n INTEGER)"},
            {"q": "INSERT INTO t VALUES (?)", "params": [n]}
        ]})),
    )
    .await
}

async fn count_at(base: &str, spec: &str) -> i64 {
    let (status, body, _) = http(
        "POST",
        &format!("{base}/v1/db/{spec}/sql"),
        Some(json!({"stmts": [{"q": "SELECT count(*) FROM t"}]})),
    )
    .await;
    assert_eq!(status, 200, "{body}");
    body["results"][0]["rows"][0][0].as_i64().unwrap()
}

#[tokio::test]
async fn etcd_lazy_ownership_and_write_forwarding() {
    let Some(eps) = endpoints() else {
        eprintln!("skipping: ETCD_ENDPOINTS not set");
        return;
    };
    let store = Arc::new(object_store::memory::InMemory::new());
    let a = spawn_node("node-a", store.clone(), &eps).await;
    let b = spawn_node("node-b", store, &eps).await;
    let name = unique("fwd");
    let uuid = catalog_create(&[&a, &b], &name).await;

    // First write at A → A lazily acquires ownership at epoch 1 *in etcd*.
    let (status, body, txid) = insert(&a.base, &name, 1).await;
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

    // A write sent to B forwards to the etcd-recorded owner (A).
    let (status, body, txid) = insert(&b.base, &name, 2).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(txid, Some(2), "forwarded write relays the owner txid");
    assert_eq!(count_at(&a.base, &name).await, 2);
    let owner = b
        .state
        .control
        .lookup(&format!("{uuid}@main"))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(owner.node_id, "node-a", "ownership did not move");
}

#[tokio::test]
async fn etcd_failover_acquires_next_epoch_and_restores_state() {
    let Some(eps) = endpoints() else {
        eprintln!("skipping: ETCD_ENDPOINTS not set");
        return;
    };
    let store = Arc::new(object_store::memory::InMemory::new());
    let a = spawn_node("node-a", store.clone(), &eps).await;
    let b = spawn_node("node-b", store, &eps).await;
    let name = unique("failover");
    let uuid = catalog_create(&[&a, &b], &name).await;

    insert(&a.base, &name, 1).await;
    insert(&a.base, &name, 2).await;
    let (status, _, _) = http(
        "POST",
        &format!("{}/v1/db/{name}/sync", a.base),
        Some(json!({})),
    )
    .await;
    assert_eq!(status, 200);

    // Node A dies: revoking its etcd lease drops every owner key attached to it.
    a.state.control.release_all().await.unwrap();

    // Next write at B: lazy acquisition at epoch 2 (the epoch counter is a
    // lease-less etcd key that survived), state reconciled from object storage.
    let (status, body, _) = insert(&b.base, &name, 3).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(count_at(&b.base, &name).await, 3, "shipped rows + new row");
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
async fn etcd_zombie_writer_is_fenced_at_the_manifest() {
    let Some(eps) = endpoints() else {
        eprintln!("skipping: ETCD_ENDPOINTS not set");
        return;
    };
    let store = Arc::new(object_store::memory::InMemory::new());
    let a = spawn_node("node-a", store.clone(), &eps).await;
    let b = spawn_node("node-b", store, &eps).await;
    let name = unique("zombie");
    let uuid = catalog_create(&[&a, &b], &name).await;

    insert(&a.base, &name, 1).await;
    http(
        "POST",
        &format!("{}/v1/db/{name}/sync", a.base),
        Some(json!({})),
    )
    .await;

    // A is partitioned away; B takes over at epoch 2 and ships.
    a.state.control.release_all().await.unwrap();
    insert(&b.base, &name, 2).await;
    http(
        "POST",
        &format!("{}/v1/db/{name}/sync", b.base),
        Some(json!({})),
    )
    .await;

    // Zombie A still holds its old handle + epoch 1 and ships directly.
    let file = a.state.node.db_file(&uuid, "main");
    let h = a
        .state
        .node
        .handle(&format!("{uuid}@main"), &file)
        .await
        .unwrap();
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
    assert_eq!(count_at(&b.base, &name).await, 2, "new owner's data intact");
}

#[tokio::test]
async fn etcd_resolve_uuid_converges_across_nodes() {
    let Some(eps) = endpoints() else {
        eprintln!("skipping: ETCD_ENDPOINTS not set");
        return;
    };
    let store = Arc::new(object_store::memory::InMemory::new());
    let a = spawn_node("node-a", store.clone(), &eps).await;
    let b = spawn_node("node-b", store, &eps).await;
    let name = unique("conv--alice");

    // Two nodes race a first-ingest for the same profile through real etcd;
    // both must converge on one uuid (the split-brain fix, ADR-0009).
    let ua = a
        .state
        .control
        .resolve_uuid(&name, "uuid-from-a")
        .await
        .unwrap();
    let ub = b
        .state
        .control
        .resolve_uuid(&name, "uuid-from-b")
        .await
        .unwrap();
    assert_eq!(ua, ub, "both nodes must agree on the canonical uuid");
    assert_eq!(ua, "uuid-from-a", "the CAS winner's proposal sticks");
}
