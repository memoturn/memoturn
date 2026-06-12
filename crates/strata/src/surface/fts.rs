//! Keyword search as postings-as-keys: every `(term, id)` is an ordinary
//! FTS_TERM row that flushes, forks, rewinds, and erases with the data.
//! BM25 is scored in Rust over the merged iterator (09 § FTS).

use crate::codec::record::{FtsPosting, FtsStatsV1};
use crate::fuse::tokens;
use std::collections::HashMap;

pub const BM25_K1: f64 = 1.2;
pub const BM25_B: f64 = 0.75;

/// Term frequencies for one document field.
pub fn term_frequencies(text: &str) -> HashMap<String, u16> {
    let mut tf: HashMap<String, u16> = HashMap::new();
    for t in tokens(text) {
        *tf.entry(t).or_default() += 1;
    }
    tf
}

/// Merge summary + keywords tf maps into per-term postings.
pub fn postings_for(summary: &str, keywords: &str) -> HashMap<String, FtsPosting> {
    let ts = term_frequencies(summary);
    let tk = term_frequencies(keywords);
    let mut out: HashMap<String, FtsPosting> = HashMap::new();
    for (term, tf) in ts {
        out.insert(
            term,
            FtsPosting::V1 {
                tf_summary: tf,
                tf_keywords: 0,
            },
        );
    }
    for (term, tf) in tk {
        match out.get_mut(&term) {
            Some(FtsPosting::V1 { tf_keywords, .. }) => *tf_keywords = tf,
            None => {
                out.insert(
                    term,
                    FtsPosting::V1 {
                        tf_summary: 0,
                        tf_keywords: tf,
                    },
                );
            }
        }
    }
    out
}

/// One candidate's accumulated per-term hits.
#[derive(Debug, Default, Clone)]
pub struct CandidateHits {
    /// (term index in the query, tf_summary, tf_keywords)
    pub hits: Vec<(usize, u16, u16)>,
}

/// Two-field BM25 (summary + keywords, equal weight — FTS5's default for a
/// two-column table). `df` per query term, document lengths in tokens.
#[allow(clippy::too_many_arguments)]
pub fn bm25(
    cand: &CandidateHits,
    dfs: &[u64],
    stats: &FtsStatsV1,
    summary_len: u32,
    keywords_len: u32,
) -> f64 {
    let n = stats.doc_count.max(1) as f64;
    let avg_s = stats.total_summary_tokens as f64 / n;
    let avg_k = stats.total_keywords_tokens as f64 / n;
    let mut score = 0.0;
    for &(term_idx, tf_s, tf_k) in &cand.hits {
        let df = dfs.get(term_idx).copied().unwrap_or(0).max(1) as f64;
        let idf = ((n - df + 0.5) / (df + 0.5) + 1.0).ln();
        for (tf, len, avg) in [
            (tf_s as f64, summary_len as f64, avg_s.max(1.0)),
            (tf_k as f64, keywords_len as f64, avg_k.max(1.0)),
        ] {
            if tf > 0.0 {
                score += idf * (tf * (BM25_K1 + 1.0))
                    / (tf + BM25_K1 * (1.0 - BM25_B + BM25_B * len / avg));
            }
        }
    }
    score
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn postings_merge_fields() {
        let p = postings_for("dark dark mode", "mode ui");
        assert_eq!(
            p["dark"],
            FtsPosting::V1 {
                tf_summary: 2,
                tf_keywords: 0
            }
        );
        assert_eq!(
            p["mode"],
            FtsPosting::V1 {
                tf_summary: 1,
                tf_keywords: 1
            }
        );
        assert_eq!(
            p["ui"],
            FtsPosting::V1 {
                tf_summary: 0,
                tf_keywords: 1
            }
        );
    }

    #[test]
    fn bm25_prefers_rarer_terms_and_higher_tf() {
        let stats = FtsStatsV1 {
            doc_count: 100,
            total_summary_tokens: 500,
            total_keywords_tokens: 100,
        };
        let common = CandidateHits {
            hits: vec![(0, 1, 0)],
        };
        let rare = CandidateHits {
            hits: vec![(1, 1, 0)],
        };
        let dfs = vec![90, 2];
        let s_common = bm25(&common, &dfs, &stats, 5, 0);
        let s_rare = bm25(&rare, &dfs, &stats, 5, 0);
        assert!(s_rare > s_common);

        let twice = CandidateHits {
            hits: vec![(1, 2, 0)],
        };
        assert!(bm25(&twice, &dfs, &stats, 5, 0) > s_rare);
    }
}
