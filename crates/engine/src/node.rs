use crate::value::{QueryResult, Value};
use crate::{EngineConn, EngineError, Result, SqlEngine};
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{oneshot, Mutex};

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
    write_queue_cap: usize,
}

#[derive(Debug, Clone)]
pub struct NodeConfig {
    pub data_dir: PathBuf,
    /// Max simultaneously-open (hot) databases.
    pub hot_cap: u64,
    /// Hot → warm demotion after this much idle time.
    pub hot_idle: Duration,
    /// Per-database write-queue depth past which new writes are shed with
    /// [`EngineError::Overloaded`] — the hot-profile backpressure threshold
    /// (docs/architecture/01, "Per-database write ceiling").
    pub write_queue_cap: usize,
}

impl Default for NodeConfig {
    fn default() -> Self {
        Self {
            data_dir: PathBuf::from("./data"),
            hot_cap: 50_000,
            hot_idle: Duration::from_secs(60),
            write_queue_cap: 256,
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
///
/// Writes are **group-committed** (docs/architecture/01, "Per-database write
/// ceiling"): concurrent `write_batch`/`write_trusted_batch` calls queue on
/// `write_queue`, and whichever caller wins `write_lock` drains a bounded
/// round into one transaction — each request bracketed by a savepoint so it
/// keeps its own atomicity and error — then commits once. Participants in a
/// round share the bumped `txid`. Past `queue_cap` pending writes, new ones
/// are shed with [`EngineError::Overloaded`] so a hot database fails fast
/// instead of collapsing into queueing latency.
pub struct DbHandle {
    conn: Arc<dyn EngineConn>,
    txid: AtomicU64,
    write_lock: Mutex<()>,
    path: PathBuf,
    /// WAL capture cursor for segment replication (crate::wal). Guarded by
    /// `write_lock` critical sections so captures align with txid boundaries.
    wal_cursor: Mutex<Option<crate::wal::WalCursor>>,
    write_queue: std::sync::Mutex<VecDeque<PendingWrite>>,
    queue_cap: usize,
    writes_total: AtomicU64,
    rounds_total: AtomicU64,
    shed_total: AtomicU64,
}

/// Most requests a single commit round will absorb. Bounds both the lock hold
/// and the transaction size; waiters beyond the bound just join the next round.
const WRITE_ROUND_MAX: usize = 64;

/// Per-request savepoint name. Reserved-prefixed so user SQL can never name it
/// (`guard_reserved` rejects `__memoturn_*` identifiers).
const ROUND_SAVEPOINT: &str = "__memoturn_w";

enum WriteWork {
    User(Vec<Stmt>),
    Trusted(Vec<(String, Vec<Value>)>),
}

enum WriteOutcome {
    User(Vec<QueryResult>),
    Trusted(u64),
}

struct PendingWrite {
    work: WriteWork,
    done: oneshot::Sender<Result<(WriteOutcome, u64)>>,
}

/// Counters for one database's write path — the per-DB write-rate and
/// apply-queue observability layer (docs/architecture/01). `writes / rounds`
/// is the group-commit coalescing factor.
#[derive(Debug, Default, Clone, Copy, Serialize)]
pub struct WriteStats {
    /// Writes queued behind the writer right now.
    pub queued: usize,
    /// Write requests committed since the handle opened.
    pub writes: u64,
    /// Commit rounds those writes coalesced into.
    pub rounds: u64,
    /// Writes shed with `Overloaded` since the handle opened.
    pub shed: u64,
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
            write_queue_cap: config.write_queue_cap,
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
        let queue_cap = self.write_queue_cap;
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
                    write_queue: std::sync::Mutex::new(VecDeque::new()),
                    queue_cap,
                    writes_total: AtomicU64::new(0),
                    rounds_total: AtomicU64::new(0),
                    shed_total: AtomicU64::new(0),
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

    /// Execute a batch of statements atomically. The batch may be coalesced
    /// into a group-commit round with concurrent writers (its own savepoint,
    /// shared COMMIT). Returns the txid the batch is visible at; the txid
    /// bumps iff any statement in the round changed rows.
    pub async fn write_batch(&self, stmts: &[Stmt]) -> Result<(Vec<QueryResult>, u64)> {
        match self.submit(WriteWork::User(stmts.to_vec())).await? {
            (WriteOutcome::User(results), txid) => Ok((results, txid)),
            _ => Err(EngineError::Sql("write outcome shape mismatch".into())),
        }
    }

    /// Internal write path for trusted (reserved-table) statements: KV, docs.
    /// Same queueing and txid semantics as `write_batch`.
    pub async fn write_trusted(&self, sql: &str, params: Vec<Value>) -> Result<(u64, u64)> {
        self.write_trusted_batch(&[(sql.to_string(), params)]).await
    }

    /// Trusted multi-statement atomic batch; returns (total rows affected, txid).
    pub async fn write_trusted_batch(&self, stmts: &[(String, Vec<Value>)]) -> Result<(u64, u64)> {
        match self.submit(WriteWork::Trusted(stmts.to_vec())).await? {
            (WriteOutcome::Trusted(total), txid) => Ok((total, txid)),
            _ => Err(EngineError::Sql("write outcome shape mismatch".into())),
        }
    }

    /// Counters for this database's write path (queue gauge + totals).
    pub fn write_stats(&self) -> WriteStats {
        WriteStats {
            queued: self.write_queue.lock().expect("write queue poisoned").len(),
            writes: self.writes_total.load(Ordering::Relaxed),
            rounds: self.rounds_total.load(Ordering::Relaxed),
            shed: self.shed_total.load(Ordering::Relaxed),
        }
    }

    /// Enqueue one write and drive commit rounds until its result arrives.
    ///
    /// Leader/follower group commit: every caller queues, then competes for
    /// `write_lock`; the winner drains up to [`WRITE_ROUND_MAX`] pending
    /// writes into one transaction and answers each via its oneshot. A caller
    /// whose work was committed by another leader finds its result on the
    /// next loop iteration. Note that once enqueued, a write will be applied
    /// even if this future is cancelled (client disconnect) — same as a
    /// commit racing a dropped connection.
    async fn submit(&self, work: WriteWork) -> Result<(WriteOutcome, u64)> {
        let (done, mut rx) = oneshot::channel();
        {
            let mut q = self.write_queue.lock().expect("write queue poisoned");
            if q.len() >= self.queue_cap {
                let shed = self.shed_total.fetch_add(1, Ordering::Relaxed) + 1;
                if shed == 1 || shed.is_multiple_of(100) {
                    tracing::warn!(
                        db = %self.path.display(),
                        pending = q.len(),
                        shed_total = shed,
                        "per-database write queue full; shedding writes"
                    );
                }
                return Err(EngineError::Overloaded(q.len()));
            }
            q.push_back(PendingWrite { work, done });
        }
        loop {
            match rx.try_recv() {
                Ok(res) => return res,
                Err(oneshot::error::TryRecvError::Empty) => {}
                // The leader processing our round was cancelled mid-round; its
                // open transaction is rolled back by the next round's BEGIN.
                Err(oneshot::error::TryRecvError::Closed) => {
                    return Err(EngineError::Sql("write round aborted".into()))
                }
            }
            let _guard = self.write_lock.lock().await;
            let round: Vec<PendingWrite> = {
                let mut q = self.write_queue.lock().expect("write queue poisoned");
                let n = q.len().min(WRITE_ROUND_MAX);
                q.drain(..n).collect()
            };
            // Empty round ⇒ a prior leader took our entry, and it answered
            // before releasing the lock we now hold — next try_recv resolves.
            if !round.is_empty() {
                self.commit_round(round).await;
            }
        }
    }

    /// Run one round; on a round-level failure, roll back and fail every
    /// participant (preserving the original error when there is only one).
    async fn commit_round(&self, mut round: Vec<PendingWrite>) {
        match self.try_round(&mut round).await {
            Ok(()) => {} // try_round answered every participant
            Err(e) => {
                let _ = self.conn.execute("ROLLBACK", vec![]).await;
                if round.len() == 1 {
                    let p = round.pop().expect("len checked");
                    let _ = p.done.send(Err(e));
                } else {
                    let msg = e.to_string();
                    for p in round.drain(..) {
                        let _ = p.done.send(Err(EngineError::Sql(msg.clone())));
                    }
                }
            }
        }
    }

    /// BEGIN IMMEDIATE, healing a transaction a cancelled writer left open on
    /// the writer connection (rollback, retry once).
    async fn begin_round(&self) -> Result<()> {
        if self.conn.execute("BEGIN IMMEDIATE", vec![]).await.is_ok() {
            return Ok(());
        }
        let _ = self.conn.execute("ROLLBACK", vec![]).await;
        self.conn
            .execute("BEGIN IMMEDIATE", vec![])
            .await
            .map(|_| ())
    }

    /// One group-commit round: each participant inside its own savepoint (a
    /// failed one rolls back alone, the round survives), one txid bump iff
    /// anything changed, one COMMIT, then every participant is answered.
    /// Single-participant rounds skip the savepoint — exactly the historical
    /// per-request transaction. An `Err` return means nothing committed and
    /// no participant has been answered (caller rolls back and fans the error
    /// out); savepoint-machinery failures are round-level because after a
    /// failed `ROLLBACK TO` the transaction state is unknown.
    async fn try_round(&self, round: &mut Vec<PendingWrite>) -> Result<()> {
        self.begin_round().await?;
        let multi = round.len() > 1;
        let mut bodies: Vec<Result<(WriteOutcome, u64)>> = Vec::with_capacity(round.len());
        for p in round.iter() {
            if multi {
                self.conn
                    .execute(&format!("SAVEPOINT {ROUND_SAVEPOINT}"), vec![])
                    .await?;
            }
            let res = match &p.work {
                WriteWork::User(stmts) => self
                    .run_user_stmts(stmts)
                    .await
                    .map(|(results, changed)| (WriteOutcome::User(results), changed)),
                WriteWork::Trusted(stmts) => self
                    .run_trusted_stmts(stmts)
                    .await
                    .map(|changed| (WriteOutcome::Trusted(changed), changed)),
            };
            match res {
                Ok(body) => {
                    if multi {
                        self.conn
                            .execute(&format!("RELEASE {ROUND_SAVEPOINT}"), vec![])
                            .await?;
                    }
                    bodies.push(Ok(body));
                }
                Err(e) if multi => {
                    self.conn
                        .execute(&format!("ROLLBACK TO {ROUND_SAVEPOINT}"), vec![])
                        .await?;
                    self.conn
                        .execute(&format!("RELEASE {ROUND_SAVEPOINT}"), vec![])
                        .await?;
                    bodies.push(Err(e));
                }
                Err(e) => return Err(e),
            }
        }
        let total: u64 = bodies
            .iter()
            .filter_map(|b| b.as_ref().ok())
            .map(|(_, changed)| *changed)
            .sum();
        let new_txid = if total > 0 {
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
        self.rounds_total.fetch_add(1, Ordering::Relaxed);
        self.writes_total
            .fetch_add(round.len() as u64, Ordering::Relaxed);
        for (p, body) in round.drain(..).zip(bodies) {
            let _ = p.done.send(body.map(|(outcome, _)| (outcome, new_txid)));
        }
        Ok(())
    }

    async fn run_user_stmts(&self, stmts: &[Stmt]) -> Result<(Vec<QueryResult>, u64)> {
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

    async fn run_trusted_stmts(&self, stmts: &[(String, Vec<Value>)]) -> Result<u64> {
        let mut total: u64 = 0;
        for (sql, params) in stmts {
            total += self.conn.execute(sql, params.clone()).await?;
        }
        Ok(total)
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::LibsqlEngine;

    /// Open a fresh handle with the test's queue cap. Holding `write_lock`
    /// from the test parks the writer, which makes coalescing deterministic:
    /// everything submitted while parked lands in one round.
    async fn open(dir: &std::path::Path, write_queue_cap: usize) -> Arc<DbHandle> {
        let node = NodeEngine::new(
            Arc::new(LibsqlEngine),
            NodeConfig {
                data_dir: dir.to_path_buf(),
                write_queue_cap,
                ..Default::default()
            },
        );
        let file = node.db_file("ab-test", "main");
        node.handle("ab-test@main", &file).await.unwrap()
    }

    fn count(r: &QueryResult) -> i64 {
        r.rows[0][0].as_i64().unwrap()
    }

    async fn park_until_queued(h: &Arc<DbHandle>, n: usize) {
        while h.write_stats().queued < n {
            tokio::task::yield_now().await;
        }
    }

    #[tokio::test]
    async fn concurrent_writes_coalesce_into_one_round_sharing_txid() {
        let dir = tempfile::tempdir().unwrap();
        let h = open(dir.path(), 256).await;
        h.write_trusted("CREATE TABLE t (n INTEGER)", vec![])
            .await
            .unwrap();
        let before = h.write_stats();

        let gate = h.write_lock.lock().await;
        let mut joins = Vec::new();
        for i in 0..2 {
            let h = h.clone();
            joins.push(tokio::spawn(async move {
                let (n, txid) = h
                    .write_trusted("INSERT INTO t VALUES (?)", vec![Value::Integer(i)])
                    .await
                    .unwrap();
                assert_eq!(n, 1);
                txid
            }));
        }
        // A user-SQL batch coalesces into the same round as trusted writes.
        let user = {
            let h = h.clone();
            tokio::spawn(async move {
                let (results, txid) = h
                    .write_batch(&[Stmt {
                        q: "INSERT INTO t VALUES (99)".into(),
                        params: vec![],
                    }])
                    .await
                    .unwrap();
                assert_eq!(results[0].rows_affected, 1);
                txid
            })
        };
        park_until_queued(&h, 3).await;
        drop(gate);

        let mut txids = vec![user.await.unwrap()];
        for j in joins {
            txids.push(j.await.unwrap());
        }
        assert!(
            txids.iter().all(|t| *t == txids[0]),
            "round participants share the bumped txid: {txids:?}"
        );
        assert_eq!(h.txid(), txids[0]);
        let s = h.write_stats();
        assert_eq!(s.writes, before.writes + 3);
        assert_eq!(s.rounds, before.rounds + 1, "three writes, one commit");
        assert_eq!(s.shed, 0);
        let r = h.read("SELECT COUNT(*) FROM t", vec![]).await.unwrap();
        assert_eq!(count(&r), 3);
    }

    #[tokio::test]
    async fn failed_participant_rolls_back_alone() {
        let dir = tempfile::tempdir().unwrap();
        let h = open(dir.path(), 256).await;
        h.write_trusted("CREATE TABLE t (n INTEGER)", vec![])
            .await
            .unwrap();

        let gate = h.write_lock.lock().await;
        let good: Vec<_> = (0..2)
            .map(|i| {
                let h = h.clone();
                tokio::spawn(async move {
                    h.write_trusted("INSERT INTO t VALUES (?)", vec![Value::Integer(i)])
                        .await
                })
            })
            .collect();
        let bad = {
            let h = h.clone();
            tokio::spawn(async move {
                h.write_trusted("INSERT INTO missing VALUES (1)", vec![])
                    .await
            })
        };
        park_until_queued(&h, 3).await;
        drop(gate);

        let err = bad.await.unwrap().unwrap_err();
        assert!(
            err.to_string().contains("no such table"),
            "participant keeps its own error: {err}"
        );
        for j in good {
            let (n, _) = j.await.unwrap().unwrap();
            assert_eq!(n, 1, "good participants commit despite the bad one");
        }
        let r = h.read("SELECT COUNT(*) FROM t", vec![]).await.unwrap();
        assert_eq!(count(&r), 2);
    }

    #[tokio::test]
    async fn writes_shed_with_overloaded_past_queue_cap() {
        let dir = tempfile::tempdir().unwrap();
        let h = open(dir.path(), 1).await;
        h.write_trusted("CREATE TABLE t (n INTEGER)", vec![])
            .await
            .unwrap();

        let gate = h.write_lock.lock().await;
        let queued = {
            let h = h.clone();
            tokio::spawn(async move { h.write_trusted("INSERT INTO t VALUES (1)", vec![]).await })
        };
        park_until_queued(&h, 1).await;
        // Queue is at cap: the next write is shed immediately, no waiting.
        let res = h.write_trusted("INSERT INTO t VALUES (2)", vec![]).await;
        assert!(matches!(res, Err(EngineError::Overloaded(1))), "{res:?}");
        assert_eq!(h.write_stats().shed, 1);
        drop(gate);

        let (n, _) = queued.await.unwrap().unwrap();
        assert_eq!(n, 1, "the queued write still lands");
        let r = h.read("SELECT COUNT(*) FROM t", vec![]).await.unwrap();
        assert_eq!(count(&r), 1);
    }
}
