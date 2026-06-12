//! Memoturn storage engine: the `SqlEngine` abstraction, the libSQL adapter,
//! the per-node handle pool with temperature tiering, and the node-local
//! database registry.
//!
//! Invariant (see CLAUDE.md): no libSQL types escape this crate. Everything
//! upstream talks `Value`, `QueryResult`, `DbHandle`.

mod libsql_engine;
mod node;
mod registry;
mod value;
mod wal;

pub use libsql_engine::LibsqlEngine;
pub use node::{DbHandle, NodeConfig, NodeEngine, Stmt, WriteStats};
pub use registry::{BranchRecord, DbRecord, Registry};
pub use value::{QueryResult, Value};
pub use wal::{CaptureOutcome, WalCapture, WalCursor};

use async_trait::async_trait;
use std::path::Path;
use std::sync::Arc;

#[derive(Debug, thiserror::Error)]
pub enum EngineError {
    #[error("sql error: {0}")]
    Sql(String),
    #[error("database not found: {0}")]
    NotFound(String),
    #[error("database already exists: {0}")]
    AlreadyExists(String),
    #[error("reserved table access denied")]
    Reserved,
    /// Per-database write queue is full — the hot-profile backpressure
    /// signal (HTTP 429 + Retry-After upstream). Carries the queue depth.
    #[error("database write queue full ({0} writes pending); retry later")]
    Overloaded(usize),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
}

pub type Result<T> = std::result::Result<T, EngineError>;

mod sqlguard;
pub use sqlguard::is_read_only;

/// Guard user-supplied SQL before it runs against a per-database connection.
///
/// Rejects, via a lexical pass (so it sees real identifiers, not string
/// literals or concatenations):
///  - any identifier naming a reserved `__memoturn_*` table — these hold KV,
///    docs, and agent-memory bookkeeping that the typed APIs own;
///  - statements that escape the single-database sandbox: `ATTACH`, `VACUUM
///    INTO <file>`, and `PRAGMA writable_schema` (which would let a tenant edit
///    `sqlite_master` and reach the reserved tables anyway).
///
/// Read-only introspection such as `PRAGMA integrity_check` stays allowed. A
/// cheap substring pre-check keeps the common (clean) statement off the lexer.
pub fn guard_reserved(sql: &str) -> Result<()> {
    sqlguard::guard(sql)
}

/// A single open database connection pair. Implementations must support a
/// concurrent reader alongside the writer (WAL).
#[async_trait]
pub trait EngineConn: Send + Sync {
    /// Execute a non-returning statement on the writer connection; returns rows affected.
    async fn execute(&self, sql: &str, params: Vec<Value>) -> Result<u64>;
    /// Run a row-returning statement on the writer connection (sees open txn state).
    async fn query_writer(&self, sql: &str, params: Vec<Value>) -> Result<QueryResult>;
    /// Run a row-returning statement on the dedicated reader connection.
    async fn query(&self, sql: &str, params: Vec<Value>) -> Result<QueryResult>;
    /// Execute a batch of semicolon-separated statements (DDL/init paths only).
    async fn execute_batch(&self, sql: &str) -> Result<()>;
}

/// The engine seam: open a database file and get a connection pair.
/// v1 adapter is libSQL ([ADR-0001]); the trait exists so the engine can be
/// swapped per-database later without touching upstream crates.
#[async_trait]
pub trait SqlEngine: Send + Sync {
    async fn open(&self, path: &Path) -> Result<Arc<dyn EngineConn>>;
}
