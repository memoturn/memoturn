//! KV layer: Cloudflare-KV-shaped namespaced get/put/delete/list with TTL,
//! stored in the reserved `__memoturn_kv` table of each database and accessed
//! only via the trusted fast path (no SQL parsing of user input).
//!
//! TTL semantics: lazy expiry on read (expired = miss, deleted opportunistically);
//! a background sweeper for hot DBs arrives with the node loop. Cold databases
//! are never woken to expire keys (docs/architecture/01).

use memoturn_engine::{DbHandle, Result, Value};

pub struct KvEntry {
    pub value: Vec<u8>,
    pub txid: u64,
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

pub async fn put(
    h: &DbHandle,
    ns: &str,
    key: &str,
    value: Vec<u8>,
    ttl_secs: Option<u64>,
) -> Result<u64> {
    let expires_at = ttl_secs.map(|t| now_ms() + (t as i64) * 1000);
    let (_, txid) = h
        .write_trusted(
            "INSERT INTO __memoturn_kv (ns, k, v, expires_at) VALUES (?, ?, ?, ?)
             ON CONFLICT(ns, k) DO UPDATE SET v=excluded.v, expires_at=excluded.expires_at",
            vec![
                Value::Text(ns.to_string()),
                Value::Text(key.to_string()),
                Value::Blob(value),
                expires_at.map(Value::Integer).unwrap_or(Value::Null),
            ],
        )
        .await?;
    Ok(txid)
}

pub async fn get(h: &DbHandle, ns: &str, key: &str) -> Result<Option<KvEntry>> {
    let r = h
        .read_trusted(
            "SELECT v, expires_at FROM __memoturn_kv WHERE ns = ? AND k = ?",
            vec![Value::Text(ns.to_string()), Value::Text(key.to_string())],
        )
        .await?;
    let Some(row) = r.rows.first() else { return Ok(None) };
    if let Some(exp) = row[1].as_i64() {
        if exp <= now_ms() {
            // Lazy expiry: opportunistically delete and report a miss.
            let _ = delete(h, ns, key).await;
            return Ok(None);
        }
    }
    let value = match &row[0] {
        serde_json::Value::Object(m) => m
            .get("$base64")
            .and_then(|v| v.as_str())
            .map(|b64| {
                use base64::Engine as _;
                base64::engine::general_purpose::STANDARD
                    .decode(b64)
                    .unwrap_or_default()
            })
            .unwrap_or_default(),
        serde_json::Value::String(s) => s.clone().into_bytes(),
        other => other.to_string().into_bytes(),
    };
    Ok(Some(KvEntry { value, txid: h.txid() }))
}

pub async fn delete(h: &DbHandle, ns: &str, key: &str) -> Result<u64> {
    let (_, txid) = h
        .write_trusted(
            "DELETE FROM __memoturn_kv WHERE ns = ? AND k = ?",
            vec![Value::Text(ns.to_string()), Value::Text(key.to_string())],
        )
        .await?;
    Ok(txid)
}

pub async fn list(
    h: &DbHandle,
    ns: &str,
    prefix: &str,
    limit: u32,
) -> Result<Vec<String>> {
    let r = h
        .read_trusted(
            "SELECT k FROM __memoturn_kv
             WHERE ns = ? AND k >= ? AND k < ? || x'ffff'
               AND (expires_at IS NULL OR expires_at > ?)
             ORDER BY k LIMIT ?",
            vec![
                Value::Text(ns.to_string()),
                Value::Text(prefix.to_string()),
                Value::Text(prefix.to_string()),
                Value::Integer(now_ms()),
                Value::Integer(limit as i64),
            ],
        )
        .await?;
    Ok(r.rows
        .into_iter()
        .filter_map(|row| row.first().and_then(|v| v.as_str().map(String::from)))
        .collect())
}

/// Sweep expired keys (called by the node maintenance loop for hot DBs only).
pub async fn sweep_expired(h: &DbHandle) -> Result<u64> {
    let (n, _) = h
        .write_trusted(
            "DELETE FROM __memoturn_kv WHERE expires_at IS NOT NULL AND expires_at <= ?",
            vec![Value::Integer(now_ms())],
        )
        .await?;
    Ok(n)
}
