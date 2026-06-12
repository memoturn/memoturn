//! KV surface: namespaced get/put/delete/list with TTL — the contract of the
//! libSQL engine's `__memoturn_kv` (lazy expiry on read, prefix list, bounded
//! sweep), as point ops on the keyspace. No SQL bypass is needed because
//! there is no SQL.

use crate::codec::key;
use crate::codec::record::{self, KvRecord};
use crate::core::view::View;
use crate::{now_ms, Op, Result};

pub fn stage_put(ns: &str, k: &str, value: Vec<u8>, ttl_secs: Option<u64>) -> Vec<Op> {
    let expires_at = ttl_secs.map(|t| now_ms() + (t as i64) * 1000);
    let mut ops = vec![Op::Put {
        key: key::kv(ns, k),
        value: record::encode(&KvRecord::V1 { value, expires_at }),
    }];
    if let Some(exp) = expires_at {
        ops.push(Op::Put {
            key: key::kv_expires(exp as u64, ns, k),
            value: Vec::new(),
        });
    }
    ops
}

pub fn stage_delete(ns: &str, k: &str) -> Vec<Op> {
    vec![Op::Del {
        key: key::kv(ns, k),
    }]
}

/// Lazy expiry contract: an expired key is a miss. (The opportunistic delete
/// rides the next sweep — reads here are pure.)
pub fn get(view: &View<'_>, ns: &str, k: &str) -> Result<Option<Vec<u8>>> {
    let Some(bytes) = view.get(&key::kv(ns, k)) else {
        return Ok(None);
    };
    let KvRecord::V1 { value, expires_at } = record::decode(&bytes)?;
    if let Some(exp) = expires_at {
        if exp <= now_ms() {
            return Ok(None);
        }
    }
    Ok(Some(value))
}

/// Keys under a prefix, unexpired, ascending, up to `limit`.
pub fn list(view: &View<'_>, ns: &str, prefix: &str, limit: u32) -> Result<Vec<String>> {
    let now = now_ms();
    let mut out = Vec::new();
    let p = key::kv_list_prefix(ns, prefix);
    for (k, v) in view.scan_prefix(&p, None) {
        let KvRecord::V1 { expires_at, .. } = record::decode(&v)?;
        if matches!(expires_at, Some(exp) if exp <= now) {
            continue;
        }
        // Key layout: tag, str(ns), str(key) — decode the second component.
        let Some((_, after_ns)) = key::decode_str(&k, 1) else {
            continue;
        };
        let Some((name, _)) = key::decode_str(&k, after_ns) else {
            continue;
        };
        out.push(name);
        if out.len() as u32 >= limit {
            break;
        }
    }
    Ok(out)
}

/// Sweep expired keys via the KV_EXPIRES index (bounded, expiry-ordered).
pub fn stage_sweep(view: &View<'_>) -> Result<(Vec<Op>, u64)> {
    let now = now_ms();
    let mut ops = Vec::new();
    let mut swept = 0u64;
    for (k, _) in view.scan_prefix(&key::kv_expires_prefix(), None) {
        let Some(exp) = key::u64_at(&k, 1) else {
            continue;
        };
        if exp as i64 > now || swept >= 500 {
            break;
        }
        ops.push(Op::Del { key: k.clone() });
        // Re-derive the data key; only delete it if this index entry still
        // matches its live TTL (a re-put with a new TTL must survive).
        let Some((ns, after_ns)) = key::decode_str(&k, 9) else {
            continue;
        };
        let Some((name, _)) = key::decode_str(&k, after_ns) else {
            continue;
        };
        let data_key = key::kv(&ns, &name);
        if let Some(bytes) = view.get(&data_key) {
            let KvRecord::V1 { expires_at, .. } = record::decode(&bytes)?;
            if expires_at == Some(exp as i64) {
                ops.push(Op::Del { key: data_key });
                swept += 1;
            }
        }
    }
    Ok((ops, swept))
}
