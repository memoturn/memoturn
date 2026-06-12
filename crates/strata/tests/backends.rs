//! Object-store backend coverage beyond `InMemory`: the local filesystem
//! backend (the repo's default posture for dev nodes), and an env-gated
//! S3-compatible run for MinIO/S3 (the production posture).
//!
//! S3 run:
//! ```sh
//! MEMOTURN_TEST_S3=http://127.0.0.1:9000 MEMOTURN_TEST_S3_BUCKET=strata-test \
//! AWS_ACCESS_KEY_ID=minioadmin AWS_SECRET_ACCESS_KEY=minioadmin \
//! cargo test -p memoturn-strata --test backends -- --ignored s3_
//! ```

use memoturn_strata::surface::{kv, memory};
use memoturn_strata::{Durability, MemoryInput, MemoryType, RecallQuery, Store, WriteRequest};
use object_store::ObjectStore;
use serde_json::json;
use std::sync::Arc;

/// The full protocol pass every backend must survive: provision → open →
/// durable write → flush → takeover (fence) → zombie durable write rejected
/// → replica converges → erasure flow leaves a clean listing.
async fn protocol_pass(object: Arc<dyn ObjectStore>, data_dir: &std::path::Path) {
    let store = Store::new(object, "v1", data_dir);
    store.create_db("bk1").await.unwrap();
    let db1 = store.open("bk1", "main").await.unwrap();

    db1.submit(
        WriteRequest::MemIngest(vec![MemoryInput {
            mtype: MemoryType::Fact,
            topic_key: Some("user.theme".into()),
            summary: "prefers dark mode".into(),
            content: json!({"v": "dark"}),
            keywords: None,
            embedding: None,
            session_id: None,
            source: None,
            ttl_secs: None,
        }]),
        Durability::Durable,
    )
    .await
    .unwrap();
    db1.flush().await.unwrap();
    db1.submit(
        WriteRequest::KvPut {
            ns: "n".into(),
            key: "tail".into(),
            value: b"wal-tail".to_vec(),
            ttl_secs: None,
        },
        Durability::Durable,
    )
    .await
    .unwrap();

    // Takeover fences the first writer.
    let db2 = store.open("bk1", "main").await.unwrap();
    let err = db1
        .submit(
            WriteRequest::KvPut {
                ns: "n".into(),
                key: "zombie".into(),
                value: b"no".to_vec(),
                ttl_secs: None,
            },
            Durability::Durable,
        )
        .await;
    assert!(err.is_err(), "zombie durable write must not ack");

    // The new owner sees segment state and the wal tail.
    let hits = db2
        .with_view(|v| {
            memory::recall(
                v,
                &RecallQuery {
                    topic_key: Some("user.theme".into()),
                    k: 4,
                    ..Default::default()
                },
            )
            .unwrap()
        })
        .await;
    assert_eq!(hits.len(), 1);
    let tail = db2.with_view(|v| kv::get(v, "n", "tail").unwrap()).await;
    assert_eq!(tail, Some(b"wal-tail".to_vec()));

    // Replica converges from object storage alone.
    let replica = store.replica("bk1", "main").await.unwrap();
    let tail = replica.with_view(|v| kv::get(v, "n", "tail").unwrap());
    assert_eq!(tail, Some(b"wal-tail".to_vec()));

    // Erasure: forget, rewrite history, GC, prove absence by listing.
    let id = hits[0]["id"].as_str().unwrap().to_string();
    let (_, forget_txid) = db2
        .submit(WriteRequest::MemForget { id }, Durability::Standard)
        .await
        .unwrap();
    db2.erase_below(forget_txid).await.unwrap();
    tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    store.gc("bk1", std::time::Duration::ZERO).await.unwrap();
    let ev = store
        .verify_erased_before("bk1", forget_txid)
        .await
        .unwrap();
    assert!(ev.clean, "{ev:?}");

    store.delete_db("bk1").await.unwrap();
}

#[tokio::test]
async fn local_filesystem_backend_passes_the_protocol() {
    let obj_dir = tempfile::tempdir().unwrap();
    let data_dir = tempfile::tempdir().unwrap();
    let object: Arc<dyn ObjectStore> =
        Arc::new(object_store::local::LocalFileSystem::new_with_prefix(obj_dir.path()).unwrap());
    protocol_pass(object, data_dir.path()).await;
}

#[tokio::test]
#[ignore = "needs MEMOTURN_TEST_S3 (+bucket/creds) pointing at MinIO or S3"]
async fn s3_backend_passes_the_protocol() {
    let endpoint = std::env::var("MEMOTURN_TEST_S3").expect("MEMOTURN_TEST_S3 endpoint");
    let bucket =
        std::env::var("MEMOTURN_TEST_S3_BUCKET").unwrap_or_else(|_| "strata-test".to_string());
    let object: Arc<dyn ObjectStore> = Arc::new(
        object_store::aws::AmazonS3Builder::from_env()
            .with_endpoint(&endpoint)
            .with_bucket_name(&bucket)
            .with_allow_http(true)
            // MinIO-style path addressing.
            .with_virtual_hosted_style_request(false)
            .with_region("us-east-1")
            .build()
            .unwrap(),
    );
    let data_dir = tempfile::tempdir().unwrap();
    protocol_pass(object, data_dir.path()).await;
}
