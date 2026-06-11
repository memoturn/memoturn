//! Agent-memory primitives: conversation turns with optional embeddings,
//! window reads, and semantic search — first-class API, not user-assembled
//! SQL (docs/architecture/04).

use crate::vectors::vector_text;
use crate::{DocError, Result};
use memoturn_engine::{DbHandle, Value};
use serde_json::{json, Value as Json};

const DDL: &str = "
CREATE TABLE IF NOT EXISTS __memoturn_messages (
  session_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  role TEXT NOT NULL,
  content BLOB NOT NULL,
  embedding BLOB,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, seq)
) WITHOUT ROWID;
";

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Append one turn; returns (seq, txid).
pub async fn append_turn(
    h: &DbHandle,
    session: &str,
    role: &str,
    content: &Json,
    embedding: Option<&[f32]>,
) -> Result<(u64, u64)> {
    h.write_trusted_batch(&[(DDL.trim().to_string(), vec![])])
        .await?;
    let emb = embedding
        .map(|e| {
            if e.is_empty() {
                Err(DocError::InvalidDocument("empty embedding".into()))
            } else {
                Ok(Value::Text(vector_text(e)))
            }
        })
        .transpose()?;
    let (_, txid) = h
        .write_trusted(
            "INSERT INTO __memoturn_messages (session_id, seq, role, content, embedding, created_at)
             SELECT ?, coalesce(max(seq), 0) + 1, ?, jsonb(?), CASE WHEN ? IS NULL THEN NULL ELSE vector32(?) END, ?
             FROM __memoturn_messages WHERE session_id = ?",
            vec![
                Value::Text(session.to_string()),
                Value::Text(role.to_string()),
                Value::Text(content.to_string()),
                emb.clone().unwrap_or(Value::Null),
                emb.unwrap_or(Value::Text("[0]".into())),
                Value::Integer(now_ms()),
                Value::Text(session.to_string()),
            ],
        )
        .await?;
    let r = h
        .read_trusted(
            "SELECT max(seq) FROM __memoturn_messages WHERE session_id = ?",
            vec![Value::Text(session.to_string())],
        )
        .await?;
    let seq = r
        .rows
        .first()
        .and_then(|row| row.first())
        .and_then(|v| v.as_u64())
        .unwrap_or(0);
    Ok((seq, txid))
}

/// Last `n` turns in conversation order.
pub async fn get_window(h: &DbHandle, session: &str, n: u32) -> Result<Vec<Json>> {
    let r = match h
        .read_trusted(
            "SELECT seq, role, json(content), created_at FROM (
               SELECT * FROM __memoturn_messages WHERE session_id = ?
               ORDER BY seq DESC LIMIT ?
             ) ORDER BY seq ASC",
            vec![Value::Text(session.to_string()), Value::Integer(n as i64)],
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
        .map(|row| {
            json!({
                "seq": row[0],
                "role": row[1],
                "content": row[2]
                    .as_str()
                    .and_then(|s| serde_json::from_str::<Json>(s).ok())
                    .unwrap_or(Json::Null),
                "created_at": row[3],
            })
        })
        .collect())
}

/// Delete a session's transcript turns (used when ending a memory session
/// with `?turns=true`; docs/architecture/07).
pub async fn drop_session(h: &DbHandle, session: &str) -> Result<u64> {
    match h
        .write_trusted(
            "DELETE FROM __memoturn_messages WHERE session_id = ?",
            vec![Value::Text(session.to_string())],
        )
        .await
    {
        Ok((_, txid)) => Ok(txid),
        Err(memoturn_engine::EngineError::Sql(e)) if e.contains("no such table") => Ok(h.txid()),
        Err(e) => Err(e.into()),
    }
}

/// Semantic search over embedded turns (brute-force cosine within the
/// session — agent-scale sessions are small; ANN-indexed long-term memory
/// lives in vector collections).
pub async fn search_semantic(
    h: &DbHandle,
    session: &str,
    query: &[f32],
    k: u32,
) -> Result<Vec<Json>> {
    search_turns(h, Some(session), query, k).await
}

/// Brute-force cosine over embedded turns, profile-wide or per-session — the
/// raw-turn recall channel (docs/architecture/07): verbatim moments that
/// never made it into a typed memory.
pub async fn search_turns(
    h: &DbHandle,
    session: Option<&str>,
    query: &[f32],
    k: u32,
) -> Result<Vec<Json>> {
    let (filter, mut params) = match session {
        Some(s) => (
            "session_id = ? AND embedding IS NOT NULL",
            vec![Value::Text(vector_text(query)), Value::Text(s.to_string())],
        ),
        None => (
            "embedding IS NOT NULL",
            vec![Value::Text(vector_text(query))],
        ),
    };
    params.push(Value::Integer(k as i64));
    let r = match h
        .read_trusted(
            &format!(
                "SELECT session_id, seq, role, json(content),
                        vector_distance_cos(embedding, vector32(?)) AS d
                 FROM __memoturn_messages
                 WHERE {filter}
                 ORDER BY d ASC LIMIT ?"
            ),
            params,
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
        .map(|row| {
            json!({
                "session_id": row[0],
                "seq": row[1],
                "role": row[2],
                "content": row[3]
                    .as_str()
                    .and_then(|s| serde_json::from_str::<Json>(s).ok())
                    .unwrap_or(Json::Null),
                "distance": row[4],
            })
        })
        .collect())
}
