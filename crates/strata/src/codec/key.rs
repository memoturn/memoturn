//! The ordered binary keyspace (docs/architecture/09). Keys are tuple-encoded
//! behind single-byte table tags; encodings are order-preserving so a plain
//! byte comparison sorts every table the way its scans need.
//!
//! Components:
//! - string: bytes with `0x00 → 0x00 0xFF` escaping, terminated by `0x00 0x01`
//!   (terminator < any escaped NUL, so `"a" < "a\0x"` and prefixes sort first)
//! - u64: 8 bytes big-endian
//! - f64: sign-flipped IEEE order trick (negative values fully complemented)
//! - id16: the 16 raw bytes of a content-addressed memory id

/// Table tags. One byte; gaps left for future tables.
pub mod tag {
    pub const META: u8 = 0x01;
    pub const MEM: u8 = 0x10;
    pub const MEM_ACTIVE: u8 = 0x11;
    pub const MEM_TOPIC: u8 = 0x12;
    pub const MEM_SESSION: u8 = 0x13;
    pub const MEM_EXPIRES: u8 = 0x14;
    pub const SESSIONS: u8 = 0x15;
    pub const FTS_TERM: u8 = 0x20;
    pub const FTS_STATS: u8 = 0x21;
    pub const VEC: u8 = 0x30;
    pub const KV: u8 = 0x40;
    pub const KV_EXPIRES: u8 = 0x41;
    pub const DOC: u8 = 0x50;
    pub const DOC_META: u8 = 0x51;
    pub const DOC_IDX: u8 = 0x52;
    pub const MSG: u8 = 0x60;
}

pub type Key = Vec<u8>;

/// Append a string component: NUL-escaped, terminated `0x00 0x01`.
pub fn push_str(buf: &mut Key, s: &str) {
    for &b in s.as_bytes() {
        if b == 0x00 {
            buf.push(0x00);
            buf.push(0xFF);
        } else {
            buf.push(b);
        }
    }
    buf.push(0x00);
    buf.push(0x01);
}

pub fn push_u64(buf: &mut Key, x: u64) {
    buf.extend_from_slice(&x.to_be_bytes());
}

/// Order-preserving f64: flip the sign bit for non-negatives, complement
/// everything for negatives. Total order matches `f64::total_cmp`.
pub fn push_f64(buf: &mut Key, x: f64) {
    let bits = x.to_bits();
    let mapped = if bits & (1 << 63) == 0 {
        bits ^ (1 << 63)
    } else {
        !bits
    };
    buf.extend_from_slice(&mapped.to_be_bytes());
}

pub fn push_id16(buf: &mut Key, id: &[u8; 16]) {
    buf.extend_from_slice(id);
}

/// Decode a string component starting at `at`; returns the string and the
/// offset just past its terminator.
pub fn decode_str(buf: &[u8], at: usize) -> Option<(String, usize)> {
    let mut out = Vec::new();
    let mut i = at;
    loop {
        match *buf.get(i)? {
            0x00 => match *buf.get(i + 1)? {
                0x01 => {
                    return Some((String::from_utf8(out).ok()?, i + 2));
                }
                0xFF => {
                    out.push(0x00);
                    i += 2;
                }
                _ => return None,
            },
            b => {
                out.push(b);
                i += 1;
            }
        }
    }
}

/// Decode the trailing 16 bytes of a key as an id16 (the layout every
/// `(…, id16)` membership table uses).
pub fn trailing_id16(key: &[u8]) -> Option<[u8; 16]> {
    let n = key.len();
    if n < 16 {
        return None;
    }
    let mut id = [0u8; 16];
    id.copy_from_slice(&key[n - 16..]);
    Some(id)
}

/// Decode a big-endian u64 at `offset`.
pub fn u64_at(key: &[u8], offset: usize) -> Option<u64> {
    let bytes = key.get(offset..offset + 8)?;
    Some(u64::from_be_bytes(bytes.try_into().ok()?))
}

/// Exclusive upper bound for "every key starting with `prefix`": the prefix
/// with its last non-0xFF byte incremented (trailing 0xFF bytes dropped).
/// An all-0xFF prefix has no successor; `None` means "scan to the end".
pub fn prefix_end(prefix: &[u8]) -> Option<Key> {
    let mut end = prefix.to_vec();
    while let Some(&last) = end.last() {
        if last == 0xFF {
            end.pop();
        } else {
            *end.last_mut().expect("non-empty") = last + 1;
            return Some(end);
        }
    }
    None
}

// ---- typed key builders ----

pub fn meta(name: &str) -> Key {
    let mut k = vec![tag::META];
    push_str(&mut k, name);
    k
}

pub fn mem(id: &[u8; 16]) -> Key {
    let mut k = vec![tag::MEM];
    push_id16(&mut k, id);
    k
}

pub fn mem_prefix() -> Key {
    vec![tag::MEM]
}

pub fn mem_active(mtype: u8, topic: &str) -> Key {
    let mut k = vec![tag::MEM_ACTIVE, mtype];
    push_str(&mut k, topic);
    k
}

pub fn mem_topic(mtype: u8, topic: &str, id: &[u8; 16]) -> Key {
    let mut k = vec![tag::MEM_TOPIC, mtype];
    push_str(&mut k, topic);
    push_id16(&mut k, id);
    k
}

pub fn mem_topic_prefix(mtype: u8, topic: &str) -> Key {
    let mut k = vec![tag::MEM_TOPIC, mtype];
    push_str(&mut k, topic);
    k
}

pub fn mem_session(session: &str, id: &[u8; 16]) -> Key {
    let mut k = vec![tag::MEM_SESSION];
    push_str(&mut k, session);
    push_id16(&mut k, id);
    k
}

pub fn mem_session_prefix(session: &str) -> Key {
    let mut k = vec![tag::MEM_SESSION];
    push_str(&mut k, session);
    k
}

pub fn mem_expires(expires_at_ms: u64, id: &[u8; 16]) -> Key {
    let mut k = vec![tag::MEM_EXPIRES];
    push_u64(&mut k, expires_at_ms);
    push_id16(&mut k, id);
    k
}

pub fn mem_expires_prefix() -> Key {
    vec![tag::MEM_EXPIRES]
}

pub fn session(id: &str) -> Key {
    let mut k = vec![tag::SESSIONS];
    push_str(&mut k, id);
    k
}

pub fn sessions_prefix() -> Key {
    vec![tag::SESSIONS]
}

pub fn fts_term(term: &str, id: &[u8; 16]) -> Key {
    let mut k = vec![tag::FTS_TERM];
    push_str(&mut k, term);
    push_id16(&mut k, id);
    k
}

pub fn fts_term_prefix(term: &str) -> Key {
    let mut k = vec![tag::FTS_TERM];
    push_str(&mut k, term);
    k
}

pub fn fts_stats() -> Key {
    vec![tag::FTS_STATS]
}

pub fn vec_entry(id: &[u8; 16]) -> Key {
    let mut k = vec![tag::VEC];
    push_id16(&mut k, id);
    k
}

pub fn vec_prefix() -> Key {
    vec![tag::VEC]
}

pub fn kv(ns: &str, key: &str) -> Key {
    let mut k = vec![tag::KV];
    push_str(&mut k, ns);
    push_str(&mut k, key);
    k
}

/// Prefix for listing keys under `(ns, key_prefix…)`. The key component is
/// left unterminated so the scan covers every key starting with the prefix.
pub fn kv_list_prefix(ns: &str, key_prefix: &str) -> Key {
    let mut k = vec![tag::KV];
    push_str(&mut k, ns);
    for &b in key_prefix.as_bytes() {
        if b == 0x00 {
            k.push(0x00);
            k.push(0xFF);
        } else {
            k.push(b);
        }
    }
    k
}

pub fn kv_expires(expires_at_ms: u64, ns: &str, key: &str) -> Key {
    let mut k = vec![tag::KV_EXPIRES];
    push_u64(&mut k, expires_at_ms);
    push_str(&mut k, ns);
    push_str(&mut k, key);
    k
}

pub fn kv_expires_prefix() -> Key {
    vec![tag::KV_EXPIRES]
}

pub fn doc(collection: &str, id: &str) -> Key {
    let mut k = vec![tag::DOC];
    push_str(&mut k, collection);
    push_str(&mut k, id);
    k
}

pub fn doc_prefix(collection: &str) -> Key {
    let mut k = vec![tag::DOC];
    push_str(&mut k, collection);
    k
}

pub fn doc_meta(collection: &str) -> Key {
    let mut k = vec![tag::DOC_META];
    push_str(&mut k, collection);
    k
}

/// Typed scalar component for doc index keys. Tag bytes order null < bool <
/// number < string; numbers compare numerically across int/float (both encode
/// through f64 — a documented divergence from SQLite affinity, see 09).
pub fn push_scalar(buf: &mut Key, v: &serde_json::Value) {
    match v {
        serde_json::Value::Null => buf.push(0x01),
        serde_json::Value::Bool(false) => buf.push(0x02),
        serde_json::Value::Bool(true) => buf.push(0x03),
        serde_json::Value::Number(n) => {
            buf.push(0x04);
            push_f64(buf, n.as_f64().unwrap_or(0.0));
        }
        serde_json::Value::String(s) => {
            buf.push(0x05);
            push_str(buf, s);
        }
        // Arrays/objects are rejected upstream by filter validation; encode a
        // distinct tag so an unexpected one cannot alias a scalar.
        _ => buf.push(0x06),
    }
}

pub fn doc_idx(collection: &str, path: &str, value: &serde_json::Value, id: &str) -> Key {
    let mut k = vec![tag::DOC_IDX];
    push_str(&mut k, collection);
    push_str(&mut k, path);
    push_scalar(&mut k, value);
    push_str(&mut k, id);
    k
}

pub fn doc_idx_value_prefix(collection: &str, path: &str, value: &serde_json::Value) -> Key {
    let mut k = vec![tag::DOC_IDX];
    push_str(&mut k, collection);
    push_str(&mut k, path);
    push_scalar(&mut k, value);
    k
}

pub fn doc_idx_path_prefix(collection: &str, path: &str) -> Key {
    let mut k = vec![tag::DOC_IDX];
    push_str(&mut k, collection);
    push_str(&mut k, path);
    k
}

pub fn msg(session: &str, seq: u64) -> Key {
    let mut k = vec![tag::MSG];
    push_str(&mut k, session);
    push_u64(&mut k, seq);
    k
}

pub fn msg_prefix(session: &str) -> Key {
    let mut k = vec![tag::MSG];
    push_str(&mut k, session);
    k
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn string_encoding_orders_like_strings_and_prefixes_first() {
        let k = |s: &str| {
            let mut b = Vec::new();
            push_str(&mut b, s);
            b
        };
        assert!(k("a") < k("b"));
        assert!(k("a") < k("aa"));
        assert!(k("a") < k("a\u{0}x"), "terminator sorts before escaped NUL");
        // Embedded NUL never aliases a component boundary.
        let mut two = vec![];
        push_str(&mut two, "a");
        push_str(&mut two, "b");
        let mut one = vec![];
        push_str(&mut one, "a\u{0}b");
        assert_ne!(two, one);
    }

    #[test]
    fn decode_str_round_trips_including_nuls() {
        for s in ["", "plain", "with\u{0}nul", "trail\u{0}"] {
            let mut b = vec![0x42];
            push_str(&mut b, s);
            push_u64(&mut b, 7);
            let (decoded, next) = decode_str(&b, 1).unwrap();
            assert_eq!(decoded, s);
            assert_eq!(u64_at(&b, next), Some(7));
        }
    }

    #[test]
    fn f64_encoding_is_order_preserving() {
        let enc = |x: f64| {
            let mut b = Vec::new();
            push_f64(&mut b, x);
            b
        };
        let vals = [-1e9, -2.5, -0.0, 0.0, 1e-9, 1.0, 2.5, 1e12];
        for w in vals.windows(2) {
            assert!(enc(w[0]) <= enc(w[1]), "{} !<= {}", w[0], w[1]);
        }
        assert!(enc(f64::NEG_INFINITY) < enc(f64::MIN));
        assert!(enc(f64::MAX) < enc(f64::INFINITY));
    }

    #[test]
    fn u64_encoding_is_order_preserving() {
        let enc = |x: u64| {
            let mut b = Vec::new();
            push_u64(&mut b, x);
            b
        };
        assert!(enc(0) < enc(1));
        assert!(enc(255) < enc(256));
        assert!(enc(u64::MAX - 1) < enc(u64::MAX));
    }

    #[test]
    fn prefix_end_brackets_exactly_the_prefix() {
        let p = doc_prefix("orders");
        let end = prefix_end(&p).unwrap();
        let inside = doc("orders", "zzz");
        assert!(p < inside && inside < end);
        let other = doc_prefix("ordersx");
        assert!(other >= end || other < p);
        assert_eq!(prefix_end(&[0xFF, 0xFF]), None);
        assert_eq!(prefix_end(&[0x01, 0xFF]), Some(vec![0x02]));
    }

    #[test]
    fn kv_list_prefix_covers_only_matching_keys() {
        let p = kv_list_prefix("ns", "user:");
        let hit = kv("ns", "user:42");
        let miss = kv("ns", "uses");
        let end = prefix_end(&p).unwrap();
        assert!(p <= hit && hit < end);
        assert!(!(p <= miss && miss < end));
    }

    #[test]
    fn scalar_type_classes_are_disjoint_and_ordered() {
        use serde_json::json;
        let enc = |v: serde_json::Value| {
            let mut b = Vec::new();
            push_scalar(&mut b, &v);
            b
        };
        assert!(enc(json!(null)) < enc(json!(false)));
        assert!(enc(json!(false)) < enc(json!(true)));
        assert!(enc(json!(true)) < enc(json!(-5)));
        assert!(enc(json!(-5)) < enc(json!(2)));
        assert!(enc(json!(2)) < enc(json!(2.5)));
        assert!(enc(json!(2.5)) < enc(json!("a")));
        // int/float compare numerically within the number class.
        assert!(enc(json!(2)) < enc(json!(10)));
        assert!(enc(json!(2.0)) == enc(json!(2)));
    }
}
