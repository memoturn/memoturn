use crate::value::{QueryResult, Value};
use crate::{EngineConn, EngineError, Result, SqlEngine};
use async_trait::async_trait;
use std::path::Path;
use std::sync::Arc;

/// v1 engine adapter: libSQL embedded as a library (ADR-0001).
pub struct LibsqlEngine;

struct LibsqlConn {
    /// Writer connection: all mutations, plus in-transaction reads.
    writer: libsql::Connection,
    /// Reader connection: concurrent consistent reads under WAL.
    reader: libsql::Connection,
    _db: libsql::Database,
}

fn to_libsql(params: Vec<Value>) -> Vec<libsql::Value> {
    params
        .into_iter()
        .map(|v| match v {
            Value::Null => libsql::Value::Null,
            Value::Integer(i) => libsql::Value::Integer(i),
            Value::Real(f) => libsql::Value::Real(f),
            Value::Text(s) => libsql::Value::Text(s),
            Value::Blob(b) => libsql::Value::Blob(b),
        })
        .collect()
}

fn from_libsql(v: libsql::Value) -> Value {
    match v {
        libsql::Value::Null => Value::Null,
        libsql::Value::Integer(i) => Value::Integer(i),
        libsql::Value::Real(f) => Value::Real(f),
        libsql::Value::Text(s) => Value::Text(s),
        libsql::Value::Blob(b) => Value::Blob(b),
    }
}

fn sql_err(e: libsql::Error) -> EngineError {
    EngineError::Sql(e.to_string())
}

async fn run_query(
    conn: &libsql::Connection,
    sql: &str,
    params: Vec<Value>,
) -> Result<QueryResult> {
    let mut rows = conn
        .query(sql, libsql::params_from_iter(to_libsql(params)))
        .await
        .map_err(sql_err)?;
    let ncols = rows.column_count() as usize;
    let columns: Vec<String> = (0..ncols)
        .map(|i| rows.column_name(i as i32).unwrap_or("").to_string())
        .collect();
    let mut out = Vec::new();
    while let Some(row) = rows.next().await.map_err(sql_err)? {
        let mut vals = Vec::with_capacity(ncols);
        for i in 0..ncols {
            vals.push(from_libsql(row.get_value(i as i32).map_err(sql_err)?).to_json());
        }
        out.push(vals);
    }
    Ok(QueryResult {
        columns,
        rows: out,
        rows_affected: 0,
    })
}

#[async_trait]
impl EngineConn for LibsqlConn {
    async fn execute(&self, sql: &str, params: Vec<Value>) -> Result<u64> {
        self.writer
            .execute(sql, libsql::params_from_iter(to_libsql(params)))
            .await
            .map_err(sql_err)
    }

    async fn query_writer(&self, sql: &str, params: Vec<Value>) -> Result<QueryResult> {
        run_query(&self.writer, sql, params).await
    }

    async fn query(&self, sql: &str, params: Vec<Value>) -> Result<QueryResult> {
        run_query(&self.reader, sql, params).await
    }

    async fn execute_batch(&self, sql: &str) -> Result<()> {
        self.writer.execute_batch(sql).await.map_err(sql_err)?;
        Ok(())
    }
}

#[async_trait]
impl SqlEngine for LibsqlEngine {
    async fn open(&self, path: &Path) -> Result<Arc<dyn EngineConn>> {
        if let Some(parent) = path.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }
        let db = libsql::Builder::new_local(path)
            .build()
            .await
            .map_err(sql_err)?;
        let writer = db.connect().map_err(sql_err)?;
        let reader = db.connect().map_err(sql_err)?;
        // Tiny per-handle page cache: the real cache is the node-global layer
        // (deterministic node memory; see docs/architecture/01).
        // wal_autocheckpoint=0: the replication layer owns WAL lifecycle —
        // it captures frames as segments and checkpoints after compaction
        // snapshots. An auto-checkpoint would reset the WAL under the capture
        // cursor (detected and survived via snapshot fallback, but wasteful).
        writer
            .execute_batch(
                "PRAGMA journal_mode=WAL;
                 PRAGMA synchronous=NORMAL;
                 PRAGMA busy_timeout=5000;
                 PRAGMA cache_size=-256;
                 PRAGMA wal_autocheckpoint=0;",
            )
            .await
            .map_err(sql_err)?;
        reader
            .execute_batch("PRAGMA busy_timeout=5000; PRAGMA cache_size=-128;")
            .await
            .map_err(sql_err)?;
        Ok(Arc::new(LibsqlConn {
            writer,
            reader,
            _db: db,
        }))
    }
}
