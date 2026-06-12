//! Bench smoke checks against the published targets (crates/bench,
//! docs/architecture/09 § bench-target mapping). `#[ignore]`-gated; run:
//!
//! ```sh
//! cargo test -p memoturn-strata --release -- --ignored bench_
//! ```
//!
//! Thresholds are asserted with generous headroom only in release builds —
//! debug builds report numbers without failing.

use memoturn_strata::surface::{docs, kv, memory};
use memoturn_strata::{Db, Durability, MemoryInput, MemoryType, RecallQuery, Store, WriteRequest};
use object_store::memory::InMemory;
use object_store::ObjectStore;
use serde_json::json;
use std::sync::Arc;
use std::time::Instant;

fn p50(samples: &mut [f64]) -> f64 {
    samples.sort_by(|a, b| a.partial_cmp(b).unwrap());
    samples[samples.len() / 2]
}

fn check(name: &str, p50_ms: f64, target_ms: f64) {
    println!("bench {name}: p50 {p50_ms:.3} ms (target < {target_ms} ms)");
    if !cfg!(debug_assertions) {
        assert!(
            p50_ms < target_ms,
            "{name} p50 {p50_ms:.3} ms exceeds target {target_ms} ms"
        );
    }
}

async fn setup(uuid: &str) -> (Arc<Store>, Db, tempfile::TempDir) {
    let dir = tempfile::tempdir().unwrap();
    let object: Arc<dyn ObjectStore> = Arc::new(InMemory::new());
    let store = Store::new(object, "v1", dir.path());
    store.create_db(uuid).await.unwrap();
    let db = store.open(uuid, "main").await.unwrap();
    (store, db, dir)
}

fn embedding(seed: u64, dim: usize) -> Vec<f32> {
    // Deterministic pseudo-random unit-ish vector.
    let mut x = seed.wrapping_mul(0x9E37_79B9_7F4A_7C15).wrapping_add(1);
    (0..dim)
        .map(|_| {
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            ((x % 2000) as f32 / 1000.0) - 1.0
        })
        .collect()
}

fn fact_with_embedding(i: u64) -> MemoryInput {
    MemoryInput {
        mtype: if i.is_multiple_of(3) {
            MemoryType::Fact
        } else {
            MemoryType::Event
        },
        topic_key: i.is_multiple_of(3).then(|| format!("topic.{}", i % 200)),
        summary: format!(
            "memory number {i} about {} and {}",
            ["deploys", "billing", "preferences", "incidents"][(i % 4) as usize],
            ["alpha", "beta", "gamma", "delta", "epsilon"][(i % 5) as usize]
        ),
        content: json!({ "i": i }),
        keywords: Some(format!("k{} k{}", i % 50, i % 7)),
        embedding: Some(embedding(i, 256)),
        session_id: None,
        source: None,
        ttl_secs: None,
    }
}

#[tokio::test]
#[ignore = "bench smoke — run with --release -- --ignored bench_"]
async fn bench_memory_ingest_p50() {
    let (_store, db, _dir) = setup("bench-ingest").await;
    let mut samples = Vec::with_capacity(500);
    for i in 0..500u64 {
        let item = fact_with_embedding(i);
        let t = Instant::now();
        db.submit(WriteRequest::MemIngest(vec![item]), Durability::Standard)
            .await
            .unwrap();
        samples.push(t.elapsed().as_secs_f64() * 1000.0);
    }
    check("memory ingest (1 fact + 256-dim)", p50(&mut samples), 10.0);
}

#[tokio::test]
#[ignore = "bench smoke — run with --release -- --ignored bench_"]
async fn bench_hybrid_recall_at_10k() {
    let (_store, db, _dir) = setup("bench-recall").await;
    // Seed 10k memories with 256-dim embeddings (batched ingest), flushed
    // into segments like a real profile.
    for chunk in 0..10 {
        let items: Vec<MemoryInput> = (chunk * 1000..(chunk + 1) * 1000)
            .map(fact_with_embedding)
            .collect();
        db.submit(WriteRequest::MemIngest(items), Durability::Standard)
            .await
            .unwrap();
        db.flush().await.unwrap();
    }
    let mut samples = Vec::with_capacity(200);
    for i in 0..200u64 {
        let q = RecallQuery {
            query: Some("billing incidents gamma".into()),
            embedding: Some(embedding(31_337 + i, 256)),
            topic_key: Some(format!("topic.{}", i % 200)),
            k: 8,
            ..Default::default()
        };
        let t = Instant::now();
        let hits = db.with_view(|v| memory::recall(v, &q)).await.unwrap();
        samples.push(t.elapsed().as_secs_f64() * 1000.0);
        assert!(!hits.is_empty());
    }
    check("hybrid recall @10k × 256-dim", p50(&mut samples), 25.0);
}

#[tokio::test]
#[ignore = "bench smoke — run with --release -- --ignored bench_"]
async fn bench_kv_read_p50() {
    let (_store, db, _dir) = setup("bench-kv").await;
    for i in 0..100 {
        db.submit(
            WriteRequest::KvPut {
                ns: "bench".into(),
                key: format!("key-{i}"),
                value: vec![0u8; 128],
                ttl_secs: None,
            },
            Durability::Standard,
        )
        .await
        .unwrap();
    }
    let mut samples = Vec::with_capacity(5000);
    for i in 0..5000 {
        let k = format!("key-{}", i % 100);
        let t = Instant::now();
        let v = db.with_view(|v| kv::get(v, "bench", &k).unwrap()).await;
        samples.push(t.elapsed().as_secs_f64() * 1000.0);
        assert!(v.is_some());
    }
    check("hot KV read", p50(&mut samples), 1.0);
}

#[tokio::test]
#[ignore = "bench smoke — run with --release -- --ignored bench_"]
async fn bench_indexed_doc_find_p50() {
    let (_store, db, _dir) = setup("bench-docs").await;
    let docs_json: Vec<serde_json::Value> = (0..1000)
        .map(|i| json!({ "kind": format!("kind-{}", i % 1000), "n": i }))
        .collect();
    db.submit(
        WriteRequest::DocInsert {
            collection: "bench".into(),
            docs: docs_json,
        },
        Durability::Standard,
    )
    .await
    .unwrap();
    db.submit(
        WriteRequest::DocCreateIndex {
            collection: "bench".into(),
            path: "kind".into(),
        },
        Durability::Standard,
    )
    .await
    .unwrap();
    let mut samples = Vec::with_capacity(2000);
    for i in 0..2000 {
        let f = json!({ "kind": format!("kind-{}", i % 1000) });
        let t = Instant::now();
        let hits = db
            .with_view(|v| docs::find(v, "bench", &f, Default::default()))
            .await
            .unwrap();
        samples.push(t.elapsed().as_secs_f64() * 1000.0);
        assert_eq!(hits.len(), 1);
    }
    check("indexed doc find", p50(&mut samples), 1.0);
}

#[tokio::test]
#[ignore = "bench smoke — run with --release -- --ignored bench_"]
async fn bench_fork_p50() {
    let (_store, db, _dir) = setup("bench-fork").await;
    let items: Vec<MemoryInput> = (0..1000).map(fact_with_embedding).collect();
    db.submit(WriteRequest::MemIngest(items), Durability::Standard)
        .await
        .unwrap();
    db.flush().await.unwrap();
    let mut samples = Vec::with_capacity(200);
    for i in 0..200 {
        let t = Instant::now();
        db.fork(&format!("burner-{i}"), None).await.unwrap();
        samples.push(t.elapsed().as_secs_f64() * 1000.0);
    }
    check("branch fork (CoW manifest create)", p50(&mut samples), 50.0);
}
