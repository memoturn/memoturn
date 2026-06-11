//! End-to-end for the replica push stream across two real HTTP nodes: lazy
//! subscription on first replica read, live segment pushes keeping the
//! replica fresh without object-storage polling, snapshot pushes across
//! compaction, and the owner-side ingest guard.

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

async fn kv_put(base: &str, key: &str, value: &str) -> u64 {
    let resp = reqwest::Client::new()
        .put(format!("{base}/v1/db/db1/kv/s/{key}"))
        .body(value.to_string())
        .send()
        .await
        .unwrap();
    assert!(resp.status().is_success());
    resp.headers()["Memoturn-Txid"]
        .to_str()
        .unwrap()
        .parse()
        .unwrap()
}

async fn kv_get(base: &str, key: &str) -> (String, u64) {
    let resp = reqwest::Client::new()
        .get(format!("{base}/v1/db/db1/kv/s/{key}"))
        .send()
        .await
        .unwrap();
    assert!(resp.status().is_success(), "{}", resp.status());
    let txid = resp.headers()["Memoturn-Txid"]
        .to_str()
        .unwrap()
        .parse()
        .unwrap();
    (resp.text().await.unwrap(), txid)
}

async fn sync(base: &str) {
    let resp = reqwest::Client::new()
        .post(format!("{base}/v1/db/db1/sync"))
        .send()
        .await
        .unwrap();
    assert!(resp.status().is_success());
}

/// Wait for the replica to observe at least `txid` without forcing a
/// refresh; panics if the push never lands.
async fn await_replica_txid(base: &str, key: &str, txid: u64) -> String {
    for _ in 0..60 {
        let (v, t) = kv_get(base, key).await;
        if t >= txid {
            return v;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("replica never reached txid {txid} via push");
}

#[tokio::test]
async fn pushed_segments_keep_replica_fresh_without_object_store_polling() {
    let store = Arc::new(object_store::memory::InMemory::new());
    let leases = MemLeaseTable::new();
    let a = spawn_node("node-a", store.clone(), leases.clone()).await;
    let b = spawn_node("node-b", store, leases).await;
    let uuid = catalog_create(&[&a, &b], "db1").await;

    // Owner A writes + ships the base snapshot.
    kv_put(&a.base, "k", "v1").await;
    sync(&a.base).await;

    // B's first read cold-wakes from object storage and subscribes to A.
    let (v, _) = kv_get(&b.base, "k").await;
    assert_eq!(v, "v1");
    tokio::time::sleep(Duration::from_millis(100)).await; // subscription lands

    // A writes v2 and ships a segment → pushed live to B. B serves the new
    // value on a PLAIN read (no Min-Txid header, no restore forced).
    let t2 = kv_put(&a.base, "k", "v2").await;
    sync(&a.base).await;
    let v = await_replica_txid(&b.base, "k", t2).await;
    assert_eq!(v, "v2", "segment push reached the replica");

    // And again — steady-state streaming, multiple keys.
    kv_put(&a.base, "other", "x").await;
    let t3 = kv_put(&a.base, "k", "v3").await;
    sync(&a.base).await;
    let v = await_replica_txid(&b.base, "k", t3).await;
    assert_eq!(v, "v3");
    let (v, _) = kv_get(&b.base, "other").await;
    assert_eq!(v, "x");

    // The replica copy is a faithful image, not a patchwork.
    let file = b.state.node.db_file(&uuid, "main");
    let h = b
        .state
        .node
        .handle(&format!("{uuid}@main"), &file)
        .await
        .unwrap();
    let r = h.read("PRAGMA integrity_check", vec![]).await.unwrap();
    assert_eq!(r.rows[0][0], Value::String("ok".into()));
}

#[tokio::test]
async fn snapshot_pushes_survive_compaction() {
    let store = Arc::new(object_store::memory::InMemory::new());
    let leases = MemLeaseTable::new();
    let a = spawn_node("node-a", store.clone(), leases.clone()).await;
    let b = spawn_node("node-b", store, leases).await;
    let uuid = catalog_create(&[&a, &b], "db1").await;

    kv_put(&a.base, "n", "0").await;
    sync(&a.base).await;
    let (v, _) = kv_get(&b.base, "n").await; // subscribe
    assert_eq!(v, "0");
    tokio::time::sleep(Duration::from_millis(100)).await;

    // Push >16 shipped writes so at least one compaction snapshot is pushed
    // among the segments.
    let mut last = 0;
    for i in 1..=20 {
        last = kv_put(&a.base, "n", &i.to_string()).await;
        sync(&a.base).await;
    }
    let m = a
        .state
        .replicator
        .load_manifest(&uuid, "main")
        .await
        .unwrap()
        .unwrap();
    assert!(
        m.snapshots.len() >= 2,
        "compaction happened: {}",
        m.snapshots.len()
    );

    let v = await_replica_txid(&b.base, "n", last).await;
    assert_eq!(
        v, "20",
        "replica converged across segment AND snapshot pushes"
    );
}

#[tokio::test]
async fn owner_refuses_ingest() {
    let store = Arc::new(object_store::memory::InMemory::new());
    let leases = MemLeaseTable::new();
    let a = spawn_node("node-a", store.clone(), leases.clone()).await;
    let b = spawn_node("node-b", store, leases).await;
    let uuid = catalog_create(&[&a, &b], "db1").await;

    kv_put(&a.base, "k", "v1").await; // A owns db1@main
    let resp = reqwest::Client::new()
        .post(format!("{}/internal/replica/ingest", a.base))
        .header("Memoturn-Db-Uuid", uuid)
        .header("Memoturn-Branch", "main")
        .header("Memoturn-Kind", "snapshot")
        .body(vec![0u8; 16])
        .send()
        .await
        .unwrap();
    assert_eq!(
        resp.status().as_u16(),
        409,
        "a stale push must never clobber the owner"
    );
}
