use crate::value::{QueryResult, Value};
use crate::{EngineConn, EngineError, Result, SqlEngine};
use serde::Deserialize;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::Mutex;

/// Per-node engine: hosts many tiny databases behind a bounded hot pool.
///
/// Temperature tiers (docs/architecture/01):
/// - hot: entry in `pool` (open handle)
/// - warm: file on local disk, no handle — falls out of the pool by LRU
///   capacity or idle timeout; reopening is sub-ms
/// - cold: object storage only (M2 — restore path lives in replication)
pub struct NodeEngine {
    engine: Arc<dyn SqlEngine>,
    data_dir: PathBuf,
    pool: moka::future::Cache<String, Arc<DbHandle>>,
}

#[derive(Debug, Clone)]
pub struct NodeConfig {
    pub data_dir: PathBuf,
    /// Max simultaneously-open (hot) databases.
    pub hot_cap: u64,
    /// Hot → warm demotion after this much idle time.
    pub hot_idle: Duration,
}

impl Default for NodeConfig {
    fn default() -> Self {
        Self {
            data_dir: PathBuf::from("./data"),
            hot_cap: 50_000,
            hot_idle: Duration::from_secs(60),
        }
    }
}

/// One SQL statement with JSON-encoded params (see `Value::from_json`).
#[derive(Debug, Clone, Deserialize)]
pub struct Stmt {
    pub q: String,
    #[serde(default)]
    pub params: Vec<serde_json::Value>,
}

/// An open (hot) database. Single-writer: all mutations serialize on
/// `write_lock`; every effective write bumps the durable per-DB `txid`
/// (`__memoturn_meta`), which every API response discloses.
pub struct DbHandle {
    conn: Arc<dyn EngineConn>,
    txid: AtomicU64,
    write_lock: Mutex<()>,
    path: PathBuf,
    /// WAL capture cursor for segment replication (crate::wal). Guarded by
    /// `write_lock` critical sections so captures align with txid boundaries.
    wal_cursor: Mutex<Option<crate::wal::WalCursor>>,
}

const META_INIT: &str = "
CREATE TABLE IF NOT EXISTS __memoturn_meta (k TEXT PRIMARY KEY, v) WITHOUT ROWID;
INSERT OR IGNORE INTO __memoturn_meta VALUES ('txid', 0);
CREATE TABLE IF NOT EXISTS __memoturn_kv (
  ns TEXT NOT NULL, k TEXT NOT NULL,
  v BLOB NOT NULL, meta BLOB,
  expires_at INTEGER,
  PRIMARY KEY (ns, k)
) WITHOUT ROWID;
";

impl NodeEngine {
    pub fn new(engine: Arc<dyn SqlEngine>, config: NodeConfig) -> Self {
        let pool = moka::future::Cache::builder()
            .max_capacity(config.hot_cap)
            .time_to_idle(config.hot_idle)
            .build();
        Self {
            engine,
            data_dir: config.data_dir,
            pool,
        }
    }

    /// Local directory for one branch of one database:
    /// `dbs/{shard}/{uuid}/{branch}/` (file is `main.db` inside).
    pub fn db_dir(&self, db_uuid: &str, branch: &str) -> PathBuf {
        let shard = &db_uuid[..2.min(db_uuid.len())];
        self.data_dir
            .join("dbs")
            .join(shard)
            .join(db_uuid)
            .join(branch)
    }

    pub fn db_file(&self, db_uuid: &str, branch: &str) -> PathBuf {
        self.db_dir(db_uuid, branch).join("main.db")
    }

    /// Open-or-get the handle (hot tier) for pool key `uuid@branch`.
    /// Single-flight per database.
    pub async fn handle(&self, key: &str, path: &std::path::Path) -> Result<Arc<DbHandle>> {
        let path = path.to_path_buf();
        let engine = self.engine.clone();
        self.pool
            .try_get_with(key.to_string(), async move {
                let conn = engine.open(&path).await?;
                conn.execute_batch(META_INIT).await?;
                let txid = read_txid(conn.as_ref()).await?;
                Ok(Arc::new(DbHandle {
                    conn,
                    txid: AtomicU64::new(txid),
                    write_lock: Mutex::new(()),
                    path,
                    wal_cursor: Mutex::new(None),
                }))
            })
            .await
            .map_err(|e: Arc<EngineError>| EngineError::Sql(e.to_string()))
    }

    /// Drop a handle from the hot pool (demote) without touching files.
    pub async fn evict(&self, key: &str) {
        self.pool.invalidate(key).await;
    }

    /// Drop from the hot pool and delete the branch's local files.
    pub async fn evict_and_remove(&self, key: &str, dir: &std::path::Path) -> Result<()> {
        self.pool.invalidate(key).await;
        match tokio::fs::remove_dir_all(dir).await {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e.into()),
        }
        Ok(())
    }

    pub fn hot_count(&self) -> u64 {
        self.pool.entry_count()
    }

    /// Snapshot of the hot pool (key = `uuid@branch`) for maintenance sweeps.
    pub fn hot_entries(&self) -> Vec<(String, Arc<DbHandle>)> {
        self.pool.iter().map(|(k, v)| ((*k).clone(), v)).collect()
    }
}

async fn read_txid(conn: &dyn EngineConn) -> Result<u64> {
    let r = conn
        .query_writer("SELECT v FROM __memoturn_meta WHERE k='txid'", vec![])
        .await?;
    Ok(r.rows
        .first()
        .and_then(|row| row.first())
        .and_then(|v| v.as_i64())
        .unwrap_or(0) as u64)
}

fn is_returning(sql: &str) -> bool {
    let s = sql.trim_start().to_ascii_lowercase();
    s.starts_with("select")
        || s.starts_with("with")
        || s.starts_with("pragma")
        || s.starts_with("explain")
        || s.contains(" returning ")
}

impl DbHandle {
    pub fn txid(&self) -> u64 {
        self.txid.load(Ordering::Acquire)
    }

    /// Read on the dedicated reader connection (concurrent with writes).
    pub async fn read(&self, sql: &str, params: Vec<Value>) -> Result<QueryResult> {
        self.conn.query(sql, params).await
    }

    /// Execute a batch of statements atomically (BEGIN IMMEDIATE … COMMIT).
    /// Bumps and returns the database txid iff any statement changed rows.
    pub async fn write_batch(&self, stmts: &[Stmt]) -> Result<(Vec<QueryResult>, u64)> {
        let _guard = self.write_lock.lock().await;
        self.conn.execute("BEGIN IMMEDIATE", vec![]).await?;
        let result = self.run_in_txn(stmts).await;
        match result {
            Ok((results, changed)) => {
                let new_txid = if changed > 0 {
                    let t = self.txid() + 1;
                    self.conn
                        .execute(
                            "UPDATE __memoturn_meta SET v=? WHERE k='txid'",
                            vec![Value::Integer(t as i64)],
                        )
                        .await?;
                    t
                } else {
                    self.txid()
                };
                self.conn.execute("COMMIT", vec![]).await?;
                self.txid.store(new_txid, Ordering::Release);
                Ok((results, new_txid))
            }
            Err(e) => {
                let _ = self.conn.execute("ROLLBACK", vec![]).await;
                Err(e)
            }
        }
    }

    async fn run_in_txn(&self, stmts: &[Stmt]) -> Result<(Vec<QueryResult>, u64)> {
        let mut results = Vec::with_capacity(stmts.len());
        let mut changed: u64 = 0;
        for stmt in stmts {
            let params: Vec<Value> = stmt.params.iter().map(Value::from_json).collect();
            if is_returning(&stmt.q) {
                results.push(self.conn.query_writer(&stmt.q, params).await?);
            } else {
                let n = self.conn.execute(&stmt.q, params).await?;
                changed += n;
                results.push(QueryResult {
                    rows_affected: n,
                    ..Default::default()
                });
            }
        }
        Ok((results, changed))
    }

    /// Internal write path for trusted (reserved-table) statements: KV, docs.
    /// Same locking and txid semantics as `write_batch`.
    pub async fn write_trusted(&self, sql: &str, params: Vec<Value>) -> Result<(u64, u64)> {
        self.write_trusted_batch(&[(sql.to_string(), params)]).await
    }

    /// Trusted multi-statement atomic batch; returns (total rows affected, txid).
    pub async fn write_trusted_batch(&self, stmts: &[(String, Vec<Value>)]) -> Result<(u64, u64)> {
        let _guard = self.write_lock.lock().await;
        self.conn.execute("BEGIN IMMEDIATE", vec![]).await?;
        let mut total: u64 = 0;
        for (sql, params) in stmts {
            match self.conn.execute(sql, params.clone()).await {
                Ok(n) => total += n,
                Err(e) => {
                    let _ = self.conn.execute("ROLLBACK", vec![]).await;
                    return Err(e);
                }
            }
        }
        let new_txid = if total > 0 {
            let t = self.txid() + 1;
            let bump = self
                .conn
                .execute(
                    "UPDATE __memoturn_meta SET v=? WHERE k='txid'",
                    vec![Value::Integer(t as i64)],
                )
                .await;
            if let Err(e) = bump {
                let _ = self.conn.execute("ROLLBACK", vec![]).await;
                return Err(e);
            }
            t
        } else {
            self.txid()
        };
        self.conn.execute("COMMIT", vec![]).await?;
        self.txid.store(new_txid, Ordering::Release);
        Ok((total, new_txid))
    }

    /// Trusted read (reserved tables) on the reader connection.
    pub async fn read_trusted(&self, sql: &str, params: Vec<Value>) -> Result<QueryResult> {
        self.conn.query(sql, params).await
    }

    /// Raw statement outside any transaction (e.g. `VACUUM INTO`), serialized
    /// with writes. Does not bump txid.
    pub async fn exec_raw(&self, sql: &str, params: Vec<Value>) -> Result<u64> {
        let _guard = self.write_lock.lock().await;
        self.conn.execute(sql, params).await
    }

    /// Toggle SQLite `secure_delete` on the writer connection: while on,
    /// freed cells are zeroed, so a snapshot taken after a delete carries no
    /// byte residue of the deleted rows (the erasure path, ADR-0010).
    /// Connection-scoped — callers bracket the erasing transaction.
    pub async fn set_secure_delete(&self, on: bool) -> Result<()> {
        let _guard = self.write_lock.lock().await;
        let sql = if on {
            "PRAGMA secure_delete=ON"
        } else {
            "PRAGMA secure_delete=OFF"
        };
        self.conn.query_writer(sql, vec![]).await.map(|_| ())
    }

    fn wal_path(&self) -> PathBuf {
        let mut name = self.path.file_name().unwrap_or_default().to_os_string();
        name.push("-wal");
        self.path.with_file_name(name)
    }

    /// Capture committed WAL frames since the last capture, atomically with
    /// the txid boundary. Returns (capture, txid at capture) — the segment's
    /// `max_txid`. `None` means the cursor was lost (WAL reset underneath
    /// us): caller must ship a full snapshot instead.
    pub async fn capture_wal(&self) -> Result<Option<(crate::wal::WalCapture, u64)>> {
        let _guard = self.write_lock.lock().await;
        let mut cursor = self.wal_cursor.lock().await;
        match crate::wal::WalCursor::capture(&mut cursor, &self.wal_path())? {
            crate::wal::CaptureOutcome::Captured(c) => Ok(Some((c, self.txid()))),
            crate::wal::CaptureOutcome::CursorLost => {
                *cursor = None;
                Ok(None)
            }
        }
    }

    /// Consistent, **layout-faithful** full snapshot. Segment replay patches
    /// live-file page images onto this base, so the base must be the live
    /// file's layout — never `VACUUM INTO` (vacuum rewrites page numbers).
    ///
    /// Fast path: checkpoint(TRUNCATE) folds the WAL into the file and the
    /// file is the snapshot (cursor resets). Busy path (active reader):
    /// overlay all committed WAL pages onto the file image in memory and
    /// skip the cursor to the snapshot point. Atomic with the txid boundary.
    pub async fn snapshot_bytes(&self) -> Result<(Vec<u8>, u64)> {
        let _guard = self.write_lock.lock().await;
        let r = self
            .conn
            .query_writer("PRAGMA wal_checkpoint(TRUNCATE)", vec![])
            .await?;
        // wal_checkpoint returns (busy, log, checkpointed); busy=0 ⇒ success.
        let truncated = r
            .rows
            .first()
            .and_then(|row| row.first())
            .and_then(|v| v.as_i64())
            == Some(0);
        let mut cursor = self.wal_cursor.lock().await;
        let wal_path = self.wal_path();
        if truncated {
            *cursor = None;
            let bytes = tokio::fs::read(&self.path).await?;
            return Ok((bytes, self.txid()));
        }
        // Overlay committed WAL frames onto the file image (checkpoint
        // semantics, in memory). A fresh local-only walk sees all commits.
        let mut image = match tokio::fs::read(&self.path).await {
            Ok(b) => b,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Vec::new(),
            Err(e) => return Err(e.into()),
        };
        let mut full = None;
        if let crate::wal::CaptureOutcome::Captured(c) =
            crate::wal::WalCursor::capture(&mut full, &wal_path)?
        {
            if c.db_size_pages > 0 {
                let ps = c.page_size as usize;
                let new_len = c.db_size_pages as usize * ps;
                if image.len() < new_len {
                    image.resize(new_len, 0);
                }
                for (pgno, img) in &c.pages {
                    let at = (*pgno as usize - 1) * ps;
                    if at + ps > image.len() {
                        image.resize(at + ps, 0);
                    }
                    image[at..at + ps].copy_from_slice(img);
                }
                image.truncate(new_len);
            }
        }
        crate::wal::WalCursor::skip_to_end(&mut cursor, &wal_path)?;
        Ok((image, self.txid()))
    }
}
