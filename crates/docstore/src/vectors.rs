//! Vector collections: libSQL native `F32_BLOB` + DiskANN index (ADR-0007).
//! Vectors live in reserved tables of the tenant DB, so they replicate, fork,
//! and rewind with everything else.

use crate::{collection_table, DocError, Result};
use memoturn_engine::{DbHandle, Value};

fn vec_table(collection: &str) -> Result<String> {
    Ok(collection_table(collection)?.replace("__memoturn_docs_", "__memoturn_vec_"))
}

pub(crate) fn vector_text(embedding: &[f32]) -> String {
    let mut s = String::with_capacity(embedding.len() * 8 + 2);
    s.push('[');
    for (i, v) in embedding.iter().enumerate() {
        if i > 0 {
            s.push(',');
        }
        s.push_str(&format!("{v}"));
    }
    s.push(']');
    s
}

pub async fn upsert(h: &DbHandle, collection: &str, id: &str, embedding: &[f32]) -> Result<u64> {
    if embedding.is_empty() {
        return Err(DocError::InvalidDocument("empty embedding".into()));
    }
    let table = vec_table(collection)?;
    let dim = embedding.len();
    let stmts = vec![
        (
            format!(
                "CREATE TABLE IF NOT EXISTS \"{table}\" (
                   id TEXT PRIMARY KEY,
                   e F32_BLOB({dim})
                 )"
            ),
            vec![],
        ),
        (
            format!(
                "CREATE INDEX IF NOT EXISTS \"{table}_ann\" ON \"{table}\" (libsql_vector_idx(e))"
            ),
            vec![],
        ),
        (
            format!(
                "INSERT INTO \"{table}\" (id, e) VALUES (?, vector32(?))
                 ON CONFLICT(id) DO UPDATE SET e = excluded.e"
            ),
            vec![
                Value::Text(id.to_string()),
                Value::Text(vector_text(embedding)),
            ],
        ),
    ];
    let (_, txid) = h.write_trusted_batch(&stmts).await?;
    Ok(txid)
}

pub struct VectorHit {
    pub id: String,
    pub distance: f64,
}

/// ANN search via the DiskANN index (cosine distance; lower is closer).
pub async fn search(
    h: &DbHandle,
    collection: &str,
    query: &[f32],
    k: u32,
) -> Result<Vec<VectorHit>> {
    let table = vec_table(collection)?;
    let sql = format!(
        "SELECT v.id, vector_distance_cos(v.e, vector32(?)) AS d
         FROM vector_top_k('{table}_ann', vector32(?), ?) tk
         JOIN \"{table}\" v ON v.rowid = tk.id
         ORDER BY d"
    );
    let q = Value::Text(vector_text(query));
    let r = match h
        .read_trusted(&sql, vec![q.clone(), q, Value::Integer(k as i64)])
        .await
    {
        Ok(r) => r,
        Err(memoturn_engine::EngineError::Sql(e))
            if e.contains("no such table") || e.contains("no such index") =>
        {
            return Ok(Vec::new())
        }
        Err(e) => return Err(e.into()),
    };
    Ok(r.rows
        .into_iter()
        .filter_map(|row| {
            Some(VectorHit {
                id: row.first()?.as_str()?.to_string(),
                distance: row.get(1)?.as_f64().unwrap_or(f64::MAX),
            })
        })
        .collect())
}

pub async fn delete(h: &DbHandle, collection: &str, id: &str) -> Result<u64> {
    let table = vec_table(collection)?;
    match h
        .write_trusted(
            &format!("DELETE FROM \"{table}\" WHERE id = ?"),
            vec![Value::Text(id.to_string())],
        )
        .await
    {
        Ok((_, txid)) => Ok(txid),
        Err(memoturn_engine::EngineError::Sql(e)) if e.contains("no such table") => Ok(h.txid()),
        Err(e) => Err(e.into()),
    }
}
