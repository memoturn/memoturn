//! Concurrency soak: real racing submitters on the group-commit queue and a
//! mid-stream ownership takeover. The deterministic protocol tests live in
//! `engine.rs`; these shake out interleavings the deterministic tests can't.

use memoturn_strata::surface::{kv, memory};
use memoturn_strata::{
    Durability, MemoryInput, MemoryType, RecallQuery, Store, StrataError, WriteRequest,
};
use object_store::memory::InMemory;
use object_store::ObjectStore;
use serde_json::json;
use std::sync::Arc;

fn mem_store() -> (Arc<Store>, tempfile::TempDir) {
    let dir = tempfile::tempdir().unwrap();
    let object: Arc<dyn ObjectStore> = Arc::new(InMemory::new());
    (Store::new(object, "v1", dir.path()), dir)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn racing_submitters_all_commit_with_monotone_txids() {
    let (store, _dir) = mem_store();
    store.create_db("soak1").await.unwrap();
    let db = store.open("soak1", "main").await.unwrap();

    const TASKS: usize = 16;
    const WRITES: usize = 25;
    let mut handles = Vec::new();
    for t in 0..TASKS {
        let db = db.clone();
        handles.push(tokio::spawn(async move {
            let mut txids = Vec::with_capacity(WRITES);
            for i in 0..WRITES {
                let (_, txid) = db
                    .submit(
                        WriteRequest::KvPut {
                            ns: "race".into(),
                            key: format!("t{t}-i{i}"),
                            value: format!("{t}:{i}").into_bytes(),
                            ttl_secs: None,
                        },
                        Durability::Standard,
                    )
                    .await
                    .expect("racing write must succeed");
                txids.push(txid);
            }
            txids
        }));
    }
    let mut max_txid = 0u64;
    for h in handles {
        let txids = h.await.unwrap();
        assert!(
            txids.windows(2).all(|w| w[0] < w[1]),
            "a task's own writes see strictly increasing txids"
        );
        max_txid = max_txid.max(*txids.last().unwrap());
    }
    // Every write is present and correct.
    let total = TASKS * WRITES;
    let listed = db
        .with_view(|v| kv::list(v, "race", "", total as u32 + 10).unwrap())
        .await;
    assert_eq!(listed.len(), total);
    for t in 0..TASKS {
        for i in 0..WRITES {
            let v = db
                .with_view(|v| kv::get(v, "race", &format!("t{t}-i{i}")).unwrap())
                .await;
            assert_eq!(v, Some(format!("{t}:{i}").into_bytes()));
        }
    }
    // Group commit means the head advanced at most once per write — and if
    // any rounds coalesced, strictly fewer times.
    assert!(
        max_txid <= total as u64 + 1,
        "head {max_txid} vs {total} writes"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn racing_topic_writers_leave_one_active_head() {
    let (store, _dir) = mem_store();
    store.create_db("soak2").await.unwrap();
    let db = store.open("soak2", "main").await.unwrap();

    let mut handles = Vec::new();
    for t in 0..8 {
        let db = db.clone();
        handles.push(tokio::spawn(async move {
            for i in 0..10 {
                db.submit(
                    WriteRequest::MemIngest(vec![MemoryInput {
                        mtype: MemoryType::Fact,
                        topic_key: Some("contended.topic".into()),
                        summary: format!("value from task {t} iteration {i}"),
                        content: json!({ "t": t, "i": i }),
                        keywords: None,
                        embedding: None,
                        session_id: None,
                        source: None,
                        ttl_secs: None,
                    }]),
                    Durability::Standard,
                )
                .await
                .expect("contended ingest must succeed");
            }
        }));
    }
    for h in handles {
        h.await.unwrap();
    }
    // Exactly one active row on the topic; the rest form a consistent chain.
    let active = db
        .with_view(|v| {
            memory::recall(
                v,
                &RecallQuery {
                    topic_key: Some("contended.topic".into()),
                    k: 1000,
                    ..Default::default()
                },
            )
            .unwrap()
        })
        .await;
    assert_eq!(active.len(), 1, "single active head after the storm");
    let all = db
        .with_view(|v| {
            memory::recall(
                v,
                &RecallQuery {
                    topic_key: Some("contended.topic".into()),
                    include_superseded: true,
                    k: 1000,
                    ..Default::default()
                },
            )
            .unwrap()
        })
        .await;
    assert_eq!(all.len(), 80, "every distinct fact is in the chain");
    let superseded = all.iter().filter(|m| !m["superseded_by"].is_null()).count();
    assert_eq!(superseded, 79, "all but the head are superseded");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn takeover_mid_stream_never_loses_a_durable_ack() {
    let (store, _dir) = mem_store();
    store.create_db("soak3").await.unwrap();
    let db1 = store.open("soak3", "main").await.unwrap();

    // Writer A streams durable writes until it gets fenced.
    let writer = {
        let db1 = db1.clone();
        tokio::spawn(async move {
            let mut acked: Vec<u64> = Vec::new();
            for i in 0..10_000u64 {
                match db1
                    .submit(
                        WriteRequest::KvPut {
                            ns: "d".into(),
                            key: format!("k{i}"),
                            value: i.to_le_bytes().to_vec(),
                            ttl_secs: None,
                        },
                        Durability::Durable,
                    )
                    .await
                {
                    Ok(_) => acked.push(i),
                    Err(StrataError::ZombieFenced { .. }) => break,
                    Err(e) => panic!("unexpected error: {e}"),
                }
            }
            acked
        })
    };

    // Let A make progress, then take over mid-stream.
    tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    let db2 = store.open("soak3", "main").await.unwrap();

    // A must observe the fence within a couple more writes.
    let acked = writer.await.unwrap();
    assert!(!acked.is_empty(), "writer A made progress before takeover");
    assert!(acked.len() < 10_000, "writer A was fenced");

    // EVERY durably-acked write is visible to the new owner — including any
    // chunk that landed between db2's list and its fence create (the
    // fence-loop replay path).
    for i in &acked {
        let v = db2
            .with_view(|v| kv::get(v, "d", &format!("k{i}")).unwrap())
            .await;
        assert_eq!(
            v,
            Some(i.to_le_bytes().to_vec()),
            "durably-acked k{i} lost across takeover"
        );
    }
}
