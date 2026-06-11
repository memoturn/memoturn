//! MLTX segment format — LTX-inspired (immutable page-transaction segments),
//! not byte-compatible: `MLTX1` magic, JSON header, lz4-compressed body of
//! `(page_no u32 LE, page image)` entries deduplicated to the latest version
//! of each page within `(min_txid, max_txid]`.

use crate::{ReplicationError, Result};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

const MAGIC: &[u8; 5] = b"MLTX1";

/// Manifest entry for one segment object.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SegmentRef {
    pub min_txid: u64,
    pub max_txid: u64,
    pub key: String,
    pub db_size_pages: u32,
}

#[derive(Debug, Serialize, Deserialize)]
struct Header {
    page_size: u32,
    min_txid: u64,
    max_txid: u64,
    db_size_pages: u32,
    n_pages: u32,
    /// FNV-1a checksum of the uncompressed body. Local WAL capture trusts the
    /// single writer, but a segment arriving over the replica stream comes from
    /// a peer — `decode` verifies this so a corrupt/truncated transfer is caught
    /// before it patches a database image. `#[serde(default)]` keeps older
    /// segments (checksum 0) readable; 0 means "unverified".
    #[serde(default)]
    checksum: u64,
}

/// FNV-1a over `data` — a fast non-cryptographic integrity check (corruption
/// detection, not tamper resistance; the transport is the trust boundary).
fn checksum(data: &[u8]) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for &b in data {
        h ^= b as u64;
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    h
}

pub struct Segment {
    pub page_size: u32,
    pub min_txid: u64,
    pub max_txid: u64,
    pub db_size_pages: u32,
    pub pages: BTreeMap<u32, Vec<u8>>,
}

pub fn encode(seg: &Segment) -> Result<Vec<u8>> {
    let mut body = Vec::with_capacity(seg.pages.len() * (4 + seg.page_size as usize));
    for (pgno, img) in &seg.pages {
        if img.len() != seg.page_size as usize {
            return Err(ReplicationError::Corrupt(format!(
                "page {pgno} has size {} (expected {})",
                img.len(),
                seg.page_size
            )));
        }
        body.extend_from_slice(&pgno.to_le_bytes());
        body.extend_from_slice(img);
    }
    let header = Header {
        page_size: seg.page_size,
        min_txid: seg.min_txid,
        max_txid: seg.max_txid,
        db_size_pages: seg.db_size_pages,
        n_pages: seg.pages.len() as u32,
        checksum: checksum(&body),
    };
    let hjson =
        serde_json::to_vec(&header).map_err(|e| ReplicationError::Corrupt(e.to_string()))?;
    let compressed = lz4_flex::compress_prepend_size(&body);
    let mut out = Vec::with_capacity(MAGIC.len() + 4 + hjson.len() + compressed.len());
    out.extend_from_slice(MAGIC);
    out.extend_from_slice(&(hjson.len() as u32).to_le_bytes());
    out.extend_from_slice(&hjson);
    out.extend_from_slice(&compressed);
    Ok(out)
}

/// Patch a database image with a segment's pages (checkpoint semantics):
/// latest page images win, the image is sized to the segment's committed
/// database size. Used by chain restore and replica ingest.
pub fn apply_to_image(image: &mut Vec<u8>, seg: &Segment) {
    let ps = seg.page_size as usize;
    let new_len = seg.db_size_pages as usize * ps;
    if image.len() < new_len {
        image.resize(new_len, 0);
    }
    for (pgno, img) in &seg.pages {
        let at = (*pgno as usize - 1) * ps;
        if at + ps > image.len() {
            image.resize(at + ps, 0);
        }
        image[at..at + ps].copy_from_slice(img);
    }
    image.truncate(new_len);
}

pub fn decode(bytes: &[u8]) -> Result<Segment> {
    let corrupt = |m: &str| ReplicationError::Corrupt(m.to_string());
    if bytes.len() < MAGIC.len() + 4 || &bytes[..5] != MAGIC {
        return Err(corrupt("bad segment magic"));
    }
    let hlen = u32::from_le_bytes(bytes[5..9].try_into().unwrap()) as usize;
    let hend = 9 + hlen;
    if bytes.len() < hend {
        return Err(corrupt("truncated segment header"));
    }
    let header: Header = serde_json::from_slice(&bytes[9..hend])
        .map_err(|e| ReplicationError::Corrupt(e.to_string()))?;
    let body = lz4_flex::decompress_size_prepended(&bytes[hend..])
        .map_err(|e| ReplicationError::Corrupt(e.to_string()))?;
    let entry = 4 + header.page_size as usize;
    if body.len() != entry * header.n_pages as usize {
        return Err(corrupt("segment body size mismatch"));
    }
    // Verify integrity for segments that carry a checksum (0 = legacy/unset).
    if header.checksum != 0 && checksum(&body) != header.checksum {
        return Err(corrupt("segment checksum mismatch"));
    }
    let mut pages = BTreeMap::new();
    for chunk in body.chunks_exact(entry) {
        let pgno = u32::from_le_bytes(chunk[..4].try_into().unwrap());
        pages.insert(pgno, chunk[4..].to_vec());
    }
    Ok(Segment {
        page_size: header.page_size,
        min_txid: header.min_txid,
        max_txid: header.max_txid,
        db_size_pages: header.db_size_pages,
        pages,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip() {
        let mut pages = BTreeMap::new();
        pages.insert(1, vec![7u8; 4096]);
        pages.insert(42, vec![9u8; 4096]);
        let seg = Segment {
            page_size: 4096,
            min_txid: 10,
            max_txid: 12,
            db_size_pages: 50,
            pages,
        };
        let bytes = encode(&seg).unwrap();
        let back = decode(&bytes).unwrap();
        assert_eq!(back.min_txid, 10);
        assert_eq!(back.max_txid, 12);
        assert_eq!(back.db_size_pages, 50);
        assert_eq!(back.pages.len(), 2);
        assert_eq!(back.pages[&42], vec![9u8; 4096]);
        assert!(bytes.len() < 2 * 4096, "compresses uniform pages");
    }

    #[test]
    fn detects_body_corruption_via_checksum() {
        let mut pages = BTreeMap::new();
        pages.insert(1, vec![7u8; 4096]);
        let seg = Segment {
            page_size: 4096,
            min_txid: 1,
            max_txid: 2,
            db_size_pages: 1,
            pages,
        };
        let mut bytes = encode(&seg).unwrap();
        assert!(decode(&bytes).is_ok());
        // Flip a byte in the compressed body (after the header) — decode must
        // reject it rather than apply corrupt pages to a database image.
        let last = bytes.len() - 1;
        bytes[last] ^= 0xff;
        assert!(decode(&bytes).is_err());
    }
}
