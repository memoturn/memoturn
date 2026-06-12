//! End-to-end semantics of the strata engine: the memory state machine,
//! group-commit atomicity, branching/rewind, fencing, erasure, and the
//! docs/KV/transcript surfaces — the use cases the prototype must prove
//! (docs/architecture/09 § prototype scope).

use memoturn_strata::surface::{docs, kv, memory, transcript};
use memoturn_strata::{
    Db, Durability, MemoryInput, MemoryType, RecallQuery, Store, WriteOutput, WriteRequest,
};
use object_store::memory::InMemory;
use object_store::ObjectStore;
use serde_json::{json, Value as Json};
use std::sync::Arc;

fn mem_store() -> (Arc<Store>, tempfile::TempDir) {
    let dir = tempfile::tempdir().unwrap();
    let object: Arc<dyn ObjectStore> = Arc::new(InMemory::new());
    (Store::new(object, "v1", dir.path()), dir)
}

async fn open_db(store: &Arc<Store>, uuid: &str) -> Db {
    store.create_db(uuid).await.unwrap();
    store.open(uuid, "main").await.unwrap()
}

fn fact(topic: &str, summary: &str, content: Json) -> MemoryInput {
    MemoryInput {
        mtype: MemoryType::Fact,
        topic_key: Some(topic.to_string()),
        summary: summary.to_string(),
        content,
        keywords: None,
        embedding: None,
        session_id: None,
        source: None,
        ttl_secs: None,
    }
}

fn event(summary: &str, content: Json) -> MemoryInput {
    MemoryInput {
        mtype: MemoryType::Event,
        topic_key: None,
        summary: summary.to_string(),
        content,
        keywords: None,
        embedding: None,
        session_id: None,
        source: None,
        ttl_secs: None,
    }
}

async fn ingest(db: &Db, items: Vec<MemoryInput>) -> (Vec<memory::IngestOutcome>, u64) {
    let (out, txid) = db
        .submit(WriteRequest::MemIngest(items), Durability::Standard)
        .await
        .unwrap();
    match out {
        WriteOutput::MemIngest(outcomes) => (outcomes, txid),
        other => panic!("unexpected output {other:?}"),
    }
}

async fn recall(db: &Db, q: RecallQuery) -> Vec<Json> {
    db.with_view(|v| memory::recall(v, &q)).await.unwrap()
}

fn keyword_query(text: &str, k: u32) -> RecallQuery {
    RecallQuery {
        query: Some(text.to_string()),
        k,
        ..Default::default()
    }
}

// ---- memory state machine ----

#[tokio::test]
async fn supersede_revive_duplicate_state_machine() {
    let (store, _dir) = mem_store();
    let db = open_db(&store, "u1").await;

    let (o1, _) = ingest(
        &db,
        vec![fact("user.diet", "vegetarian", json!({"v": "veg"}))],
    )
    .await;
    assert_eq!(o1[0].status, "created");
    assert!(o1[0].superseded.is_empty());
    let veg_id = o1[0].id.clone();

    // New fact on the topic supersedes the old one.
    let (o2, _) = ingest(
        &db,
        vec![fact("user.diet", "omnivore now", json!({"v": "omni"}))],
    )
    .await;
    assert_eq!(o2[0].status, "created");
    assert_eq!(o2[0].superseded, vec![veg_id.clone()]);
    let omni_id = o2[0].id.clone();

    // Recall sees only the active fact…
    let hits = recall(
        &db,
        RecallQuery {
            topic_key: Some("user.diet".into()),
            k: 8,
            ..Default::default()
        },
    )
    .await;
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0]["id"], json!(omni_id));
    // …and the chain is visible with include_superseded.
    let all = recall(
        &db,
        RecallQuery {
            topic_key: Some("user.diet".into()),
            k: 8,
            include_superseded: true,
            ..Default::default()
        },
    )
    .await;
    assert_eq!(all.len(), 2);

    // Re-ingesting the active fact is a duplicate.
    let (o3, _) = ingest(
        &db,
        vec![fact("user.diet", "omnivore now", json!({"v": "omni"}))],
    )
    .await;
    assert_eq!(o3[0].status, "duplicate");

    // Re-asserting the superseded fact revives it and supersedes the usurper.
    let (o4, _) = ingest(
        &db,
        vec![fact("user.diet", "vegetarian", json!({"v": "veg"}))],
    )
    .await;
    assert_eq!(o4[0].status, "revived");
    assert_eq!(o4[0].superseded, vec![omni_id.clone()]);

    let got = db
        .with_view(|v| memory::get(v, &veg_id))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(got["superseded_by"], Json::Null);
    assert_eq!(got["supersedes"], json!([omni_id]));
}

#[tokio::test]
async fn source_provenance_first_writer_sticks() {
    let (store, _dir) = mem_store();
    let db = open_db(&store, "u2").await;
    let mut a = fact("user.editor", "vim", json!({"v": "vim"}));
    a.source = Some("claude-code".into());
    let (o1, _) = ingest(&db, vec![a]).await;
    let id = o1[0].id.clone();

    // Same memory from another agent dedupes; attribution is unchanged.
    let mut b = fact("user.editor", "vim", json!({"v": "vim"}));
    b.source = Some("cursor".into());
    let (o2, _) = ingest(&db, vec![b]).await;
    assert_eq!(o2[0].status, "duplicate");
    let got = db
        .with_view(|v| memory::get(v, &id))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(got["source"], json!("claude-code"));

    // Source-filtered recall sees only that agent's memories.
    let hits = recall(
        &db,
        RecallQuery {
            query: Some("vim".into()),
            source: Some("cursor".into()),
            k: 8,
            ..Default::default()
        },
    )
    .await;
    assert!(hits.is_empty());
}

#[tokio::test]
async fn intra_batch_supersession_and_atomicity() {
    let (store, _dir) = mem_store();
    let db = open_db(&store, "u3").await;
    // Two facts on one topic in one atomic batch: the second supersedes the
    // first; one txid for the whole batch.
    let (outs, txid) = ingest(
        &db,
        vec![
            fact("plan.tier", "free tier", json!({"tier": "free"})),
            fact("plan.tier", "pro tier", json!({"tier": "pro"})),
        ],
    )
    .await;
    assert_eq!(outs[0].status, "created");
    assert_eq!(outs[1].status, "created");
    assert_eq!(outs[1].superseded, vec![outs[0].id.clone()]);
    assert!(txid > 0);

    let hits = recall(
        &db,
        RecallQuery {
            topic_key: Some("plan.tier".into()),
            k: 8,
            ..Default::default()
        },
    )
    .await;
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0]["content"], json!({"tier": "pro"}));

    // An invalid item fails the whole batch (per-batch atomicity)…
    let bad = MemoryInput {
        ttl_secs: Some(60), // ttl on a fact: invalid
        ..fact("x.y", "bad", json!({}))
    };
    let err = db
        .submit(
            WriteRequest::MemIngest(vec![event("fine", json!({})), bad]),
            Durability::Standard,
        )
        .await;
    assert!(err.is_err());
    // …and nothing from it landed.
    assert!(recall(&db, keyword_query("fine", 8)).await.is_empty());
}

#[tokio::test]
async fn round_shares_txid_and_isolates_failing_requests() {
    let (store, _dir) = mem_store();
    let db = open_db(&store, "u4").await;
    // Three requests in one driven round: two valid KV puts and one invalid
    // doc insert. The failure fails alone; neighbors share one txid.
    let results = db
        .submit_many(vec![
            WriteRequest::KvPut {
                ns: "ns".into(),
                key: "a".into(),
                value: b"1".to_vec(),
                ttl_secs: None,
            },
            WriteRequest::DocInsert {
                collection: "bad name!".into(), // invalid collection
                docs: vec![json!({"x": 1})],
            },
            WriteRequest::KvPut {
                ns: "ns".into(),
                key: "b".into(),
                value: b"2".to_vec(),
                ttl_secs: None,
            },
        ])
        .await;
    let t1 = results[0].as_ref().unwrap().1;
    assert!(results[1].is_err(), "invalid request fails alone");
    let t3 = results[2].as_ref().unwrap().1;
    assert_eq!(t1, t3, "round participants share the txid");

    let (a, b) = db
        .with_view(|v| {
            (
                kv::get(v, "ns", "a").unwrap(),
                kv::get(v, "ns", "b").unwrap(),
            )
        })
        .await;
    assert_eq!(a, Some(b"1".to_vec()));
    assert_eq!(b, Some(b"2".to_vec()));
}

// ---- recall channels ----

#[tokio::test]
async fn channel_filter_pushdown_is_not_starved() {
    let (store, _dir) = mem_store();
    let db = open_db(&store, "u5").await;
    // 60 events all matching the keyword, then 2 tasks matching it too. An
    // unfiltered top-fetch would be all events; a types=[task] recall must
    // still surface the tasks (the `channel_filter` scenario).
    let mut items: Vec<MemoryInput> = (0..60)
        .map(|i| event(&format!("deploy pipeline run {i}"), json!({ "i": i })))
        .collect();
    for i in 0..2 {
        items.push(MemoryInput {
            mtype: MemoryType::Task,
            topic_key: None,
            summary: format!("deploy pipeline follow-up {i}"),
            content: json!({ "i": i }),
            keywords: None,
            embedding: None,
            session_id: Some("s1".into()),
            source: None,
            ttl_secs: Some(3600),
        });
    }
    ingest(&db, items).await;

    let hits = recall(
        &db,
        RecallQuery {
            query: Some("deploy pipeline".into()),
            types: Some(vec![MemoryType::Task]),
            k: 8,
            ..Default::default()
        },
    )
    .await;
    assert_eq!(hits.len(), 2, "filtered rows must not be starved: {hits:?}");
    assert!(hits.iter().all(|h| h["type"] == json!("task")));

    // Explicit empty type list matches nothing (ported semantics).
    let none = recall(
        &db,
        RecallQuery {
            query: Some("deploy".into()),
            types: Some(vec![]),
            k: 8,
            ..Default::default()
        },
    )
    .await;
    assert!(none.is_empty());
}

#[tokio::test]
async fn hybrid_recall_fuses_topic_keyword_vector() {
    let (store, _dir) = mem_store();
    let db = open_db(&store, "u6").await;
    let mut theme = fact(
        "user.theme",
        "prefers dark mode in the editor",
        json!({"v": "dark"}),
    );
    theme.keywords = Some("theme ui".into());
    theme.embedding = Some(vec![1.0, 0.0, 0.0, 0.0]);
    let mut lang = fact("user.lang", "writes mostly rust", json!({"v": "rust"}));
    lang.embedding = Some(vec![0.0, 1.0, 0.0, 0.0]);
    ingest(&db, vec![theme, lang]).await;

    let hits = recall(
        &db,
        RecallQuery {
            query: Some("what theme does the user like?".into()),
            embedding: Some(vec![0.9, 0.1, 0.0, 0.0]),
            topic_key: Some("user.theme".into()),
            k: 4,
            ..Default::default()
        },
    )
    .await;
    assert_eq!(hits[0]["content"], json!({"v": "dark"}));
    let chans = hits[0]["channels"].as_array().unwrap();
    assert!(chans.contains(&json!("topic")), "{chans:?}");
    assert!(chans.contains(&json!("keyword")));
    assert!(chans.contains(&json!("vector")));

    // Mismatched query dimension degrades the vector channel, not the call.
    let degraded = recall(
        &db,
        RecallQuery {
            query: Some("rust".into()),
            embedding: Some(vec![1.0, 0.0]),
            k: 4,
            ..Default::default()
        },
    )
    .await;
    assert_eq!(degraded.len(), 1);
    assert!(!degraded[0]["channels"]
        .as_array()
        .unwrap()
        .contains(&json!("vector")));

    // Empty is a valid answer — recall never pads.
    assert!(recall(&db, keyword_query("zebra xylophone", 8))
        .await
        .is_empty());
}

// ---- branching / rewind / fencing ----

#[tokio::test]
async fn fork_isolates_all_channels_and_rewind_hits_any_txid() {
    let (store, _dir) = mem_store();
    let db = open_db(&store, "u7").await;
    let mut base = fact("pricing.plan", "monthly 10 dollars", json!({"usd": 10}));
    base.embedding = Some(vec![1.0, 0.0]);
    ingest(&db, vec![base]).await;
    let checkpoint_txid = db.checkpoint("before-experiment").await.unwrap();

    // Burner-branch the profile, supersede the fact there.
    db.fork("what-if", Some(crate_now_plus(3600)))
        .await
        .unwrap();
    let branch = store.open("u7", "what-if").await.unwrap();
    let mut newprice = fact("pricing.plan", "monthly 20 dollars", json!({"usd": 20}));
    newprice.embedding = Some(vec![0.0, 1.0]);
    ingest(&branch, vec![newprice]).await;

    let on_branch = recall(
        &branch,
        RecallQuery {
            topic_key: Some("pricing.plan".into()),
            k: 4,
            ..Default::default()
        },
    )
    .await;
    assert_eq!(on_branch[0]["content"], json!({"usd": 20}));

    // Main is untouched — topic, keyword, and vector channels all isolated.
    let on_main = recall(
        &db,
        RecallQuery {
            query: Some("monthly".into()),
            embedding: Some(vec![0.0, 1.0]),
            topic_key: Some("pricing.plan".into()),
            k: 4,
            ..Default::default()
        },
    )
    .await;
    assert_eq!(on_main.len(), 1);
    assert_eq!(on_main[0]["content"], json!({"usd": 10}));

    // Rewind main to an arbitrary txid (not a flush boundary): write twice
    // more, rewind to between them.
    let (_, t1) = ingest(&db, vec![event("step one", json!({"n": 1}))]).await;
    ingest(&db, vec![event("step two", json!({"n": 2}))]).await;
    db.rewind(&t1.to_string()).await.unwrap();
    assert_eq!(recall(&db, keyword_query("step", 8)).await.len(), 1);

    // And rewind by checkpoint name.
    db.rewind("before-experiment").await.unwrap();
    assert!(recall(&db, keyword_query("step", 8)).await.is_empty());
    assert_eq!(db.head().await, checkpoint_txid);
}

fn crate_now_plus(secs: i64) -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
        + secs * 1000
}

#[tokio::test]
async fn takeover_fences_the_old_writer_and_keeps_durable_acks() {
    let (store, _dir) = mem_store();
    let db1 = open_db(&store, "u8").await;
    // A durably-acked write must survive any failover.
    db1.submit(
        WriteRequest::KvPut {
            ns: "ns".into(),
            key: "durable".into(),
            value: b"yes".to_vec(),
            ttl_secs: None,
        },
        Durability::Durable,
    )
    .await
    .unwrap();

    // New owner takes over (epoch bump + wal replay + fence chunk).
    let db2 = store.open("u8", "main").await.unwrap();
    let v = db2
        .with_view(|v| kv::get(v, "ns", "durable").unwrap())
        .await;
    assert_eq!(v, Some(b"yes".to_vec()), "durable ack survived takeover");

    // The zombie's next durable write fails before it acks.
    let err = db1
        .submit(
            WriteRequest::KvPut {
                ns: "ns".into(),
                key: "zombie".into(),
                value: b"no".to_vec(),
                ttl_secs: None,
            },
            Durability::Durable,
        )
        .await;
    assert!(err.is_err(), "zombie durable write must not ack");
    let v = db2.with_view(|v| kv::get(v, "ns", "zombie").unwrap()).await;
    assert!(v.is_none());
}

#[tokio::test]
async fn crash_recovery_replays_local_log_and_rpo_is_the_ship_window() {
    let dir = tempfile::tempdir().unwrap();
    let object: Arc<dyn ObjectStore> = Arc::new(InMemory::new());
    let store = Store::new(object, "v1", dir.path());
    let db = open_db(&store, "u9").await;
    db.submit(
        WriteRequest::KvPut {
            ns: "n".into(),
            key: "shipped".into(),
            value: b"1".to_vec(),
            ttl_secs: None,
        },
        Durability::Standard,
    )
    .await
    .unwrap();
    db.ship().await.unwrap();
    db.submit(
        WriteRequest::KvPut {
            ns: "n".into(),
            key: "local-only".into(),
            value: b"2".to_vec(),
            ttl_secs: None,
        },
        Durability::Standard,
    )
    .await
    .unwrap();
    drop(db);

    // Same-node restart: the local log replays — nothing lost.
    let db = store.open("u9", "main").await.unwrap();
    let (a, b) = db
        .with_view(|v| {
            (
                kv::get(v, "n", "shipped").unwrap(),
                kv::get(v, "n", "local-only").unwrap(),
            )
        })
        .await;
    assert_eq!(a, Some(b"1".to_vec()));
    assert_eq!(b, Some(b"2".to_vec()));
    db.submit(
        WriteRequest::KvPut {
            ns: "n".into(),
            key: "again-local".into(),
            value: b"3".to_vec(),
            ttl_secs: None,
        },
        Durability::Standard,
    )
    .await
    .unwrap();
    drop(db);

    // Node loss (local log gone): state converges to object storage — the
    // documented Standard-mode RPO. "local-only" survives because takeover
    // shipped it inside the fence chunk (upgraded to object-durable);
    // "again-local" was written after that open and never shipped: lost
    // within the RPO window.
    std::fs::remove_file(dir.path().join("u9").join("main.log")).unwrap();
    let db = store.open("u9", "main").await.unwrap();
    let (a, b, c) = db
        .with_view(|v| {
            (
                kv::get(v, "n", "shipped").unwrap(),
                kv::get(v, "n", "local-only").unwrap(),
                kv::get(v, "n", "again-local").unwrap(),
            )
        })
        .await;
    assert_eq!(a, Some(b"1".to_vec()), "shipped write survives node loss");
    assert_eq!(
        b,
        Some(b"2".to_vec()),
        "fence chunk upgraded the local tail"
    );
    assert_eq!(c, None, "post-takeover unshipped write lost within RPO");
}

#[tokio::test]
async fn replica_reads_from_manifest_plus_wal_tail() {
    let (store, _dir) = mem_store();
    let db = open_db(&store, "u10").await;
    ingest(&db, vec![fact("user.theme", "dark", json!({"v": "dark"}))]).await;
    db.flush().await.unwrap(); // → segment
    ingest(&db, vec![event("logged in", json!({}))]).await;
    db.ship().await.unwrap(); // → wal tail only

    let replica = store.replica("u10", "main").await.unwrap();
    assert_eq!(replica.head(), db.head().await);
    let hits = replica.with_view(|v| {
        memory::recall(
            v,
            &RecallQuery {
                query: Some("logged".into()),
                k: 4,
                ..Default::default()
            },
        )
        .unwrap()
    });
    assert_eq!(hits.len(), 1, "wal-tail writes visible on the replica");
    let hits = replica.with_view(|v| {
        memory::recall(
            v,
            &RecallQuery {
                topic_key: Some("user.theme".into()),
                k: 4,
                ..Default::default()
            },
        )
        .unwrap()
    });
    assert_eq!(hits.len(), 1, "segment state visible on the replica");
}

// ---- erasure ----

#[tokio::test]
async fn erasure_rewrites_history_and_proves_absence() {
    let (store, _dir) = mem_store();
    let db = open_db(&store, "u11").await;
    let mut secret = fact(
        "user.ssn",
        "social security number",
        json!({"ssn": "123-45-6789"}),
    );
    secret.embedding = Some(vec![0.5, 0.5]);
    secret.keywords = Some("pii".into());
    let (o, _) = ingest(&db, vec![secret]).await;
    let secret_id = o[0].id.clone();
    ingest(&db, vec![event("unrelated activity", json!({"k": 1}))]).await;
    db.flush().await.unwrap();

    // Forget (hard delete), then rewrite history below the forget txid.
    let (out, forget_txid) = db
        .submit(
            WriteRequest::MemForget {
                id: secret_id.clone(),
            },
            Durability::Standard,
        )
        .await
        .unwrap();
    assert_eq!(out, WriteOutput::Count(1));
    db.erase_below(forget_txid).await.unwrap();

    // Before GC, dereferenced objects still fail the proof (txid-named keys
    // make residue visible without reading a byte) — ported posture.
    let ev = store
        .verify_erased_before("u11", forget_txid)
        .await
        .unwrap();
    assert!(!ev.clean, "{ev:?}");
    tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    store.gc("u11", std::time::Duration::ZERO).await.unwrap();
    let ev = store
        .verify_erased_before("u11", forget_txid)
        .await
        .unwrap();
    assert!(ev.clean, "{ev:?}");

    // The memory is gone from every channel; the unrelated row survives.
    assert!(db
        .with_view(|v| memory::get(v, &secret_id))
        .await
        .unwrap()
        .is_none());
    assert!(recall(&db, keyword_query("social security pii", 8))
        .await
        .is_empty());
    let survivor = recall(&db, keyword_query("unrelated activity", 8)).await;
    assert_eq!(survivor.len(), 1);

    // Rewind cannot resurrect erased history: the chain below the forget
    // txid was rewritten, and a rewind to the pre-forget txid still has no
    // trace of the secret (its versions were collapsed away).
    db.rewind(&(forget_txid - 1).to_string()).await.unwrap();
    assert!(recall(&db, keyword_query("social security pii", 8))
        .await
        .is_empty());
}

#[tokio::test]
async fn erasure_blocked_by_checkpoint_pins() {
    let (store, _dir) = mem_store();
    let db = open_db(&store, "u12").await;
    ingest(&db, vec![event("history", json!({}))]).await;
    db.checkpoint("pinned").await.unwrap();
    let head = db.head().await;
    let err = db.erase_below(head + 1).await;
    match err {
        Err(memoturn_strata::StrataError::ErasureBlocked(names)) => {
            assert_eq!(names, vec!["pinned".to_string()]);
        }
        other => panic!("expected ErasureBlocked, got {other:?}"),
    }
}

#[tokio::test]
async fn forget_topic_removes_the_whole_chain() {
    let (store, _dir) = mem_store();
    let db = open_db(&store, "u13").await;
    ingest(
        &db,
        vec![fact("user.addr", "lives at 1 Main St", json!({"a": 1}))],
    )
    .await;
    ingest(
        &db,
        vec![fact("user.addr", "moved to 2 Oak Ave", json!({"a": 2}))],
    )
    .await;
    let (out, _) = db
        .submit(
            WriteRequest::MemForgetTopic {
                mtype: MemoryType::Fact,
                topic: "user.addr".into(),
            },
            Durability::Standard,
        )
        .await
        .unwrap();
    let WriteOutput::Ids(ids) = out else {
        panic!("expected ids")
    };
    assert_eq!(ids.len(), 2, "active row and its superseded chain");
    let all = recall(
        &db,
        RecallQuery {
            topic_key: Some("user.addr".into()),
            include_superseded: true,
            k: 8,
            ..Default::default()
        },
    )
    .await;
    assert!(all.is_empty());
}

// ---- retention / compaction / GC ----

#[tokio::test]
async fn compaction_honors_version_floor_and_gc_reclaims() {
    let (store, _dir) = mem_store();
    let db = open_db(&store, "u14").await;
    for i in 0..5 {
        ingest(
            &db,
            vec![fact("counter", &format!("count {i}"), json!({ "i": i }))],
        )
        .await;
        db.flush().await.unwrap(); // many small L0 runs
    }
    let head = db.head().await;
    db.compact(head).await.unwrap(); // floor = head: only live state kept

    // Live state intact after the full merge.
    let hits = recall(
        &db,
        RecallQuery {
            topic_key: Some("counter".into()),
            k: 4,
            ..Default::default()
        },
    )
    .await;
    assert_eq!(hits[0]["content"], json!({"i": 4}));
    // Supersession is a state machine, not a delete: superseded ROWS survive
    // compaction (only policy sweeps remove them)…
    let all = recall(
        &db,
        RecallQuery {
            topic_key: Some("counter".into()),
            include_superseded: true,
            k: 16,
            ..Default::default()
        },
    )
    .await;
    assert_eq!(all.len(), 5, "superseded rows survive the merge");
    // …but old VERSIONS below the floor are gone: a rewind to the first
    // txid finds no pre-supersession state to resurrect.
    db.rewind("2").await.unwrap();
    let at_first = recall(
        &db,
        RecallQuery {
            topic_key: Some("counter".into()),
            k: 4,
            ..Default::default()
        },
    )
    .await;
    assert!(
        at_first.is_empty(),
        "versions below the retention floor are not restorable: {at_first:?}"
    );

    // Old runs moved to the retained tier; the snapshot window then lapses.
    tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    let pruned = store
        .prune_retention("u14", std::time::Duration::ZERO)
        .await
        .unwrap();
    assert!(pruned >= 5, "replaced runs pruned, got {pruned}");
    let deleted = store.gc("u14", std::time::Duration::ZERO).await.unwrap();
    assert!(
        deleted >= 5,
        "dereferenced objects reclaimed, got {deleted}"
    );
}

#[tokio::test]
async fn retention_respects_checkpoint_pins() {
    let (store, _dir) = mem_store();
    let db = open_db(&store, "u15").await;
    ingest(&db, vec![event("one", json!({}))]).await;
    db.checkpoint("keep-me").await.unwrap();
    ingest(&db, vec![event("two", json!({}))]).await;
    db.flush().await.unwrap();
    let head = db.head().await;
    db.compact(head).await.unwrap();

    tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    // Snapshot window of zero would drop everything retained — but the
    // checkpointed txid pins the runs that can still restore it.
    let m_before = store.replica("u15", "main").await.unwrap();
    let _ = m_before;
    let pruned = store
        .prune_retention("u15", std::time::Duration::ZERO)
        .await
        .unwrap();
    let _ = pruned; // some unpinned runs may go; the pinned one must stay
                    // The checkpoint is still rewindable.
    db.rewind("keep-me").await.unwrap();
    assert_eq!(recall(&db, keyword_query("two", 8)).await.len(), 0);
    assert_eq!(recall(&db, keyword_query("one", 8)).await.len(), 1);
}

// ---- task TTL / sessions / policy sweeps ----

#[tokio::test]
async fn task_ttl_and_session_end() {
    let (store, _dir) = mem_store();
    let db = open_db(&store, "u16").await;
    let mut task = MemoryInput {
        mtype: MemoryType::Task,
        topic_key: None,
        summary: "follow up on refund #88".into(),
        content: json!({}),
        keywords: None,
        embedding: None,
        session_id: Some("s-417".into()),
        source: None,
        ttl_secs: Some(3600),
    };
    ingest(&db, vec![task.clone()]).await;
    task.summary = "durable fact stays".into();
    task.mtype = MemoryType::Fact;
    task.ttl_secs = None;
    ingest(&db, vec![task]).await;

    let sessions = db
        .with_view(|v| memory::list_sessions(v, 10))
        .await
        .unwrap();
    assert_eq!(sessions.len(), 1);
    assert_eq!(sessions[0]["id"], json!("s-417"));

    // End the session: tasks go, durable memories survive.
    let (out, _) = db
        .submit(
            WriteRequest::MemEndSession {
                session: "s-417".into(),
                drop_turns: false,
            },
            Durability::Standard,
        )
        .await
        .unwrap();
    assert_eq!(out, WriteOutput::Count(1));
    assert!(recall(&db, keyword_query("refund", 8)).await.is_empty());
    assert_eq!(recall(&db, keyword_query("durable fact", 8)).await.len(), 1);
}

#[tokio::test]
async fn policy_sweep_ages_out_events_and_superseded_rows() {
    let (store, _dir) = mem_store();
    let db = open_db(&store, "u17").await;
    ingest(&db, vec![event("old event", json!({"n": 1}))]).await;
    ingest(&db, vec![fact("k.v", "v1", json!({"v": 1}))]).await;
    ingest(&db, vec![fact("k.v", "v2", json!({"v": 2}))]).await; // supersedes v1

    // Zero-age caps: everything superseded or event-typed is aged out.
    let rules = memory::MemoryRules {
        event_max_age_secs: Some(0),
        superseded_max_age_secs: Some(0),
        superseded_max_count: None,
    };
    let (out, _) = db
        .submit(WriteRequest::MemEnforcePolicy(rules), Durability::Standard)
        .await
        .unwrap();
    assert_eq!(out, WriteOutput::Count(2), "event + superseded row swept");
    let active = recall(
        &db,
        RecallQuery {
            topic_key: Some("k.v".into()),
            include_superseded: true,
            k: 8,
            ..Default::default()
        },
    )
    .await;
    assert_eq!(active.len(), 1, "active fact survives the sweep");
}

// ---- docs ----

#[tokio::test]
async fn docs_planner_agrees_with_naive_matcher() {
    let (store, _dir) = mem_store();
    let db = open_db(&store, "u18").await;
    let docs_json: Vec<Json> = (0..40)
        .map(|i| {
            json!({
                "_id": format!("d{i:02}"),
                "kind": if i % 3 == 0 { "alpha" } else { "beta" },
                "n": i,
                "nested": {"deep": i % 5},
                "maybe": if i % 4 == 0 { json!(null) } else { json!(i) },
            })
        })
        .collect();
    db.submit(
        WriteRequest::DocInsert {
            collection: "things".into(),
            docs: docs_json.clone(),
        },
        Durability::Standard,
    )
    .await
    .unwrap();
    db.submit(
        WriteRequest::DocCreateIndex {
            collection: "things".into(),
            path: "kind".into(),
        },
        Durability::Standard,
    )
    .await
    .unwrap();
    db.submit(
        WriteRequest::DocCreateIndex {
            collection: "things".into(),
            path: "n".into(),
        },
        Durability::Standard,
    )
    .await
    .unwrap();

    let filters = vec![
        json!({}),
        json!({"_id": "d07"}),
        json!({"kind": "alpha"}),
        json!({"kind": "alpha", "n": {"$gte": 12}}),
        json!({"n": {"$gt": 5, "$lt": 20}}),
        json!({"n": {"$in": [1, 5, 9, 13, 99]}}),
        json!({"n": {"$nin": [0, 1, 2, 3]}}),
        json!({"$or": [{"kind": "alpha"}, {"n": {"$lt": 4}}]}),
        json!({"$not": {"kind": "beta"}}),
        json!({"maybe": {"$exists": true}}),
        json!({"nested.deep": 3}),
        json!({"kind": {"$ne": "alpha"}}),
    ];
    for f in filters {
        let via_engine = db
            .with_view(|v| {
                docs::find(
                    v,
                    "things",
                    &f,
                    docs::FindOpts {
                        sort: Some(json!({"_id": 1})),
                        limit: 1000,
                        skip: 0,
                    },
                )
            })
            .await
            .unwrap();
        // Oracle: the naive matcher over all docs.
        let parsed = memoturn_strata::surface::docfilter::parse(&f).unwrap();
        let mut expected: Vec<Json> = docs_json
            .iter()
            .filter(|d| memoturn_strata::surface::docfilter::matches(d, &parsed))
            .cloned()
            .collect();
        expected.sort_by_key(|d| d["_id"].as_str().unwrap().to_string());
        assert_eq!(via_engine, expected, "filter {f}");
    }
}

#[tokio::test]
async fn doc_updates_maintain_indexes() {
    let (store, _dir) = mem_store();
    let db = open_db(&store, "u19").await;
    db.submit(
        WriteRequest::DocInsert {
            collection: "orders".into(),
            docs: vec![
                json!({"_id": "o1", "status": "open", "total": 10}),
                json!({"_id": "o2", "status": "open", "total": 20}),
            ],
        },
        Durability::Standard,
    )
    .await
    .unwrap();
    db.submit(
        WriteRequest::DocCreateIndex {
            collection: "orders".into(),
            path: "status".into(),
        },
        Durability::Standard,
    )
    .await
    .unwrap();
    let (out, _) = db
        .submit(
            WriteRequest::DocUpdate {
                collection: "orders".into(),
                filter: json!({"_id": "o1"}),
                update: json!({"$set": {"status": "closed"}, "$inc": {"total": 5}}),
                multi: false,
            },
            Durability::Standard,
        )
        .await
        .unwrap();
    assert_eq!(out, WriteOutput::Count(1));

    // The index range for "open" must no longer return o1.
    let open = db
        .with_view(|v| docs::find(v, "orders", &json!({"status": "open"}), Default::default()))
        .await
        .unwrap();
    assert_eq!(open.len(), 1);
    assert_eq!(open[0]["_id"], json!("o2"));
    let closed = db
        .with_view(|v| {
            docs::find(
                v,
                "orders",
                &json!({"status": "closed"}),
                Default::default(),
            )
        })
        .await
        .unwrap();
    assert_eq!(closed[0]["total"], json!(15));

    let (out, _) = db
        .submit(
            WriteRequest::DocDelete {
                collection: "orders".into(),
                filter: json!({"status": "closed"}),
                multi: true,
            },
            Durability::Standard,
        )
        .await
        .unwrap();
    assert_eq!(out, WriteOutput::Count(1));
}

// ---- kv / transcripts ----

#[tokio::test]
async fn kv_ttl_and_prefix_list() {
    let (store, _dir) = mem_store();
    let db = open_db(&store, "u20").await;
    for (k, ttl) in [("user:1", None), ("user:2", Some(0u64)), ("other", None)] {
        db.submit(
            WriteRequest::KvPut {
                ns: "app".into(),
                key: k.into(),
                value: k.as_bytes().to_vec(),
                ttl_secs: ttl,
            },
            Durability::Standard,
        )
        .await
        .unwrap();
    }
    let (hit, expired, listed) = db
        .with_view(|v| {
            (
                kv::get(v, "app", "user:1").unwrap(),
                kv::get(v, "app", "user:2").unwrap(),
                kv::list(v, "app", "user:", 10).unwrap(),
            )
        })
        .await;
    assert_eq!(hit, Some(b"user:1".to_vec()));
    assert_eq!(expired, None, "expired key is a lazy miss");
    assert_eq!(listed, vec!["user:1".to_string()]);

    let (out, _) = db
        .submit(WriteRequest::KvSweep, Durability::Standard)
        .await
        .unwrap();
    assert_eq!(out, WriteOutput::Count(1), "sweep reclaims the expired key");
}

#[tokio::test]
async fn transcript_appends_windows_and_searches() {
    let (store, _dir) = mem_store();
    let db = open_db(&store, "u21").await;
    for (i, text) in ["hello there", "how can I help", "my bill is wrong"]
        .iter()
        .enumerate()
    {
        let emb = if i == 2 {
            Some(vec![1.0f32, 0.0])
        } else {
            None
        };
        let (out, _) = db
            .submit(
                WriteRequest::TurnAppend {
                    session: "s1".into(),
                    role: if i % 2 == 0 {
                        "user".into()
                    } else {
                        "assistant".into()
                    },
                    content: json!({ "text": text }),
                    embedding: emb,
                },
                Durability::Standard,
            )
            .await
            .unwrap();
        assert_eq!(out, WriteOutput::Seq(i as u64 + 1), "seq assignment");
    }
    let window = db
        .with_view(|v| transcript::get_window(v, "s1", 2))
        .await
        .unwrap();
    assert_eq!(window.len(), 2);
    assert_eq!(window[0]["seq"], json!(2));
    assert_eq!(window[1]["content"]["text"], json!("my bill is wrong"));

    let found = db
        .with_view(|v| transcript::search(v, Some("s1"), &[0.9f32, 0.1], 2))
        .await
        .unwrap();
    assert_eq!(found.len(), 1, "only embedded turns are searchable");
    assert_eq!(found[0]["seq"], json!(3));
}

// ---- schema-evolution posture ----

#[tokio::test]
async fn old_records_decode_after_rewind_no_migration_state() {
    // The stateless-migration requirement: versioned record enums decode
    // every historical version; rewind can resurrect old rows at any time.
    let (store, _dir) = mem_store();
    let db = open_db(&store, "u22").await;
    ingest(&db, vec![fact("a.b", "first", json!({"v": 1}))]).await;
    db.checkpoint("v1-era").await.unwrap();
    ingest(&db, vec![fact("a.b", "second", json!({"v": 2}))]).await;
    db.flush().await.unwrap();
    db.rewind("v1-era").await.unwrap();
    let hits = recall(
        &db,
        RecallQuery {
            topic_key: Some("a.b".into()),
            k: 4,
            ..Default::default()
        },
    )
    .await;
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0]["content"], json!({"v": 1}));
    assert_eq!(
        hits[0]["superseded_by"],
        Json::Null,
        "resurrected as active"
    );
}
