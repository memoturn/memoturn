//! Engine-agnostic recall fusion, ported verbatim from
//! `crates/docstore/src/memories.rs` with its tests — the RRF constants and
//! channel weights are part of the product contract (07 § recall).

/// RRF rank constant (the standard 60) and per-channel weights.
pub const RRF_K: f64 = 60.0;
pub const W_TOPIC: f64 = 2.0;
pub const W_FTS: f64 = 1.0;
pub const W_VEC: f64 = 1.0;

/// Tokenize free text the way ingest and recall both must: split on
/// non-alphanumerics, lowercase. (FTS5's unicode61 tokenizer differs mildly
/// on non-ASCII case folding — documented divergence, 09 § FTS.)
pub fn tokens(text: &str) -> Vec<String> {
    text.split(|c: char| !c.is_alphanumeric())
        .filter(|t| !t.is_empty())
        .map(|t| t.to_lowercase())
        .collect()
}

/// Turn free text into an FTS5-style OR-query of quoted tokens — natural-
/// language questions must never be parsed as query syntax. Kept for surface
/// parity with the libSQL engine (its tests pin the quoting behavior).
pub fn fts_query(text: &str) -> Option<String> {
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
pub fn rrf_merge(
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fts_query_quotes_and_ors_tokens() {
        assert_eq!(
            fts_query("what theme does the \"user\" like?").as_deref(),
            Some("\"what\" OR \"theme\" OR \"does\" OR \"the\" OR \"user\" OR \"like\"")
        );
        assert_eq!(fts_query("  ?!  "), None);
        // Operators arrive as plain quoted tokens, never syntax.
        assert_eq!(
            fts_query("NOT (refund)").as_deref(),
            Some("\"NOT\" OR \"refund\"")
        );
    }

    #[test]
    fn tokens_lowercase_and_split() {
        assert_eq!(tokens("Dark-Mode UI!"), vec!["dark", "mode", "ui"]);
        assert!(tokens(" ?! ").is_empty());
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
}
