//! Typed agent memory (ADR-0009, docs/architecture/07): fact/event/instruction/task
//! records with content-addressed idempotent ingest, supersession by
//! `(type, topic_key)`, and hybrid recall (FTS5 + topic + vector ANN merged by
//! reciprocal-rank fusion) — all inside the profile's own database.

use crate::vectors::vector_text;
use crate::{DocError, Result};
use memoturn_engine::{DbHandle, Value};
use serde_json::{json, Value as Json};
use sha2::{Digest, Sha256};

/// Base table is a rowid table (no WITHOUT ROWID) — the FTS5 external-content
/// index addresses rows by rowid.
const DDL: &[&str] = &[
    "CREATE TABLE IF NOT EXISTS __memoturn_memories (
       id TEXT NOT NULL UNIQUE,
       type TEXT NOT NULL CHECK (type IN ('fact','event','instruction','task')),
       topic_key TEXT,
       summary TEXT NOT NULL,
       content BLOB NOT NULL,
       keywords TEXT NOT NULL DEFAULT '',
       session_id TEXT,
       source TEXT,
       created_at INTEGER NOT NULL,
       expires_at INTEGER,
       superseded_by TEXT,
       superseded_at INTEGER
     )",
    "CREATE INDEX IF NOT EXISTS __memoturn_memories_active
       ON __memoturn_memories (type, topic_key) WHERE superseded_by IS NULL",
    "CREATE INDEX IF NOT EXISTS __memoturn_memories_session
       ON __memoturn_memories (session_id) WHERE session_id IS NOT NULL",
    // On a pre-`source` database this index is the first statement to fail,
    // which is what triggers the migrate-and-retry in `ingest`.
    "CREATE INDEX IF NOT EXISTS __memoturn_memories_source
       ON __memoturn_memories (source) WHERE source IS NOT NULL",
    "CREATE VIRTUAL TABLE IF NOT EXISTS __memoturn_memories_fts
       USING fts5(summary, keywords, content=__memoturn_memories, content_rowid=rowid)",
    "CREATE TABLE IF NOT EXISTS __memoturn_memory_sessions (
       id TEXT PRIMARY KEY,
       created_at INTEGER NOT NULL,
       last_active_at INTEGER NOT NULL
     ) WITHOUT ROWID",
];

const VEC_TABLE: &str = "__memoturn_memories_vec";
/// Default task-memory TTL; public so the API layer can clamp a defaulted TTL
/// against a governance policy cap (ADR-0010).
pub const DEFAULT_TASK_TTL_SECS: u64 = 86_400;
/// RRF rank constant (the standard 60) and per-channel weights.
const RRF_K: f64 = 60.0;
const W_TOPIC: f64 = 2.0;
const W_FTS: f64 = 1.0;
const W_VEC: f64 = 1.0;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum MemoryType {
    Fact,
    Event,
    Instruction,
    Task,
}

impl MemoryType {
    pub fn parse(s: &str) -> Result<Self> {
        match s {
            "fact" => Ok(Self::Fact),
            "event" => Ok(Self::Event),
            "instruction" => Ok(Self::Instruction),
            "task" => Ok(Self::Task),
            other => Err(DocError::InvalidDocument(format!(
                "unknown memory type: {other}"
            ))),
        }
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Fact => "fact",
            Self::Event => "event",
            Self::Instruction => "instruction",
            Self::Task => "task",
        }
    }

    /// Facts and instructions supersede prior active memories on the same topic.
    fn supersedes(&self) -> bool {
        matches!(self, Self::Fact | Self::Instruction)
    }
}

pub struct MemoryInput {
    pub mtype: MemoryType,
    pub topic_key: Option<String>,
    pub summary: String,
    pub content: Json,
    pub keywords: Option<String>,
    pub embedding: Option<Vec<f32>>,
    pub session_id: Option<String>,
    /// Originating agent ("claude-code", "cursor", …). Provenance, not
    /// identity: excluded from the content-addressed id, so the same memory
    /// from two agents dedupes and the first writer's source wins.
    pub source: Option<String>,
    pub ttl_secs: Option<u64>,
}

pub struct IngestOutcome {
    pub id: String,
    pub status: &'static str, // "created" | "duplicate"
    pub superseded: Vec<String>,
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Content-addressed memory id. Workspace serde_json uses sorted-key maps
/// (no `preserve_order`), so `content.to_string()` is canonical for equal
/// JSON values — pinned by `id_ignores_key_order` below.
pub fn memory_id(mtype: MemoryType, topic_key: Option<&str>, content: &Json) -> String {
    let mut hasher = Sha256::new();
    hasher.update(mtype.as_str().as_bytes());
    hasher.update([0]);
    hasher.update(topic_key.unwrap_or("").as_bytes());
    hasher.update([0]);
    hasher.update(content.to_string().as_bytes());
    let digest = hasher.finalize();
    let mut hex = String::with_capacity(36);
    hex.push_str("mem_");
    for b in &digest[..16] {
        hex.push_str(&format!("{b:02x}"));
    }
    hex
}

fn validate(item: &MemoryInput) -> Result<()> {
    if item.summary.trim().is_empty() {
        return Err(DocError::InvalidDocument(
            "memory summary must not be empty".into(),
        ));
    }
    if item.topic_key.is_some() && !item.mtype.supersedes() {
        return Err(DocError::InvalidDocument(
            "topic_key is only valid on fact/instruction memories".into(),
        ));
    }
    if matches!(&item.embedding, Some(e) if e.is_empty()) {
        return Err(DocError::InvalidDocument("empty embedding".into()));
    }
    if item.ttl_secs.is_some() && item.mtype != MemoryType::Task {
        return Err(DocError::InvalidDocument(
            "ttl is only valid on task memories".into(),
        ));
    }
    Ok(())
}

fn placeholders(n: usize) -> String {
    let mut s = String::with_capacity(n * 2);
    for i in 0..n {
        if i > 0 {
            s.push(',');
        }
        s.push('?');
    }
    s
}

/// State of a content-addressed id that already exists: whether it is
/// currently superseded (so a re-ingest can revive it rather than no-op).
async fn existing_meta(
    h: &DbHandle,
    ids: &[String],
) -> Result<std::collections::HashMap<String, bool>> {
    if ids.is_empty() {
        return Ok(std::collections::HashMap::new());
    }
    let sql = format!(
        "SELECT id, superseded_by IS NOT NULL FROM __memoturn_memories WHERE id IN ({})",
        placeholders(ids.len())
    );
    let params = ids.iter().map(|i| Value::Text(i.clone())).collect();
    match h.read_trusted(&sql, params).await {
        Ok(r) => Ok(r
            .rows
            .into_iter()
            .filter_map(|row| {
                let id = row.first()?.as_str()?.to_string();
                let superseded = row.get(1).and_then(|v| v.as_i64()).unwrap_or(0) != 0;
                Some((id, superseded))
            })
            .collect()),
        Err(memoturn_engine::EngineError::Sql(e)) if e.contains("no such table") => {
            Ok(std::collections::HashMap::new())
        }
        Err(e) => Err(e.into()),
    }
}

/// Dimension of the lazily-created vector table, if it exists. Parsed from the
/// stored DDL (`F32_BLOB(N)`) so ingest can skip embeddings that don't match
/// rather than failing the whole atomic batch on a dimension error.
async fn vec_table_dim(h: &DbHandle) -> Result<Option<usize>> {
    let r = h
        .read_trusted(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name=?",
            vec![Value::Text(VEC_TABLE.to_string())],
        )
        .await?;
    let Some(sql) = r
        .rows
        .first()
        .and_then(|row| row.first())
        .and_then(|v| v.as_str())
    else {
        return Ok(None);
    };
    Ok(sql
        .split_once("F32_BLOB(")
        .and_then(|(_, rest)| rest.split_once(')'))
        .and_then(|(n, _)| n.trim().parse::<usize>().ok()))
}

/// Active (non-superseded) memory id for one `(type, topic_key)`.
async fn active_for_topic(h: &DbHandle, mtype: MemoryType, topic_key: &str) -> Result<Vec<String>> {
    match h
        .read_trusted(
            "SELECT id FROM __memoturn_memories
             WHERE type = ? AND topic_key = ? AND superseded_by IS NULL",
            vec![
                Value::Text(mtype.as_str().to_string()),
                Value::Text(topic_key.to_string()),
            ],
        )
        .await
    {
        Ok(r) => Ok(r
            .rows
            .into_iter()
            .filter_map(|row| row.first().and_then(|v| v.as_str().map(String::from)))
            .collect()),
        Err(memoturn_engine::EngineError::Sql(e)) if e.contains("no such table") => Ok(Vec::new()),
        Err(e) => Err(e.into()),
    }
}

/// Ingest a batch atomically (one transaction, one txid). Idempotent: items
/// whose content-addressed id already exists are reported `duplicate` and
/// change nothing. Facts/instructions with a `topic_key` supersede the prior
/// active memory on that topic (history preserved, never deleted).
pub async fn ingest(h: &DbHandle, items: Vec<MemoryInput>) -> Result<(Vec<IngestOutcome>, u64)> {
    for item in &items {
        validate(item)?;
    }
    let ids: Vec<String> = items
        .iter()
        .map(|i| memory_id(i.mtype, i.topic_key.as_deref(), &i.content))
        .collect();
    let existing = existing_meta(h, &ids).await?;

    // The vector table is fixed at one dimension (its first embedding). Read it
    // up front so embeddings of a different dimension are skipped — keyword and
    // topic stay searchable — rather than failing the whole atomic batch.
    let mut target_dim: Option<usize> = vec_table_dim(h).await?;

    let now = now_ms();
    let mut stmts: Vec<(String, Vec<Value>)> =
        DDL.iter().map(|d| (d.to_string(), vec![])).collect();
    let mut outcomes: Vec<IngestOutcome> = Vec::with_capacity(items.len());
    let mut seen_in_batch: std::collections::HashSet<String> = std::collections::HashSet::new();
    // Last id made active per (type, topic_key) in this batch. Each new active
    // memory supersedes the previous active one; the first also supersedes the
    // DB's currently-active rows. Tracking the last keeps reporting O(n) and the
    // supersession reads to one per distinct topic.
    let mut last_active: std::collections::HashMap<(MemoryType, String), String> =
        std::collections::HashMap::new();

    for (item, id) in items.iter().zip(&ids) {
        let already = existing.get(id);
        let in_batch = !seen_in_batch.insert(id.clone());
        // True duplicate: the exact memory exists and is active (or was already
        // handled this batch). Re-asserting a *superseded* memory revives it.
        if in_batch || already == Some(&false) {
            outcomes.push(IngestOutcome {
                id: id.clone(),
                status: "duplicate",
                superseded: vec![],
            });
            continue;
        }
        let reviving = already == Some(&true);

        // Supersession targets for an active fact/instruction with a topic key.
        let mut superseded: Vec<String> = Vec::new();
        if let (true, Some(key)) = (item.mtype.supersedes(), &item.topic_key) {
            let topic = (item.mtype, key.clone());
            match last_active.get(&topic) {
                // A prior active item this batch already cleared the DB rows;
                // we only supersede that one.
                Some(prev) => superseded.push(prev.clone()),
                // First active item on this topic this batch — supersede whatever
                // the DB currently holds active (one read per distinct topic).
                None => superseded = active_for_topic(h, item.mtype, key).await?,
            }
            superseded.retain(|s| s != id);
            last_active.insert(topic, id.clone());
        }

        if reviving {
            // Row already exists (superseded). Clear its tombstone; the topic
            // UPDATE below supersedes the row that replaced it. No insert, and
            // its FTS row is already present (supersession never removes it).
            stmts.push((
                "UPDATE __memoturn_memories SET superseded_by = NULL, superseded_at = NULL
                 WHERE id = ?"
                    .into(),
                vec![Value::Text(id.clone())],
            ));
        } else {
            let expires_at = match item.mtype {
                MemoryType::Task => {
                    Some(now + (item.ttl_secs.unwrap_or(DEFAULT_TASK_TTL_SECS) as i64) * 1000)
                }
                _ => None,
            };
            stmts.push((
                "INSERT OR IGNORE INTO __memoturn_memories
                   (id, type, topic_key, summary, content, keywords, session_id,
                    source, created_at, expires_at)
                 VALUES (?, ?, ?, ?, jsonb(?), ?, ?, ?, ?, ?)"
                    .into(),
                vec![
                    Value::Text(id.clone()),
                    Value::Text(item.mtype.as_str().to_string()),
                    item.topic_key
                        .clone()
                        .map(Value::Text)
                        .unwrap_or(Value::Null),
                    Value::Text(item.summary.clone()),
                    Value::Text(item.content.to_string()),
                    Value::Text(item.keywords.clone().unwrap_or_default()),
                    item.session_id
                        .clone()
                        .map(Value::Text)
                        .unwrap_or(Value::Null),
                    item.source.clone().map(Value::Text).unwrap_or(Value::Null),
                    Value::Integer(now),
                    expires_at.map(Value::Integer).unwrap_or(Value::Null),
                ],
            ));
            // External-content FTS5 sync, gated on the base row having actually
            // been inserted (`changes() > 0`): a concurrent ingest of the same
            // content commits first, this batch's INSERT OR IGNORE no-ops, and
            // without the guard the FTS row would be inserted twice — corrupting
            // the index.
            stmts.push((
                "INSERT INTO __memoturn_memories_fts (rowid, summary, keywords)
                 SELECT rowid, summary, keywords FROM __memoturn_memories
                 WHERE id = ? AND (SELECT changes()) > 0"
                    .into(),
                vec![Value::Text(id.clone())],
            ));
        }
        if item.mtype.supersedes() {
            if let Some(key) = &item.topic_key {
                stmts.push((
                    "UPDATE __memoturn_memories
                     SET superseded_by = ?, superseded_at = ?
                     WHERE type = ? AND topic_key = ? AND superseded_by IS NULL AND id != ?"
                        .into(),
                    vec![
                        Value::Text(id.clone()),
                        Value::Integer(now),
                        Value::Text(item.mtype.as_str().to_string()),
                        Value::Text(key.clone()),
                        Value::Text(id.clone()),
                    ],
                ));
            }
        }
        // Tasks skip the vector channel; everything else may carry a BYO
        // embedding. Skip (don't fail) an embedding whose dimension doesn't
        // match the table's — a revived row's vector is already present.
        if item.mtype != MemoryType::Task && !reviving {
            if let Some(emb) = &item.embedding {
                let dim = *target_dim.get_or_insert(emb.len());
                if emb.len() == dim {
                    stmts.push((
                        format!(
                            "CREATE TABLE IF NOT EXISTS {VEC_TABLE} (id TEXT PRIMARY KEY, e F32_BLOB({dim}))"
                        ),
                        vec![],
                    ));
                    stmts.push((
                        format!(
                            "CREATE INDEX IF NOT EXISTS {VEC_TABLE}_ann ON {VEC_TABLE} (libsql_vector_idx(e))"
                        ),
                        vec![],
                    ));
                    stmts.push((
                        format!(
                            "INSERT INTO {VEC_TABLE} (id, e) VALUES (?, vector32(?))
                             ON CONFLICT(id) DO UPDATE SET e = excluded.e"
                        ),
                        vec![Value::Text(id.clone()), Value::Text(vector_text(emb))],
                    ));
                }
            }
        }
        if let Some(sid) = &item.session_id {
            stmts.push((
                "INSERT INTO __memoturn_memory_sessions (id, created_at, last_active_at)
                 VALUES (?, ?, ?)
                 ON CONFLICT(id) DO UPDATE SET last_active_at = excluded.last_active_at"
                    .into(),
                vec![
                    Value::Text(sid.clone()),
                    Value::Integer(now),
                    Value::Integer(now),
                ],
            ));
        }
        outcomes.push(IngestOutcome {
            id: id.clone(),
            status: if reviving { "revived" } else { "created" },
            superseded,
        });
    }

    let (_, txid) = match h.write_trusted_batch(&stmts).await {
        Ok(r) => r,
        // Pre-`source` database: the batch rolled back whole at the first
        // statement referencing the column. Add it and retry once — the
        // failed attempt changed nothing.
        Err(memoturn_engine::EngineError::Sql(e)) if missing_source_column(&e) => {
            migrate_source_column(h).await?;
            h.write_trusted_batch(&stmts).await?
        }
        Err(e) => return Err(e.into()),
    };
    Ok((outcomes, txid))
}

/// SQLite's two spellings for a reference to a column the table doesn't have,
/// narrowed to `source` so genuine SQL bugs still surface.
fn missing_source_column(e: &str) -> bool {
    (e.contains("no such column") || e.contains("has no column named")) && e.contains("source")
}

/// Add the `source` column to a pre-`source` database. Stateless by design:
/// branch rewind can resurrect the old schema at any time, so migration must
/// key off the error, never off cached state. Tolerates a concurrent racer.
async fn migrate_source_column(h: &DbHandle) -> Result<()> {
    match h
        .write_trusted(
            "ALTER TABLE __memoturn_memories ADD COLUMN source TEXT",
            vec![],
        )
        .await
    {
        Ok(_) => Ok(()),
        Err(memoturn_engine::EngineError::Sql(e)) if e.contains("duplicate column") => Ok(()),
        Err(e) => Err(e.into()),
    }
}

pub struct RecallQuery {
    pub query: Option<String>,
    pub embedding: Option<Vec<f32>>,
    pub topic_key: Option<String>,
    pub types: Option<Vec<MemoryType>>,
    pub session_id: Option<String>,
    pub source: Option<String>,
    pub k: u32,
    pub include_superseded: bool,
}

/// Turn free text into an FTS5 OR-query of quoted tokens — natural-language
/// questions must never be parsed as FTS5 syntax.
pub(crate) fn fts_query(text: &str) -> Option<String> {
    let tokens: Vec<String> = text
        .split(|c: char| !c.is_alphanumeric())
        .filter(|t| !t.is_empty())
        .map(|t| format!("\"{t}\""))
        .collect();
    if tokens.is_empty() {
        None
    } else {
        Some(tokens.join(" OR "))
    }
}

/// Reciprocal-rank fusion over ranked id lists. Returns (id, score, channels)
/// ordered by score descending; input order breaks ties (callers pass the
/// topic channel first).
pub(crate) fn rrf_merge(
    channels: &[(&'static str, f64, Vec<String>)],
) -> Vec<(String, f64, Vec<&'static str>)> {
    let mut order: Vec<String> = Vec::new();
    let mut scores: std::collections::HashMap<String, (f64, Vec<&'static str>)> =
        std::collections::HashMap::new();
    for (name, weight, ids) in channels {
        for (rank, id) in ids.iter().enumerate() {
            let entry = scores.entry(id.clone()).or_insert_with(|| {
                order.push(id.clone());
                (0.0, Vec::new())
            });
            entry.0 += weight / (RRF_K + rank as f64 + 1.0);
            entry.1.push(name);
        }
    }
    let mut out: Vec<(String, f64, Vec<&'static str>)> = order
        .into_iter()
        .map(|id| {
            let (score, chans) = scores.remove(&id).unwrap_or((0.0, vec![]));
            (id, score, chans)
        })
        .collect();
    out.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    out
}

fn empty_on_missing(e: memoturn_engine::EngineError) -> Result<Vec<String>> {
    match e {
        // A pre-`source` database holds no sourced rows, so a source-filtered
        // channel is correctly empty — reads never migrate.
        memoturn_engine::EngineError::Sql(s)
            if s.contains("no such table")
                || s.contains("no such index")
                || missing_source_column(&s) =>
        {
            Ok(Vec::new())
        }
        e => Err(e.into()),
    }
}

/// SQL `AND` fragment (+ params) applying the recall filters inside each channel
/// query, so wanted rows aren't starved out of the fixed candidate window by
/// higher-ranked rows of the wrong type/session/supersession (the alias is the
/// base-table name the channel joins to).
fn channel_filter(q: &RecallQuery, alias: &str) -> (String, Vec<Value>) {
    let mut sql = String::new();
    let mut params: Vec<Value> = Vec::new();
    if !q.include_superseded {
        sql.push_str(&format!(" AND {alias}.superseded_by IS NULL"));
    }
    sql.push_str(&format!(
        " AND ({alias}.expires_at IS NULL OR {alias}.expires_at > ?)"
    ));
    params.push(Value::Integer(now_ms()));
    if let Some(types) = &q.types {
        if types.is_empty() {
            // An explicit empty type list matches nothing.
            sql.push_str(" AND 0");
        } else {
            sql.push_str(&format!(
                " AND {alias}.type IN ({})",
                placeholders(types.len())
            ));
            params.extend(types.iter().map(|t| Value::Text(t.as_str().to_string())));
        }
    }
    if let Some(sid) = &q.session_id {
        sql.push_str(&format!(" AND {alias}.session_id = ?"));
        params.push(Value::Text(sid.clone()));
    }
    if let Some(src) = &q.source {
        sql.push_str(&format!(" AND {alias}.source = ?"));
        params.push(Value::Text(src.clone()));
    }
    (sql, params)
}

fn first_col_ids(r: memoturn_engine::QueryResult) -> Vec<String> {
    r.rows
        .into_iter()
        .filter_map(|row| row.first().and_then(|v| v.as_str().map(String::from)))
        .collect()
}

/// Hybrid recall: topic lookup + FTS5 keywords + vector ANN, RRF-merged, then
/// superseded/expired rows and type/session filters applied. Returns ranked
/// memory JSON objects (empty is a valid answer — recall never pads).
pub async fn recall(h: &DbHandle, q: &RecallQuery) -> Result<Vec<Json>> {
    if q.query.is_none() && q.embedding.is_none() && q.topic_key.is_none() {
        return Err(DocError::InvalidDocument(
            "recall requires at least one of query, embedding, topic_key".into(),
        ));
    }
    if matches!(&q.embedding, Some(e) if e.is_empty()) {
        return Err(DocError::InvalidDocument("empty embedding".into()));
    }
    let fetch = (q.k.max(1) as i64) * 5;
    let mut channels: Vec<(&'static str, f64, Vec<String>)> = Vec::new();

    if let Some(key) = &q.topic_key {
        let (filter, fparams) = channel_filter(q, "__memoturn_memories");
        let mut params = vec![Value::Text(key.clone())];
        params.extend(fparams);
        params.push(Value::Integer(fetch));
        let ids = match h
            .read_trusted(
                &format!(
                    "SELECT id FROM __memoturn_memories WHERE topic_key = ?{filter}
                     ORDER BY created_at DESC LIMIT ?"
                ),
                params,
            )
            .await
        {
            Ok(r) => first_col_ids(r),
            Err(e) => empty_on_missing(e)?,
        };
        channels.push(("topic", W_TOPIC, ids));
    }

    if let Some(text) = q.query.as_deref().and_then(fts_query) {
        let (filter, fparams) = channel_filter(q, "m");
        let mut params = vec![Value::Text(text)];
        params.extend(fparams);
        params.push(Value::Integer(fetch));
        let ids = match h
            .read_trusted(
                &format!(
                    "SELECT m.id FROM __memoturn_memories_fts f
                     JOIN __memoturn_memories m ON m.rowid = f.rowid
                     WHERE __memoturn_memories_fts MATCH ?{filter}
                     ORDER BY bm25(__memoturn_memories_fts) LIMIT ?"
                ),
                params,
            )
            .await
        {
            Ok(r) => first_col_ids(r),
            Err(e) => empty_on_missing(e)?,
        };
        channels.push(("keyword", W_FTS, ids));
    }

    if let Some(emb) = &q.embedding {
        let qv = Value::Text(vector_text(emb));
        let (filter, fparams) = channel_filter(q, "v");
        // Over-fetch from ANN before filtering so the post-filter pool isn't
        // starved; vector_top_k itself can't see the predicates.
        let mut params = vec![qv.clone(), Value::Integer(fetch * 4)];
        params.extend(fparams);
        params.push(qv);
        params.push(Value::Integer(fetch));
        let ids = match h
            .read_trusted(
                &format!(
                    "SELECT v.id FROM vector_top_k('{VEC_TABLE}_ann', vector32(?), ?) tk
                     JOIN {VEC_TABLE} ve ON ve.rowid = tk.id
                     JOIN __memoturn_memories v ON v.id = ve.id
                     WHERE 1=1{filter}
                     ORDER BY vector_distance_cos(ve.e, vector32(?)) LIMIT ?"
                ),
                params,
            )
            // Vector is a best-effort channel: a missing table/index OR a
            // query-vs-stored dimension mismatch degrades recall to
            // keyword+topic rather than failing the whole request.
            .await
        {
            Ok(r) => first_col_ids(r),
            Err(memoturn_engine::EngineError::Sql(s))
                if s.contains("no such table")
                    || s.contains("no such index")
                    || s.contains("dimension")
                    || s.contains("F32_BLOB")
                    || s.contains("vector")
                    || missing_source_column(&s) =>
            {
                Vec::new()
            }
            Err(e) => return Err(e.into()),
        };
        channels.push(("vector", W_VEC, ids));
    }

    let merged = rrf_merge(&channels);
    if merged.is_empty() {
        return Ok(Vec::new());
    }

    let ids: Vec<String> = merged.iter().map(|(id, _, _)| id.clone()).collect();
    // `source` last so no pre-existing row index shifts; on a pre-`source`
    // database retry without it (reads never migrate) — the shorter row
    // serializes the field as null via `row.get`.
    let sql = format!(
        "SELECT id, type, topic_key, summary, json(content), keywords, session_id,
                created_at, expires_at, superseded_by, source
         FROM __memoturn_memories WHERE id IN ({})",
        placeholders(ids.len())
    );
    let id_params = || ids.iter().map(|i| Value::Text(i.clone())).collect();
    let rows = match h.read_trusted(&sql, id_params()).await {
        Ok(r) => r,
        Err(memoturn_engine::EngineError::Sql(e)) if missing_source_column(&e) => {
            h.read_trusted(
                &format!(
                    "SELECT id, type, topic_key, summary, json(content), keywords, session_id,
                            created_at, expires_at, superseded_by
                     FROM __memoturn_memories WHERE id IN ({})",
                    placeholders(ids.len())
                ),
                id_params(),
            )
            .await?
        }
        Err(e) => return Err(e.into()),
    };
    let mut by_id: std::collections::HashMap<String, Vec<Json>> = rows
        .rows
        .into_iter()
        .filter_map(|row| {
            row.first()
                .and_then(|v| v.as_str().map(String::from))
                .map(|id| (id, row))
        })
        .collect();

    let now = now_ms();
    let mut out = Vec::new();
    for (id, score, chans) in merged {
        let Some(row) = by_id.remove(&id) else {
            continue;
        };
        let superseded_by = row[9].as_str();
        if superseded_by.is_some() && !q.include_superseded {
            continue;
        }
        if let Some(exp) = row[8].as_i64() {
            if exp <= now {
                continue;
            }
        }
        if let Some(types) = &q.types {
            let t = row[1].as_str().and_then(|s| MemoryType::parse(s).ok());
            if !t.map(|t| types.contains(&t)).unwrap_or(false) {
                continue;
            }
        }
        if let Some(sid) = &q.session_id {
            if row[6].as_str() != Some(sid.as_str()) {
                continue;
            }
        }
        if let Some(src) = &q.source {
            if row.get(10).and_then(|v| v.as_str()) != Some(src.as_str()) {
                continue;
            }
        }
        out.push(json!({
            "id": row[0],
            "type": row[1],
            "topic_key": row[2],
            "summary": row[3],
            "content": row[4]
                .as_str()
                .and_then(|s| serde_json::from_str::<Json>(s).ok())
                .unwrap_or(Json::Null),
            "keywords": row[5],
            "session_id": row[6],
            "source": row.get(10).cloned().unwrap_or(Json::Null),
            "created_at": row[7],
            "superseded_by": row[9],
            "score": score,
            "channels": chans,
        }));
        if out.len() as u32 >= q.k.max(1) {
            break;
        }
    }
    Ok(out)
}

/// One memory by id, with its supersession chain: `superseded_by` (what
/// replaced it) and `supersedes` (the ids it replaced).
pub async fn get(h: &DbHandle, id: &str) -> Result<Option<Json>> {
    let r = match h
        .read_trusted(
            "SELECT id, type, topic_key, summary, json(content), keywords, session_id,
                    created_at, expires_at, superseded_by, superseded_at, source
             FROM __memoturn_memories WHERE id = ?",
            vec![Value::Text(id.to_string())],
        )
        .await
    {
        Ok(r) => r,
        Err(memoturn_engine::EngineError::Sql(e)) if e.contains("no such table") => {
            return Ok(None)
        }
        // Pre-`source` database: retry without the column (reads never
        // migrate); `row.get` below serializes the field as null.
        Err(memoturn_engine::EngineError::Sql(e)) if missing_source_column(&e) => {
            h.read_trusted(
                "SELECT id, type, topic_key, summary, json(content), keywords, session_id,
                        created_at, expires_at, superseded_by, superseded_at
                 FROM __memoturn_memories WHERE id = ?",
                vec![Value::Text(id.to_string())],
            )
            .await?
        }
        Err(e) => return Err(e.into()),
    };
    let Some(row) = r.rows.into_iter().next() else {
        return Ok(None);
    };
    let supersedes = h
        .read_trusted(
            "SELECT id FROM __memoturn_memories WHERE superseded_by = ?",
            vec![Value::Text(id.to_string())],
        )
        .await
        .map(first_col_ids)
        .unwrap_or_default();
    Ok(Some(json!({
        "id": row[0],
        "type": row[1],
        "topic_key": row[2],
        "summary": row[3],
        "content": row[4]
            .as_str()
            .and_then(|s| serde_json::from_str::<Json>(s).ok())
            .unwrap_or(Json::Null),
        "keywords": row[5],
        "session_id": row[6],
        "source": row.get(11).cloned().unwrap_or(Json::Null),
        "created_at": row[7],
        "expires_at": row[8],
        "superseded_by": row[9],
        "superseded_at": row[10],
        "supersedes": supersedes,
    })))
}

/// Hard-delete one memory (forget): FTS5 'delete' first (needs the row's
/// values), then base + vector rows. Returns (rows deleted, txid) — 0 when the
/// row was already gone (including a concurrent delete after the pre-check).
pub async fn forget(h: &DbHandle, id: &str) -> Result<(u64, u64)> {
    // Vector row first, tolerant of the table never having been created —
    // separate write because a missing table would abort the atomic batch.
    match h
        .write_trusted(
            &format!("DELETE FROM {VEC_TABLE} WHERE id = ?"),
            vec![Value::Text(id.to_string())],
        )
        .await
    {
        Ok(_) => {}
        Err(memoturn_engine::EngineError::Sql(e)) if e.contains("no such table") => {}
        Err(e) => return Err(e.into()),
    }
    let stmts = vec![
        (
            "INSERT INTO __memoturn_memories_fts (__memoturn_memories_fts, rowid, summary, keywords)
             SELECT 'delete', rowid, summary, keywords FROM __memoturn_memories WHERE id = ?"
                .to_string(),
            vec![Value::Text(id.to_string())],
        ),
        (
            "DELETE FROM __memoturn_memories WHERE id = ?".to_string(),
            vec![Value::Text(id.to_string())],
        ),
    ];
    match h.write_trusted_batch(&stmts).await {
        // Any change means the row existed when the batch ran (both the FTS
        // 'delete' SELECT and the base DELETE find nothing once it's gone, so a
        // concurrent delete yields 0). Report a clean 1/0 without relying on the
        // exact FTS 'delete' change count.
        Ok((n, txid)) => Ok((u64::from(n > 0), txid)),
        Err(memoturn_engine::EngineError::Sql(e)) if e.contains("no such table") => {
            Ok((0, h.txid()))
        }
        Err(e) => Err(e.into()),
    }
}

/// Hard-delete an entire topic — the active row and its whole supersession
/// chain (erasure path, ADR-0010). Returns the ids removed and the txid.
/// The deletes re-check the topic condition inside the atomic batch, so a
/// row revived between the id read and the delete is handled consistently.
pub async fn forget_topic(
    h: &DbHandle,
    mtype: MemoryType,
    key: &str,
) -> Result<(Vec<String>, u64)> {
    let cond = "type = ? AND topic_key = ?";
    let params = vec![
        Value::Text(mtype.as_str().to_string()),
        Value::Text(key.to_string()),
    ];
    let ids: Vec<String> = match h
        .read_trusted(
            &format!("SELECT id FROM __memoturn_memories WHERE {cond}"),
            params.clone(),
        )
        .await
    {
        Ok(r) => r
            .rows
            .into_iter()
            .filter_map(|row| row.first().and_then(|v| v.as_str().map(str::to_string)))
            .collect(),
        Err(memoturn_engine::EngineError::Sql(e)) if e.contains("no such table") => Vec::new(),
        Err(e) => return Err(e.into()),
    };
    if ids.is_empty() {
        return Ok((Vec::new(), h.txid()));
    }
    // Vector rows first, tolerant of the table never having been created
    // (same posture as `forget`).
    match h
        .write_trusted(
            &format!(
                "DELETE FROM {VEC_TABLE} WHERE id IN
                   (SELECT id FROM __memoturn_memories WHERE {cond})"
            ),
            params.clone(),
        )
        .await
    {
        Ok(_) => {}
        Err(memoturn_engine::EngineError::Sql(e)) if e.contains("no such table") => {}
        Err(e) => return Err(e.into()),
    }
    let stmts = vec![
        (
            format!(
                "INSERT INTO __memoturn_memories_fts (__memoturn_memories_fts, rowid, summary, keywords)
                 SELECT 'delete', rowid, summary, keywords FROM __memoturn_memories WHERE {cond}"
            ),
            params.clone(),
        ),
        (
            format!("DELETE FROM __memoturn_memories WHERE {cond}"),
            params,
        ),
    ];
    match h.write_trusted_batch(&stmts).await {
        Ok((_, txid)) => Ok((ids, txid)),
        Err(memoturn_engine::EngineError::Sql(e)) if e.contains("no such table") => {
            Ok((Vec::new(), h.txid()))
        }
        Err(e) => Err(e.into()),
    }
}

/// Sessions seen by ingest, most recently active first.
pub async fn list_sessions(h: &DbHandle, limit: u32) -> Result<Vec<Json>> {
    let r = match h
        .read_trusted(
            "SELECT id, created_at, last_active_at FROM __memoturn_memory_sessions
             ORDER BY last_active_at DESC LIMIT ?",
            vec![Value::Integer(limit as i64)],
        )
        .await
    {
        Ok(r) => r,
        Err(memoturn_engine::EngineError::Sql(e)) if e.contains("no such table") => {
            return Ok(Vec::new())
        }
        Err(e) => return Err(e.into()),
    };
    Ok(r.rows
        .into_iter()
        .map(|row| json!({ "id": row[0], "created_at": row[1], "last_active_at": row[2] }))
        .collect())
}

/// End a session: delete its task memories (durable memories survive their
/// session). Tasks carry no vectors, so only base + FTS rows go.
pub async fn end_session(h: &DbHandle, session: &str) -> Result<u64> {
    let stmts = vec![
        (
            "INSERT INTO __memoturn_memories_fts (__memoturn_memories_fts, rowid, summary, keywords)
             SELECT 'delete', rowid, summary, keywords FROM __memoturn_memories
             WHERE session_id = ? AND type = 'task'"
                .to_string(),
            vec![Value::Text(session.to_string())],
        ),
        (
            "DELETE FROM __memoturn_memories WHERE session_id = ? AND type = 'task'".to_string(),
            vec![Value::Text(session.to_string())],
        ),
        (
            "DELETE FROM __memoturn_memory_sessions WHERE id = ?".to_string(),
            vec![Value::Text(session.to_string())],
        ),
    ];
    match h.write_trusted_batch(&stmts).await {
        Ok((_, txid)) => Ok(txid),
        Err(memoturn_engine::EngineError::Sql(e)) if e.contains("no such table") => Ok(h.txid()),
        Err(e) => Err(e.into()),
    }
}

/// Sweep expired task memories (node maintenance loop, hot DBs only — same
/// contract as `kv::sweep_expired`).
pub async fn sweep_expired(h: &DbHandle) -> Result<u64> {
    let now = now_ms();
    let stmts = vec![
        (
            "INSERT INTO __memoturn_memories_fts (__memoturn_memories_fts, rowid, summary, keywords)
             SELECT 'delete', rowid, summary, keywords FROM __memoturn_memories
             WHERE expires_at IS NOT NULL AND expires_at <= ?"
                .to_string(),
            vec![Value::Integer(now)],
        ),
        (
            "DELETE FROM __memoturn_memories WHERE expires_at IS NOT NULL AND expires_at <= ?"
                .to_string(),
            vec![Value::Integer(now)],
        ),
    ];
    match h.write_trusted_batch(&stmts).await {
        Ok((n, _)) => Ok(n / 2),
        Err(memoturn_engine::EngineError::Sql(e)) if e.contains("no such table") => Ok(0),
        Err(e) => Err(e.into()),
    }
}

/// Governance memory-age rules (ADR-0010), resolved from the namespace policy
/// by the API layer. `None` = unbounded (today's behavior).
#[derive(Debug, Clone, Default)]
pub struct MemoryRules {
    /// Delete events older than this.
    pub event_max_age_secs: Option<u64>,
    /// Delete superseded rows older than this.
    pub superseded_max_age_secs: Option<u64>,
    /// Per `(type, topic_key)`, keep at most this many superseded rows.
    pub superseded_max_count: Option<u64>,
}

impl MemoryRules {
    pub fn any(&self) -> bool {
        self.event_max_age_secs.is_some()
            || self.superseded_max_age_secs.is_some()
            || self.superseded_max_count.is_some()
    }
}

/// Deletions per maintenance pass. These deletes are writes (they ship
/// segments), so each pass is bounded; the next pass continues the backlog.
const POLICY_SWEEP_LIMIT: i64 = 500;

/// Delete memories the namespace policy has aged out: superseded rows past an
/// age or per-topic count cap, and events past their max age. Runs on the
/// writer like `sweep_expired`. Unlike the task sweep, superseded facts and
/// events carry vectors, so the vector rows go too.
pub async fn enforce_memory_policy(h: &DbHandle, rules: &MemoryRules) -> Result<u64> {
    let now = now_ms();
    let mut conds: Vec<String> = Vec::new();
    let mut params: Vec<Value> = Vec::new();
    if let Some(age) = rules.superseded_max_age_secs {
        conds.push("(m.superseded_at IS NOT NULL AND m.superseded_at <= ?)".into());
        params.push(Value::Integer(now - (age as i64) * 1000));
    }
    if let Some(cnt) = rules.superseded_max_count {
        // Doomed iff at least `cnt` superseded rows on the same topic are
        // newer (rowid tiebreak keeps the ranking total).
        conds.push(
            "(m.superseded_by IS NOT NULL AND (
                SELECT COUNT(*) FROM __memoturn_memories n
                WHERE n.type = m.type AND n.topic_key = m.topic_key
                  AND n.superseded_by IS NOT NULL
                  AND (n.superseded_at > m.superseded_at
                       OR (n.superseded_at = m.superseded_at AND n.rowid > m.rowid))
             ) >= ?)"
                .into(),
        );
        params.push(Value::Integer(cnt as i64));
    }
    if let Some(age) = rules.event_max_age_secs {
        conds.push("(m.type = 'event' AND m.created_at <= ?)".into());
        params.push(Value::Integer(now - (age as i64) * 1000));
    }
    if conds.is_empty() {
        return Ok(0);
    }
    // Deterministic doomed set: repeated verbatim in every statement of the
    // atomic batch, so the FTS 'delete' (which needs the rows still present)
    // and the base DELETE cover exactly the same rows.
    let doomed = format!(
        "SELECT m.rowid FROM __memoturn_memories m WHERE {} ORDER BY m.rowid LIMIT {POLICY_SWEEP_LIMIT}",
        conds.join(" OR ")
    );

    // Vector rows first, as a separate write tolerant of the table never
    // having been created (same posture as `forget`).
    match h
        .write_trusted(
            &format!(
                "DELETE FROM {VEC_TABLE} WHERE id IN
                   (SELECT id FROM __memoturn_memories WHERE rowid IN ({doomed}))"
            ),
            params.clone(),
        )
        .await
    {
        Ok(_) => {}
        Err(memoturn_engine::EngineError::Sql(e)) if e.contains("no such table") => {}
        Err(e) => return Err(e.into()),
    }

    let stmts = vec![
        (
            format!(
                "INSERT INTO __memoturn_memories_fts (__memoturn_memories_fts, rowid, summary, keywords)
                 SELECT 'delete', rowid, summary, keywords FROM __memoturn_memories
                 WHERE rowid IN ({doomed})"
            ),
            params.clone(),
        ),
        (
            format!("DELETE FROM __memoturn_memories WHERE rowid IN ({doomed})"),
            params,
        ),
    ];
    match h.write_trusted_batch(&stmts).await {
        Ok((n, _)) => Ok(n / 2),
        Err(memoturn_engine::EngineError::Sql(e)) if e.contains("no such table") => Ok(0),
        Err(e) => Err(e.into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn id_is_stable_and_content_addressed() {
        let a = memory_id(MemoryType::Fact, Some("user.theme"), &json!({"v": "dark"}));
        let b = memory_id(MemoryType::Fact, Some("user.theme"), &json!({"v": "dark"}));
        assert_eq!(a, b);
        assert!(a.starts_with("mem_"));
        assert_eq!(a.len(), 36);
        let c = memory_id(MemoryType::Fact, Some("user.theme"), &json!({"v": "light"}));
        assert_ne!(a, c);
        let d = memory_id(MemoryType::Event, Some("user.theme"), &json!({"v": "dark"}));
        assert_ne!(a, d);
        let e = memory_id(MemoryType::Fact, None, &json!({"v": "dark"}));
        assert_ne!(a, e);
    }

    #[test]
    fn id_ignores_key_order() {
        // Pins the canonicality assumption: workspace serde_json must keep
        // sorted-key maps (no preserve_order feature).
        let a: Json = serde_json::from_str(r#"{"b": 1, "a": 2}"#).unwrap();
        let b: Json = serde_json::from_str(r#"{"a": 2, "b": 1}"#).unwrap();
        assert_eq!(
            memory_id(MemoryType::Fact, None, &a),
            memory_id(MemoryType::Fact, None, &b)
        );
    }

    #[test]
    fn fts_query_quotes_and_ors_tokens() {
        assert_eq!(
            fts_query("what theme does the \"user\" like?").as_deref(),
            Some("\"what\" OR \"theme\" OR \"does\" OR \"the\" OR \"user\" OR \"like\"")
        );
        assert_eq!(fts_query("  ?!  "), None);
        // FTS5 operators arrive as plain quoted tokens, never syntax.
        assert_eq!(
            fts_query("NOT (refund)").as_deref(),
            Some("\"NOT\" OR \"refund\"")
        );
    }

    #[test]
    fn rrf_merge_ranks_and_attributes_channels() {
        let merged = rrf_merge(&[
            ("topic", W_TOPIC, vec!["a".into()]),
            ("keyword", W_FTS, vec!["b".into(), "a".into()]),
            ("vector", W_VEC, vec!["c".into(), "b".into()]),
        ]);
        let ids: Vec<&str> = merged.iter().map(|(id, _, _)| id.as_str()).collect();
        // a: 2/61 + 1/62 ≈ 0.0489 ; b: 1/61 + 1/62 ≈ 0.0325 ; c: 1/61 ≈ 0.0164
        assert_eq!(ids, vec!["a", "b", "c"]);
        assert_eq!(merged[0].2, vec!["topic", "keyword"]);
        assert!(merged[0].1 > merged[1].1 && merged[1].1 > merged[2].1);
    }

    #[test]
    fn rrf_merge_empty() {
        assert!(rrf_merge(&[]).is_empty());
        assert!(rrf_merge(&[("keyword", 1.0, vec![])]).is_empty());
    }

    #[test]
    fn validate_rejects_bad_inputs() {
        let base = || MemoryInput {
            mtype: MemoryType::Fact,
            topic_key: None,
            summary: "s".into(),
            content: json!({}),
            keywords: None,
            embedding: None,
            session_id: None,
            source: None,
            ttl_secs: None,
        };
        assert!(validate(&base()).is_ok());
        let mut m = base();
        m.summary = "  ".into();
        assert!(validate(&m).is_err());
        let mut m = base();
        m.mtype = MemoryType::Event;
        m.topic_key = Some("k".into());
        assert!(validate(&m).is_err());
        let mut m = base();
        m.embedding = Some(vec![]);
        assert!(validate(&m).is_err());
        let mut m = base();
        m.ttl_secs = Some(60);
        assert!(validate(&m).is_err());
        let mut m = base();
        m.mtype = MemoryType::Task;
        m.ttl_secs = Some(60);
        assert!(validate(&m).is_ok());
    }
}
