//! Integration test against a real etcd, gated on ETCD_ENDPOINTS:
//!   docker run -d --rm -p 2379:2379 quay.io/coreos/etcd:v3.5.21 \
//!     etcd --listen-client-urls http://0.0.0.0:2379 --advertise-client-urls http://0.0.0.0:2379
//!   ETCD_ENDPOINTS=http://127.0.0.1:2379 cargo test -p memoturn-control

use memoturn_control::{EtcdLeases, LeaseManager, NodeIdentity, Owner};

fn endpoints() -> Option<Vec<String>> {
    std::env::var("ETCD_ENDPOINTS")
        .ok()
        .map(|s| s.split(',').map(str::to_string).collect())
}

#[tokio::test]
async fn etcd_ownership_lifecycle() {
    let Some(eps) = endpoints() else {
        eprintln!("skipping: ETCD_ENDPOINTS not set");
        return;
    };
    let key = format!("itest-{}", std::process::id());

    let a = EtcdLeases::connect(
        &eps,
        NodeIdentity {
            node_id: "node-a".into(),
            addr: "http://a:8080".into(),
        },
        5,
    )
    .await
    .unwrap();
    let b = EtcdLeases::connect(
        &eps,
        NodeIdentity {
            node_id: "node-b".into(),
            addr: "http://b:8080".into(),
        },
        5,
    )
    .await
    .unwrap();

    // Unowned → A acquires at epoch 1.
    match a.resolve_owner(&key).await.unwrap() {
        Owner::Local { epoch, acquired } => {
            assert!(acquired);
            assert_eq!(epoch, 1);
        }
        other => panic!("expected local ownership, got {other:?}"),
    }
    // B sees A as a remote owner.
    match b.resolve_owner(&key).await.unwrap() {
        Owner::Remote(o) => {
            assert_eq!(o.node_id, "node-a");
            assert_eq!(o.epoch, 1);
            assert_eq!(o.addr, "http://a:8080");
        }
        other => panic!("expected remote owner, got {other:?}"),
    }
    // A re-resolves as existing owner (no double-acquire).
    match a.resolve_owner(&key).await.unwrap() {
        Owner::Local { epoch, acquired } => {
            assert!(!acquired);
            assert_eq!(epoch, 1);
        }
        other => panic!("expected local, got {other:?}"),
    }

    // A dies (lease revoked) → its owner keys evaporate atomically.
    a.release_all().await.unwrap();
    assert!(
        b.lookup(&key).await.unwrap().is_none(),
        "lease revocation frees the key"
    );

    // B acquires at epoch 2 — epochs survive ownership loss.
    match b.resolve_owner(&key).await.unwrap() {
        Owner::Local { epoch, acquired } => {
            assert!(acquired);
            assert_eq!(epoch, 2, "epoch counter must outlive the lease");
        }
        other => panic!("expected local ownership, got {other:?}"),
    }
    b.release(&key).await.unwrap();
}

#[tokio::test]
async fn etcd_resolve_uuid_and_tombstone() {
    let Some(eps) = endpoints() else {
        eprintln!("skipping: ETCD_ENDPOINTS not set");
        return;
    };
    let id = |s: &str| NodeIdentity {
        node_id: s.into(),
        addr: format!("http://{s}:8080"),
    };
    let a = EtcdLeases::connect(&eps, id("node-a"), 5).await.unwrap();
    let b = EtcdLeases::connect(&eps, id("node-b"), 5).await.unwrap();
    // Unique key per run — etcd persists across the suite.
    let key = format!("uuidtomb-{}", std::process::id());

    // Two nodes race resolve_uuid for the same db → both converge on one uuid.
    let ua = a.resolve_uuid(&key, "uuid-a").await.unwrap();
    let ub = b.resolve_uuid(&key, "uuid-b").await.unwrap();
    assert_eq!(ua, ub, "CAS-create makes both nodes agree");
    assert_eq!(ua, "uuid-a", "the first writer wins");

    // Tombstone is monotonic and visible from the other node.
    assert_eq!(a.deleted_at(&key).await.unwrap(), None);
    a.tombstone(&key, 1000).await.unwrap();
    assert_eq!(b.deleted_at(&key).await.unwrap(), Some(1000));
    b.tombstone(&key, 500).await.unwrap(); // older — must not weaken it
    assert_eq!(a.deleted_at(&key).await.unwrap(), Some(1000));
    a.tombstone(&key, 2000).await.unwrap();
    assert_eq!(b.deleted_at(&key).await.unwrap(), Some(2000));
}
