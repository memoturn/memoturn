//! Document collections (Mongo-style API on JSONB), vector collections, and
//! agent-memory primitives — all stored in reserved `__memoturn_*` tables of
//! the tenant's own database, so everything replicates/forks/rewinds as one
//! unit (ADR-0006, ADR-0007).

pub mod filter;
pub mod memories;
pub mod memory;
pub mod update;
pub mod vectors;

use memoturn_engine::{DbHandle, Value};
use serde_json::Value as Json;

#[derive(Debug, thiserror::Error)]
pub enum DocError {
    #[error("invalid collection name: {0}")]
    InvalidCollection(String),
    #[error("invalid filter: {0}")]
    InvalidFilter(String),
    #[error("invalid update: {0}")]
    InvalidUpdate(String),
    #[error("invalid document: {0}")]
    InvalidDocument(String),
    #[error(transparent)]
    Engine(#[from] memoturn_engine::EngineError),
}

pub type Result<T> = std::result::Result<T, DocError>;

pub fn collection_table(collection: &str) -> Result<String> {
    if collection.is_empty()
        || collection.len() > 64
        || !collection
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        return Err(DocError::InvalidCollection(collection.to_string()));
    }
    Ok(format!("__memoturn_docs_{}", collection.replace('-', "_")))
}

fn ensure_ddl(table: &str) -> String {
    format!(
        "CREATE TABLE IF NOT EXISTS \"{table}\" (
           id TEXT PRIMARY KEY,
           doc BLOB NOT NULL,
           created_at INTEGER NOT NULL,
           updated_at INTEGER NOT NULL
         ) WITHOUT ROWID"
    )
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Insert documents; missing `_id` is assigned. Returns (ids, txid).
pub async fn insert(h: &DbHandle, collection: &str, docs: Vec<Json>) -> Result<(Vec<String>, u64)> {
    let table = collection_table(collection)?;
    let mut stmts: Vec<(String, Vec<Value>)> = vec![(ensure_ddl(&table), vec![])];
    let mut ids = Vec::with_capacity(docs.len());
    for mut doc in docs {
        let Json::Object(ref mut map) = doc else {
            return Err(DocError::InvalidDocument(
                "documents must be objects".into(),
            ));
        };
        let id = match map.get("_id") {
            Some(Json::String(s)) => s.clone(),
            None => {
                let id = uuid::Uuid::new_v4().simple().to_string();
                map.insert("_id".into(), Json::String(id.clone()));
                id
            }
            Some(_) => return Err(DocError::InvalidDocument("_id must be a string".into())),
        };
        stmts.push((
            format!(
                "INSERT INTO \"{table}\" (id, doc, created_at, updated_at)
                 VALUES (?, jsonb(?), ?, ?)"
            ),
            vec![
                Value::Text(id.clone()),
                Value::Text(doc.to_string()),
                Value::Integer(now_ms()),
                Value::Integer(now_ms()),
            ],
        ));
        ids.push(id);
    }
    let (_, txid) = h.write_trusted_batch(&stmts).await?;
    Ok((ids, txid))
}

pub struct FindOpts {
    pub sort: Option<Json>,
    pub limit: u32,
    pub skip: u32,
}

impl Default for FindOpts {
    fn default() -> Self {
        Self {
            sort: None,
            limit: 100,
            skip: 0,
        }
    }
}

pub async fn find(
    h: &DbHandle,
    collection: &str,
    filter_json: &Json,
    opts: FindOpts,
) -> Result<Vec<Json>> {
    let table = collection_table(collection)?;
    let f = filter::compile(filter_json)?;
    let order = match &opts.sort {
        Some(s) => filter::compile_sort(s)?,
        None => String::new(),
    };
    let sql = format!(
        "SELECT json(doc) FROM \"{table}\" WHERE {}{} LIMIT {} OFFSET {}",
        f.where_sql, order, opts.limit, opts.skip
    );
    let r = match h.read_trusted(&sql, f.params).await {
        Ok(r) => r,
        // A collection that was never written to has no table: empty result.
        Err(memoturn_engine::EngineError::Sql(e)) if e.contains("no such table") => {
            return Ok(Vec::new())
        }
        Err(e) => return Err(e.into()),
    };
    Ok(r.rows
        .into_iter()
        .filter_map(|row| {
            row.into_iter()
                .next()
                .and_then(|v| v.as_str().and_then(|s| serde_json::from_str(s).ok()))
        })
        .collect())
}

/// Returns (modified count, txid).
pub async fn update_docs(
    h: &DbHandle,
    collection: &str,
    filter_json: &Json,
    update_json: &Json,
    multi: bool,
) -> Result<(u64, u64)> {
    let table = collection_table(collection)?;
    let (sql, params) = update::update_stmt(&table, filter_json, update_json, multi)?;
    match h.write_trusted(&sql, params).await {
        Ok((n, txid)) => Ok((n, txid)),
        Err(memoturn_engine::EngineError::Sql(e)) if e.contains("no such table") => {
            Ok((0, h.txid()))
        }
        Err(e) => Err(e.into()),
    }
}

/// Returns (deleted count, txid).
pub async fn delete_docs(
    h: &DbHandle,
    collection: &str,
    filter_json: &Json,
    multi: bool,
) -> Result<(u64, u64)> {
    let table = collection_table(collection)?;
    let f = filter::compile(filter_json)?;
    let limit = if multi { "" } else { " LIMIT 1" };
    let sql = format!(
        "DELETE FROM \"{table}\" WHERE id IN
           (SELECT id FROM \"{table}\" WHERE {}{limit})",
        f.where_sql
    );
    match h.write_trusted(&sql, f.params).await {
        Ok((n, txid)) => Ok((n, txid)),
        Err(memoturn_engine::EngineError::Sql(e)) if e.contains("no such table") => {
            Ok((0, h.txid()))
        }
        Err(e) => Err(e.into()),
    }
}

/// Expression index on a JSON path — indexed document queries become ordinary
/// B-tree lookups (the planner matches the `doc ->> '$.path'` expression).
pub async fn create_index(h: &DbHandle, collection: &str, path: &str) -> Result<()> {
    let table = collection_table(collection)?;
    if !path
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '.' || c == '-')
        || path.is_empty()
    {
        return Err(DocError::InvalidFilter(format!("bad index path: {path}")));
    }
    let idx = format!("{table}_ix_{}", path.replace(['.', '-'], "_"));
    let stmts = vec![
        (ensure_ddl(&table), vec![]),
        (
            format!("CREATE INDEX IF NOT EXISTS \"{idx}\" ON \"{table}\" (doc ->> '$.{path}')"),
            vec![],
        ),
    ];
    h.write_trusted_batch(&stmts).await?;
    Ok(())
}
