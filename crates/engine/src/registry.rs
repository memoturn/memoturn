use crate::value::Value;
use crate::{EngineConn, EngineError, Result, SqlEngine};
use serde::Serialize;
use std::path::Path;
use std::sync::Arc;

/// Node-local database catalog. Provisioning a database is one INSERT here —
/// no data-file I/O (the file materializes lazily on first use). In the full
/// system this is fed from the control-plane catalog; for the single-node
/// prototype it is authoritative.
pub struct Registry {
    conn: Arc<dyn EngineConn>,
}

#[derive(Debug, Clone, Serialize)]
pub struct DbRecord {
    pub name: String,
    pub uuid: String,
    pub created_at: i64,
}

impl Registry {
    pub async fn open(engine: &dyn SqlEngine, path: &Path) -> Result<Self> {
        let conn = engine.open(path).await?;
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS databases (
               name TEXT PRIMARY KEY,
               uuid TEXT NOT NULL,
               created_at INTEGER NOT NULL
             ) WITHOUT ROWID;
             CREATE TABLE IF NOT EXISTS branches (
               db_name TEXT NOT NULL,
               branch TEXT NOT NULL,
               ttl_at INTEGER,
               created_at INTEGER NOT NULL,
               PRIMARY KEY (db_name, branch)
             ) WITHOUT ROWID;",
        )
        .await?;
        Ok(Self { conn })
    }

    pub async fn create(&self, name: &str) -> Result<DbRecord> {
        self.create_with_uuid(name, &uuid::Uuid::new_v4().simple().to_string())
            .await
    }

    /// Register a database under a known uuid (control-plane catalog sync /
    /// node adoption of an existing database).
    pub async fn create_with_uuid(&self, name: &str, uuid: &str) -> Result<DbRecord> {
        let rec = DbRecord {
            name: name.to_string(),
            uuid: uuid.to_string(),
            created_at: now_ms(),
        };
        let inserted = self
            .conn
            .execute(
                "INSERT OR IGNORE INTO databases (name, uuid, created_at) VALUES (?, ?, ?)",
                vec![
                    Value::Text(rec.name.clone()),
                    Value::Text(rec.uuid.clone()),
                    Value::Integer(rec.created_at),
                ],
            )
            .await?;
        if inserted == 0 {
            return Err(EngineError::AlreadyExists(name.to_string()));
        }
        Ok(rec)
    }

    /// Create-if-absent (memory profiles auto-create on first ingest).
    pub async fn ensure(&self, name: &str) -> Result<DbRecord> {
        match self.create(name).await {
            Ok(rec) => Ok(rec),
            Err(EngineError::AlreadyExists(_)) => self.get(name).await,
            Err(e) => Err(e),
        }
    }

    /// Create-if-absent under a caller-chosen uuid. Used on the multi-node
    /// auto-create path where the canonical uuid is agreed through the shared
    /// catalog (see `LeaseManager::resolve_uuid`) before it reaches this
    /// node-local registry, so concurrent first-ingests do not diverge.
    pub async fn ensure_with_uuid(&self, name: &str, uuid: &str) -> Result<DbRecord> {
        match self.create_with_uuid(name, uuid).await {
            Ok(rec) => Ok(rec),
            Err(EngineError::AlreadyExists(_)) => self.get(name).await,
            Err(e) => Err(e),
        }
    }

    /// Databases whose name starts with `prefix` (namespace profile listing).
    pub async fn list_prefix(&self, prefix: &str) -> Result<Vec<DbRecord>> {
        let r = self
            .conn
            .query(
                "SELECT name, uuid, created_at FROM databases
                 WHERE name >= ? AND name < ? || x'ffff' ORDER BY name",
                vec![
                    Value::Text(prefix.to_string()),
                    Value::Text(prefix.to_string()),
                ],
            )
            .await?;
        Ok(r.rows
            .into_iter()
            .map(|row| DbRecord {
                name: row[0].as_str().unwrap_or_default().to_string(),
                uuid: row[1].as_str().unwrap_or_default().to_string(),
                created_at: row[2].as_i64().unwrap_or(0),
            })
            .collect())
    }

    pub async fn get(&self, name: &str) -> Result<DbRecord> {
        let r = self
            .conn
            .query(
                "SELECT name, uuid, created_at FROM databases WHERE name = ?",
                vec![Value::Text(name.to_string())],
            )
            .await?;
        let row = r
            .rows
            .first()
            .ok_or_else(|| EngineError::NotFound(name.to_string()))?;
        Ok(DbRecord {
            name: row[0].as_str().unwrap_or_default().to_string(),
            uuid: row[1].as_str().unwrap_or_default().to_string(),
            created_at: row[2].as_i64().unwrap_or(0),
        })
    }

    pub async fn list(&self) -> Result<Vec<DbRecord>> {
        let r = self
            .conn
            .query(
                "SELECT name, uuid, created_at FROM databases ORDER BY name",
                vec![],
            )
            .await?;
        Ok(r.rows
            .into_iter()
            .map(|row| DbRecord {
                name: row[0].as_str().unwrap_or_default().to_string(),
                uuid: row[1].as_str().unwrap_or_default().to_string(),
                created_at: row[2].as_i64().unwrap_or(0),
            })
            .collect())
    }

    /// Compact backup image of the catalog (`VACUUM INTO`) — page layout
    /// doesn't matter for the catalog, only contents. Used by the node to
    /// persist the prototype catalog to object storage (production keeps the
    /// catalog in the control plane).
    pub async fn backup_bytes(&self, scratch: &Path) -> Result<Vec<u8>> {
        std::fs::create_dir_all(scratch)?;
        let tmp = scratch.join(format!("catalog-{}.db", uuid::Uuid::new_v4().simple()));
        let _ = std::fs::remove_file(&tmp);
        self.conn
            .execute(
                "VACUUM INTO ?",
                vec![Value::Text(tmp.to_string_lossy().into_owned())],
            )
            .await?;
        let bytes = std::fs::read(&tmp)?;
        let _ = std::fs::remove_file(&tmp);
        Ok(bytes)
    }

    pub async fn delete(&self, name: &str) -> Result<DbRecord> {
        let rec = self.get(name).await?;
        self.conn
            .execute(
                "DELETE FROM databases WHERE name = ?",
                vec![Value::Text(name.to_string())],
            )
            .await?;
        self.conn
            .execute(
                "DELETE FROM branches WHERE db_name = ?",
                vec![Value::Text(name.to_string())],
            )
            .await?;
        Ok(rec)
    }

    // ---- branches ----
    // `main` exists implicitly for every database and has no row here.

    pub async fn create_branch(
        &self,
        db_name: &str,
        branch: &str,
        ttl_secs: Option<u64>,
    ) -> Result<BranchRecord> {
        let rec = BranchRecord {
            db_name: db_name.to_string(),
            branch: branch.to_string(),
            ttl_at: ttl_secs.map(|t| now_ms() + (t as i64) * 1000),
            created_at: now_ms(),
        };
        let inserted = self
            .conn
            .execute(
                "INSERT OR IGNORE INTO branches (db_name, branch, ttl_at, created_at)
                 VALUES (?, ?, ?, ?)",
                vec![
                    Value::Text(rec.db_name.clone()),
                    Value::Text(rec.branch.clone()),
                    rec.ttl_at.map(Value::Integer).unwrap_or(Value::Null),
                    Value::Integer(rec.created_at),
                ],
            )
            .await?;
        if inserted == 0 {
            return Err(EngineError::AlreadyExists(format!("{db_name}@{branch}")));
        }
        Ok(rec)
    }

    pub async fn branch_exists(&self, db_name: &str, branch: &str) -> Result<bool> {
        if branch == "main" {
            return Ok(true);
        }
        let r = self
            .conn
            .query(
                "SELECT 1 FROM branches WHERE db_name = ? AND branch = ?",
                vec![
                    Value::Text(db_name.to_string()),
                    Value::Text(branch.to_string()),
                ],
            )
            .await?;
        Ok(!r.rows.is_empty())
    }

    pub async fn list_branches(&self, db_name: &str) -> Result<Vec<BranchRecord>> {
        let r = self
            .conn
            .query(
                "SELECT db_name, branch, ttl_at, created_at FROM branches
                 WHERE db_name = ? ORDER BY branch",
                vec![Value::Text(db_name.to_string())],
            )
            .await?;
        Ok(r.rows.into_iter().map(row_to_branch).collect())
    }

    pub async fn delete_branch(&self, db_name: &str, branch: &str) -> Result<()> {
        self.conn
            .execute(
                "DELETE FROM branches WHERE db_name = ? AND branch = ?",
                vec![
                    Value::Text(db_name.to_string()),
                    Value::Text(branch.to_string()),
                ],
            )
            .await?;
        Ok(())
    }

    /// Burner branches whose TTL has passed (GC candidates).
    pub async fn expired_branches(&self) -> Result<Vec<BranchRecord>> {
        let r = self
            .conn
            .query(
                "SELECT db_name, branch, ttl_at, created_at FROM branches
                 WHERE ttl_at IS NOT NULL AND ttl_at <= ?",
                vec![Value::Integer(now_ms())],
            )
            .await?;
        Ok(r.rows.into_iter().map(row_to_branch).collect())
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct BranchRecord {
    pub db_name: String,
    pub branch: String,
    pub ttl_at: Option<i64>,
    pub created_at: i64,
}

fn row_to_branch(row: Vec<serde_json::Value>) -> BranchRecord {
    BranchRecord {
        db_name: row[0].as_str().unwrap_or_default().to_string(),
        branch: row[1].as_str().unwrap_or_default().to_string(),
        ttl_at: row[2].as_i64(),
        created_at: row[3].as_i64().unwrap_or(0),
    }
}

pub(crate) fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
