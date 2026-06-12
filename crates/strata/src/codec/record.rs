//! Value encodings: postcard-serialized **versioned enums**. Readers keep a
//! decode arm for every historical version forever — that is the engine's
//! whole schema-migration story (docs/architecture/09): branch rewind can
//! resurrect old data at any time, and an old record simply decodes through
//! its version arm. New fields = new variant, never a field edit.
//!
//! Memory `content` and document bodies stay **raw canonical JSON bytes**
//! (workspace serde_json sorts keys), so content-addressed ids are byte-stable
//! with the libSQL engine.

use crate::{Result, StrataError};
use serde::{Deserialize, Serialize};

pub fn encode<T: Serialize>(t: &T) -> Vec<u8> {
    postcard::to_allocvec(t).expect("postcard encode of an owned record cannot fail")
}

pub fn decode<'a, T: Deserialize<'a>>(bytes: &'a [u8]) -> Result<T> {
    postcard::from_bytes(bytes).map_err(|e| StrataError::Corrupt(format!("record decode: {e}")))
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum MemoryRecord {
    V1(MemoryV1),
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct MemoryV1 {
    pub id: [u8; 16],
    /// `MemoryType` discriminant byte (see surface::memory).
    pub mtype: u8,
    pub topic_key: Option<String>,
    pub summary: String,
    /// Canonical JSON bytes — hashed for the content-addressed id.
    pub content: Vec<u8>,
    pub keywords: String,
    pub session_id: Option<String>,
    pub source: Option<String>,
    pub created_at: i64,
    pub expires_at: Option<i64>,
    pub superseded_by: Option<[u8; 16]>,
    pub superseded_at: Option<i64>,
    /// Token counts at ingest (BM25 document lengths — avoids re-tokenizing
    /// every candidate at query time).
    pub summary_tokens: u32,
    pub keywords_tokens: u32,
}

impl MemoryRecord {
    pub fn v1(self) -> MemoryV1 {
        match self {
            MemoryRecord::V1(m) => m,
        }
    }
    pub fn as_v1(&self) -> &MemoryV1 {
        match self {
            MemoryRecord::V1(m) => m,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum SessionRecord {
    V1 {
        created_at: i64,
        last_active_at: i64,
    },
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
pub enum FtsPosting {
    V1 { tf_summary: u16, tf_keywords: u16 },
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq)]
pub struct FtsStatsV1 {
    pub doc_count: u64,
    pub total_summary_tokens: u64,
    pub total_keywords_tokens: u64,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
pub enum FtsStats {
    V1(FtsStatsV1),
}

impl FtsStats {
    pub fn v1(self) -> FtsStatsV1 {
        match self {
            FtsStats::V1(s) => s,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum KvRecord {
    V1 {
        value: Vec<u8>,
        expires_at: Option<i64>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum DocRecord {
    V1 {
        /// Canonical JSON bytes, `_id` included.
        json: Vec<u8>,
        created_at: i64,
        updated_at: i64,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum DocMetaRecord {
    V1 { indexed_paths: Vec<String> },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum TurnRecord {
    V1 {
        role: String,
        /// JSON bytes.
        content: Vec<u8>,
        embedding: Option<Vec<f32>>,
        created_at: i64,
    },
}

/// META values, keyed by name (one enum so every meta row stays versioned).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum MetaRecord {
    /// Vector dimension, fixed by the first embedding ingested.
    VecDimV1(u32),
}

/// Pack an embedding as little-endian f32 bytes (the VEC value encoding —
/// raw, not postcard, so the flat scan reads it without a decode pass).
pub fn encode_embedding(e: &[f32]) -> Vec<u8> {
    let mut out = Vec::with_capacity(e.len() * 4);
    for v in e {
        out.extend_from_slice(&v.to_le_bytes());
    }
    out
}

pub fn decode_embedding(bytes: &[u8]) -> Vec<f32> {
    bytes
        .chunks_exact(4)
        .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn records_round_trip() {
        let m = MemoryRecord::V1(MemoryV1 {
            id: [7; 16],
            mtype: 0,
            topic_key: Some("user.theme".into()),
            summary: "prefers dark mode".into(),
            content: br#"{"v":"dark"}"#.to_vec(),
            keywords: "theme ui".into(),
            session_id: None,
            source: Some("claude-code".into()),
            created_at: 123,
            expires_at: None,
            superseded_by: None,
            superseded_at: None,
            summary_tokens: 3,
            keywords_tokens: 2,
        });
        let bytes = encode(&m);
        assert_eq!(decode::<MemoryRecord>(&bytes).unwrap(), m);
    }

    #[test]
    fn embedding_round_trips() {
        let e = vec![0.5f32, -1.25, 3.0];
        assert_eq!(decode_embedding(&encode_embedding(&e)), e);
    }

    #[test]
    fn corrupt_bytes_error_not_panic() {
        assert!(decode::<MemoryRecord>(&[0xFF, 0xFE, 0x01]).is_err());
    }
}
