//! The agent-memory recall path (docs/architecture/07) depends on FTS5 being
//! compiled into the bundled libSQL — this fails the build of any libsql
//! upgrade that drops it, rather than failing at runtime.

use memoturn_engine::{LibsqlEngine, SqlEngine, Value};

#[tokio::test]
async fn fts5_is_available() {
    let dir = tempfile::tempdir().unwrap();
    let engine = LibsqlEngine;
    let conn = engine.open(&dir.path().join("fts5.db")).await.unwrap();
    conn.execute_batch(
        "CREATE VIRTUAL TABLE t USING fts5(body);
         INSERT INTO t(body) VALUES ('the refund policy allows returns within 30 days');",
    )
    .await
    .unwrap();
    let r = conn
        .query(
            "SELECT bm25(t) FROM t WHERE t MATCH ?",
            vec![Value::Text("\"refund\"".into())],
        )
        .await
        .unwrap();
    assert_eq!(r.rows.len(), 1);
}
