//! Benchmark harness producing the success-criteria table
//! (docs/architecture/05). Exercises the same crates the API serves, on
//! local NVMe + an in-process object store, so numbers reflect engine cost
//! without network noise.
//!
//! Usage: `cargo run -p memoturn-bench --release [-- --dbs 100000]`

use memoturn_engine::{LibsqlEngine, NodeConfig, NodeEngine, Registry, Stmt};
use memoturn_replication::Replicator;
use serde_json::json;
use std::sync::Arc;
use std::time::{Duration, Instant};

struct Series(Vec<Duration>);

impl Series {
    fn pct(&self, p: f64) -> Duration {
        let mut v = self.0.clone();
        v.sort();
        v[((v.len() as f64 - 1.0) * p) as usize]
    }
}

async fn timed<F, Fut, T>(n: usize, mut f: F) -> (Series, Vec<T>)
where
    F: FnMut(usize) -> Fut,
    Fut: std::future::Future<Output = T>,
{
    let mut samples = Vec::with_capacity(n);
    let mut outs = Vec::with_capacity(n);
    for i in 0..n {
        let start = Instant::now();
        outs.push(f(i).await);
        samples.push(start.elapsed());
    }
    (Series(samples), outs)
}

fn row(name: &str, target: &str, s: &Series, pass: bool) {
    println!(
        "| {:<34} | {:>9} | {:>10.2?} | {:>10.2?} | {:>4} |",
        name,
        target,
        s.pct(0.5),
        s.pct(0.99),
        if pass { "PASS" } else { "FAIL" }
    );
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let args: Vec<String> = std::env::args().collect();
    let cold_dbs: usize = args
        .iter()
        .position(|a| a == "--dbs")
        .and_then(|i| args.get(i + 1))
        .and_then(|s| s.parse().ok())
        .unwrap_or(10_000);

    let dir = tempfile::tempdir()?;
    let engine = Arc::new(LibsqlEngine);
    let node = Arc::new(NodeEngine::new(
        engine.clone(),
        NodeConfig {
            data_dir: dir.path().to_path_buf(),
            hot_cap: 1000,
            hot_idle: Duration::from_secs(300),
        },
    ));
    let registry =
        Arc::new(Registry::open(engine.as_ref(), &dir.path().join("registry.db")).await?);
    let store = Arc::new(object_store::memory::InMemory::new());
    let replicator = Arc::new(Replicator::new(store, "v1"));

    println!("\nMemoturn prototype benchmarks (single node, in-process)\n");
    println!(
        "| {:<34} | {:>9} | {:>10} | {:>10} | {:>4} |",
        "metric", "target", "p50", "p99", ""
    );
    println!(
        "|{:-<36}|{:-<11}|{:-<12}|{:-<12}|{:-<6}|",
        "", "", "", "", ""
    );

    // 1. Provision (metadata-only)
    let (s, _) = timed(500, |i| {
        let r = registry.clone();
        async move { r.create(&format!("agent-{i}")).await.unwrap() }
    })
    .await;
    row(
        "provision database",
        "<100ms",
        &s,
        s.pct(0.5) < Duration::from_millis(100),
    );

    // Open one hot DB for the hot-path benchmarks.
    let rec = registry.get("agent-0").await.unwrap();
    let file = node.db_file(&rec.uuid, "main");
    let h = node.handle(&format!("{}@main", rec.uuid), &file).await?;
    h.write_batch(&[Stmt {
        q: "CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)".into(),
        params: vec![],
    }])
    .await?;

    // 2. Hot SQL write
    let (s, _) = timed(1000, |i| {
        let h = h.clone();
        async move {
            h.write_batch(&[Stmt {
                q: "INSERT INTO t (v) VALUES (?)".into(),
                params: vec![json!(format!("value-{i}"))],
            }])
            .await
            .unwrap()
        }
    })
    .await;
    row(
        "hot SQL write",
        "<5ms",
        &s,
        s.pct(0.5) < Duration::from_millis(5),
    );

    // 3. Hot KV write + read
    memoturn_kv::put(&h, "ns", "warm", b"x".to_vec(), None).await?;
    let (s, _) = timed(2000, |i| {
        let h = h.clone();
        async move {
            memoturn_kv::put(&h, "ns", &format!("k{}", i % 100), b"v".to_vec(), None)
                .await
                .unwrap()
        }
    })
    .await;
    row(
        "hot KV write",
        "<5ms",
        &s,
        s.pct(0.5) < Duration::from_millis(5),
    );
    let (s, _) = timed(5000, |i| {
        let h = h.clone();
        async move {
            memoturn_kv::get(&h, "ns", &format!("k{}", i % 100))
                .await
                .unwrap()
        }
    })
    .await;
    row(
        "hot KV read",
        "<1ms",
        &s,
        s.pct(0.5) < Duration::from_millis(1),
    );

    // 4. Document insert + indexed find
    let (s, _) = timed(1000, |i| {
        let h = h.clone();
        async move {
            memoturn_docstore::insert(
                &h,
                "memories",
                vec![json!({"kind": "fact", "n": i, "text": "bench"})],
            )
            .await
            .unwrap()
        }
    })
    .await;
    row(
        "hot doc insert",
        "<5ms",
        &s,
        s.pct(0.5) < Duration::from_millis(5),
    );
    memoturn_docstore::create_index(&h, "memories", "n").await?;
    let (s, _) = timed(2000, |i| {
        let h = h.clone();
        async move {
            memoturn_docstore::find(&h, "memories", &json!({"n": i % 1000}), Default::default())
                .await
                .unwrap()
        }
    })
    .await;
    row(
        "indexed doc find",
        "<1ms",
        &s,
        s.pct(0.5) < Duration::from_millis(1),
    );

    // 5. Incremental segment ship: one write → WAL capture → encode → PUT.
    replicator.ship_snapshot(&h, &rec.uuid, "main", 1).await?; // base
    let (s, _) = timed(200, |i| {
        let h = h.clone();
        let r = replicator.clone();
        let uuid = rec.uuid.clone();
        async move {
            h.write_batch(&[Stmt {
                q: "INSERT INTO t (v) VALUES (?)".into(),
                params: vec![json!(format!("seg-{i}"))],
            }])
            .await
            .unwrap();
            r.ship(&h, &uuid, "main", 1).await.unwrap()
        }
    })
    .await;
    row(
        "segment ship (write+capture+put)",
        "<10ms",
        &s,
        s.pct(0.5) < Duration::from_millis(10),
    );

    // 6. Branch create (CoW after parent shipped)
    replicator.ship(&h, &rec.uuid, "main", 1).await?;
    let (s, _) = timed(200, |i| {
        let r = replicator.clone();
        let uuid = rec.uuid.clone();
        async move { r.fork(&uuid, "main", &format!("b{i}"), None).await.unwrap() }
    })
    .await;
    row(
        "branch create (CoW)",
        "<50ms",
        &s,
        s.pct(0.5) < Duration::from_millis(50),
    );

    // 6. Cold wake: ship, drop all local state, restore + open.
    let (s, _) = timed(100, |i| {
        let node = node.clone();
        let r = replicator.clone();
        let uuid = rec.uuid.clone();
        let file = file.clone();
        async move {
            let key = format!("{uuid}@main");
            node.evict(&key).await;
            let dir = file.parent().unwrap().to_path_buf();
            let _ = tokio::fs::remove_dir_all(&dir).await;
            r.restore(&uuid, "main", None, &file).await.unwrap();
            let h = node.handle(&key, &file).await.unwrap();
            let _ = h.read("SELECT count(*) FROM t", vec![]).await.unwrap();
            i
        }
    })
    .await;
    row(
        "cold wake (restore+open+query)",
        "<200ms",
        &s,
        s.pct(0.5) < Duration::from_millis(200),
    );

    // 7. Agent memory (the headline): typed ingest + hybrid recall on a
    // profile seeded with `mem_count` memories carrying 256-dim embeddings.
    use memoturn_docstore::memories::{self, MemoryInput, MemoryType, RecallQuery};
    let mem_count: usize = args
        .iter()
        .position(|a| a == "--memories")
        .and_then(|i| args.get(i + 1))
        .and_then(|s| s.parse().ok())
        .unwrap_or(10_000);
    let dim = 256usize;
    // Deterministic pseudo-embeddings (LCG) — workload shape, not semantics.
    let emb = move |seed: usize| -> Vec<f32> {
        let mut x = (seed as u64).wrapping_mul(2654435761).wrapping_add(1);
        (0..dim)
            .map(|_| {
                x = x
                    .wrapping_mul(6364136223846793005)
                    .wrapping_add(1442695040888963407);
                ((x >> 33) as f32 / (1u64 << 32) as f32) - 0.5
            })
            .collect()
    };
    let words = [
        "refund", "seat", "deploy", "invoice", "theme", "flight", "ticket", "billing", "release",
        "policy",
    ];
    let mrec = registry.create("memory-profile").await?;
    let mfile = node.db_file(&mrec.uuid, "main");
    let mh = node.handle(&format!("{}@main", mrec.uuid), &mfile).await?;
    let seed_start = Instant::now();
    for batch in 0..(mem_count / 100) {
        let items: Vec<MemoryInput> = (0..100)
            .map(|j| {
                let i = batch * 100 + j;
                MemoryInput {
                    mtype: MemoryType::Event,
                    topic_key: None,
                    summary: format!("{} update number {i}", words[i % words.len()]),
                    content: json!({"n": i}),
                    keywords: Some(format!(
                        "{} {}",
                        words[i % words.len()],
                        words[(i / 10) % words.len()]
                    )),
                    embedding: Some(emb(i)),
                    session_id: None,
                    source: None,
                    ttl_secs: None,
                }
            })
            .collect();
        memories::ingest(&mh, items).await?;
    }
    let seeded = seed_start.elapsed();

    // Typed ingest: one fact with an embedding, superseding by topic key.
    let (s, _) = timed(500, |i| {
        let mh = mh.clone();
        let summary = format!("{} preference v{i}", words[i % words.len()]);
        let embedding = emb(mem_count + i);
        async move {
            memories::ingest(
                &mh,
                vec![MemoryInput {
                    mtype: MemoryType::Fact,
                    topic_key: Some(format!("user.topic-{}", i % 50)),
                    summary,
                    content: json!({"v": i}),
                    keywords: Some("preference".into()),
                    embedding: Some(embedding),
                    session_id: None,
                    source: None,
                    ttl_secs: None,
                }],
            )
            .await
            .unwrap()
        }
    })
    .await;
    row(
        "memory ingest (fact, 256-dim)",
        "<10ms",
        &s,
        s.pct(0.5) < Duration::from_millis(10),
    );

    // Hybrid recall: FTS + topic + vector ANN, RRF-fused, over the full profile.
    let recall_name = format!("hybrid recall @{}k memories", mem_count / 1000);
    let (s, _) = timed(500, |i| {
        let mh = mh.clone();
        let query = format!("{} policy update", words[i % words.len()]);
        let embedding = emb(i * 7 + 3);
        async move {
            memories::recall(
                &mh,
                &RecallQuery {
                    query: Some(query),
                    embedding: Some(embedding),
                    topic_key: Some(format!("user.topic-{}", i % 50)),
                    types: None,
                    session_id: None,
                    source: None,
                    k: 8,
                    include_superseded: false,
                },
            )
            .await
            .unwrap()
        }
    })
    .await;
    row(
        &recall_name,
        "<25ms",
        &s,
        s.pct(0.5) < Duration::from_millis(25),
    );
    println!(
        "  ({} memories seeded in {seeded:.2?}; recall = FTS5 + topic + DiskANN, rank-fused)",
        mem_count
    );

    // 8. Cold-density probe: N cold DBs provisioned, random subset touched.
    let start = Instant::now();
    for i in 0..cold_dbs {
        registry.create(&format!("cold-{i}")).await?;
    }
    let provision_all = start.elapsed();
    let (s, _) = timed(200, |i| {
        let node = node.clone();
        let registry = registry.clone();
        async move {
            let rec = registry
                .get(&format!("cold-{}", (i * 37) % 9973))
                .await
                .unwrap();
            let file = node.db_file(&rec.uuid, "main");
            let h = node
                .handle(&format!("{}@main", rec.uuid), &file)
                .await
                .unwrap();
            memoturn_kv::put(&h, "s", "k", b"v".to_vec(), None)
                .await
                .unwrap()
        }
    })
    .await;
    row(
        "first-touch of cold DB",
        "<100ms",
        &s,
        s.pct(0.5) < Duration::from_millis(100),
    );
    println!(
        "\n{cold_dbs} cold databases provisioned in {provision_all:.2?} \
         ({:.0}/s); hot pool held at {} handles.\n",
        cold_dbs as f64 / provision_all.as_secs_f64(),
        node.hot_count(),
    );
    Ok(())
}
