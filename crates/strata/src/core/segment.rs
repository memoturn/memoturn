//! MSEG1: the immutable sorted MVCC run. Entries are `(key, txid, op, value)`
//! sorted key-ascending, txid-descending within a key — multiple versions of
//! a key coexist, tombstones are explicit, and visibility at read time is
//! "newest version with txid ≤ T". That MVCC property is what makes
//! rewind/PITR-to-any-txid and fork-clamped reads native (docs/architecture/09).
//!
//! ```text
//! file := "MSEG1" · u32 header_len · postcard SegmentHeader
//!         data blocks (lz4, ~32 KB uncompressed each)
//!         postcard Trailer { block index, bloom }
//!         u64 trailer_off · u32 trailer_len · "MSGEND1\0"
//! ```
//!
//! The prototype reader fetches the whole object and decodes blocks eagerly
//! into one sorted vector behind the node block cache; the on-disk block
//! structure is real so a range-GET reader can replace it without a format
//! change.

use crate::{Result, StrataError, Txid};
use serde::{Deserialize, Serialize};

const MAGIC: &[u8; 5] = b"MSEG1";
const END_MAGIC: &[u8; 8] = b"MSGEND1\0";
const TARGET_BLOCK: usize = 32 * 1024;
const BLOOM_BITS_PER_KEY: usize = 10;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SegmentHeader {
    pub format: u32,
    pub min_txid: Txid,
    pub max_txid: Txid,
    pub level: u8,
    pub entry_count: u64,
    pub key_min: Vec<u8>,
    pub key_max: Vec<u8>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct BlockRef {
    first_key: Vec<u8>,
    offset: u64,
    len: u32,
    crc32: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Trailer {
    blocks: Vec<BlockRef>,
    bloom: Bloom,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Entry {
    pub key: Vec<u8>,
    pub txid: Txid,
    /// `None` = tombstone.
    pub value: Option<Vec<u8>>,
}

// ---- bloom filter (double hashing over two FNV-1a variants) ----

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Bloom {
    bits: Vec<u8>,
    k: u8,
}

fn fnv1a(seed: u64, data: &[u8]) -> u64 {
    let mut h = seed ^ 0xcbf2_9ce4_8422_2325;
    for &b in data {
        h ^= b as u64;
        h = h.wrapping_mul(0x0000_0100_0000_01B3);
    }
    h
}

impl Bloom {
    fn new(n_keys: usize) -> Self {
        let m = (n_keys.max(1) * BLOOM_BITS_PER_KEY).next_multiple_of(8);
        Self {
            bits: vec![0; m / 8],
            k: 7,
        }
    }

    fn insert(&mut self, key: &[u8]) {
        let m = (self.bits.len() * 8) as u64;
        let h1 = fnv1a(0, key);
        let h2 = fnv1a(h1, key) | 1;
        for i in 0..self.k as u64 {
            let bit = h1.wrapping_add(i.wrapping_mul(h2)) % m;
            self.bits[(bit / 8) as usize] |= 1 << (bit % 8);
        }
    }

    pub fn may_contain(&self, key: &[u8]) -> bool {
        let m = (self.bits.len() * 8) as u64;
        if m == 0 {
            return false;
        }
        let h1 = fnv1a(0, key);
        let h2 = fnv1a(h1, key) | 1;
        (0..self.k as u64).all(|i| {
            let bit = h1.wrapping_add(i.wrapping_mul(h2)) % m;
            self.bits[(bit / 8) as usize] & (1 << (bit % 8)) != 0
        })
    }
}

// ---- encode ----

/// Build a segment from entries already sorted (key asc, txid desc per key).
pub fn encode(
    entries: &[Entry],
    min_txid: Txid,
    max_txid: Txid,
    level: u8,
) -> Result<(Vec<u8>, SegmentHeader)> {
    debug_assert!(entries
        .windows(2)
        .all(|w| (&w[0].key, std::cmp::Reverse(w[0].txid))
            <= (&w[1].key, std::cmp::Reverse(w[1].txid))));
    let header = SegmentHeader {
        format: 1,
        min_txid,
        max_txid,
        level,
        entry_count: entries.len() as u64,
        key_min: entries.first().map(|e| e.key.clone()).unwrap_or_default(),
        key_max: entries.last().map(|e| e.key.clone()).unwrap_or_default(),
    };
    let header_bytes = postcard::to_allocvec(&header)
        .map_err(|e| StrataError::Corrupt(format!("segment header encode: {e}")))?;

    let mut out = Vec::with_capacity(4096);
    out.extend_from_slice(MAGIC);
    out.extend_from_slice(&(header_bytes.len() as u32).to_le_bytes());
    out.extend_from_slice(&header_bytes);

    let mut bloom = Bloom::new(entries.len());
    let mut seen_for_bloom: Option<&[u8]> = None;
    for e in entries {
        if seen_for_bloom != Some(e.key.as_slice()) {
            bloom.insert(&e.key);
            seen_for_bloom = Some(e.key.as_slice());
        }
    }

    let mut blocks = Vec::new();
    let mut chunk: Vec<&Entry> = Vec::new();
    let mut chunk_bytes = 0usize;
    let mut flush_chunk = |chunk: &mut Vec<&Entry>, out: &mut Vec<u8>| -> Result<()> {
        if chunk.is_empty() {
            return Ok(());
        }
        let raw = postcard::to_allocvec(&chunk)
            .map_err(|e| StrataError::Corrupt(format!("segment block encode: {e}")))?;
        let compressed = lz4_flex::compress_prepend_size(&raw);
        blocks.push(BlockRef {
            first_key: chunk[0].key.clone(),
            offset: out.len() as u64,
            len: compressed.len() as u32,
            crc32: crc32fast::hash(&compressed),
        });
        out.extend_from_slice(&compressed);
        chunk.clear();
        Ok(())
    };
    for e in entries {
        chunk_bytes += e.key.len() + e.value.as_ref().map_or(0, |v| v.len()) + 16;
        chunk.push(e);
        if chunk_bytes >= TARGET_BLOCK {
            flush_chunk(&mut chunk, &mut out)?;
            chunk_bytes = 0;
        }
    }
    flush_chunk(&mut chunk, &mut out)?;

    let trailer = Trailer { blocks, bloom };
    let trailer_bytes = postcard::to_allocvec(&trailer)
        .map_err(|e| StrataError::Corrupt(format!("segment trailer encode: {e}")))?;
    let trailer_off = out.len() as u64;
    out.extend_from_slice(&trailer_bytes);
    out.extend_from_slice(&trailer_off.to_le_bytes());
    out.extend_from_slice(&(trailer_bytes.len() as u32).to_le_bytes());
    out.extend_from_slice(END_MAGIC);
    Ok((out, header))
}

// ---- decode ----

/// A fully-decoded segment: sorted entries + bloom, cached node-wide.
#[derive(Debug)]
pub struct DecodedSegment {
    pub header: SegmentHeader,
    pub entries: Vec<Entry>,
    pub bloom: Bloom,
}

pub fn decode(bytes: &[u8]) -> Result<DecodedSegment> {
    let corrupt = |m: &str| StrataError::Corrupt(format!("segment: {m}"));
    if bytes.len() < MAGIC.len() + 4 + END_MAGIC.len() + 12 || &bytes[..5] != MAGIC {
        return Err(corrupt("bad magic or truncated"));
    }
    if &bytes[bytes.len() - 8..] != END_MAGIC {
        return Err(corrupt("bad end magic"));
    }
    let header_len = u32::from_le_bytes(bytes[5..9].try_into().unwrap()) as usize;
    let header: SegmentHeader = postcard::from_bytes(
        bytes
            .get(9..9 + header_len)
            .ok_or_else(|| corrupt("header truncated"))?,
    )
    .map_err(|e| corrupt(&format!("header decode: {e}")))?;
    if header.format != 1 {
        return Err(corrupt(&format!("unknown format {}", header.format)));
    }
    let tail = bytes.len() - 8;
    let trailer_len = u32::from_le_bytes(bytes[tail - 4..tail].try_into().unwrap()) as usize;
    let trailer_off = u64::from_le_bytes(bytes[tail - 12..tail - 4].try_into().unwrap()) as usize;
    let trailer: Trailer = postcard::from_bytes(
        bytes
            .get(trailer_off..trailer_off + trailer_len)
            .ok_or_else(|| corrupt("trailer truncated"))?,
    )
    .map_err(|e| corrupt(&format!("trailer decode: {e}")))?;

    let mut entries = Vec::with_capacity(header.entry_count as usize);
    for b in &trailer.blocks {
        let raw = bytes
            .get(b.offset as usize..b.offset as usize + b.len as usize)
            .ok_or_else(|| corrupt("block out of range"))?;
        if crc32fast::hash(raw) != b.crc32 {
            return Err(corrupt("block crc mismatch"));
        }
        let decompressed = lz4_flex::decompress_size_prepended(raw)
            .map_err(|e| corrupt(&format!("block decompress: {e}")))?;
        let mut block: Vec<Entry> = postcard::from_bytes(&decompressed)
            .map_err(|e| corrupt(&format!("block decode: {e}")))?;
        entries.append(&mut block);
    }
    if entries.len() as u64 != header.entry_count {
        return Err(corrupt("entry count mismatch"));
    }
    Ok(DecodedSegment {
        header,
        entries,
        bloom: trailer.bloom,
    })
}

impl DecodedSegment {
    /// Newest version of `key` with txid ≤ `at`. Outer `None` = key has no
    /// visible version here; inner `None` = tombstone.
    pub fn get(&self, key: &[u8], at: Txid) -> Option<Option<&[u8]>> {
        if !self.bloom.may_contain(key) {
            return None;
        }
        // First entry with this key (entries within a key are txid-desc).
        let start = self.entries.partition_point(|e| e.key.as_slice() < key);
        self.entries[start..]
            .iter()
            .take_while(|e| e.key == key)
            .find(|e| e.txid <= at)
            .map(|e| e.value.as_deref())
    }

    /// Visible versions in `[start, end)` at `at`: per key, the newest
    /// version with txid ≤ at (tombstones included — the merge layer shadows).
    pub fn range<'a>(
        &'a self,
        start: &[u8],
        end: Option<&[u8]>,
        at: Txid,
    ) -> impl Iterator<Item = (&'a [u8], Txid, Option<&'a [u8]>)> + 'a {
        let from = self.entries.partition_point(|e| e.key.as_slice() < start);
        let end = end.map(|e| e.to_vec());
        let mut last_key: Option<&[u8]> = None;
        self.entries[from..].iter().filter_map(move |e| {
            if let Some(end) = &end {
                if e.key.as_slice() >= end.as_slice() {
                    return None; // keys are sorted; nothing after matches either
                }
            }
            if last_key == Some(e.key.as_slice()) {
                return None; // already emitted the visible version of this key
            }
            if e.txid > at {
                return None; // not visible yet; a later (older-txid) entry may be
            }
            last_key = Some(e.key.as_slice());
            Some((e.key.as_slice(), e.txid, e.value.as_deref()))
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(key: &[u8], txid: Txid, value: Option<&[u8]>) -> Entry {
        Entry {
            key: key.to_vec(),
            txid,
            value: value.map(|v| v.to_vec()),
        }
    }

    #[test]
    fn round_trips_and_resolves_mvcc() {
        let entries = vec![
            entry(b"a", 5, Some(b"a5")),
            entry(b"a", 2, Some(b"a2")),
            entry(b"b", 4, None),
            entry(b"b", 1, Some(b"b1")),
            entry(b"c", 3, Some(b"c3")),
        ];
        let (bytes, header) = encode(&entries, 1, 5, 0).unwrap();
        assert_eq!(header.key_min, b"a");
        assert_eq!(header.key_max, b"c");
        let seg = decode(&bytes).unwrap();
        assert_eq!(seg.entries.len(), 5);
        assert_eq!(seg.get(b"a", 9), Some(Some(b"a5".as_ref())));
        assert_eq!(seg.get(b"a", 3), Some(Some(b"a2".as_ref())));
        assert_eq!(seg.get(b"a", 1), None);
        assert_eq!(seg.get(b"b", 4), Some(None), "tombstone");
        assert_eq!(seg.get(b"b", 2), Some(Some(b"b1".as_ref())));
        assert_eq!(seg.get(b"zz", 9), None);
    }

    #[test]
    fn range_emits_one_visible_version_per_key() {
        let entries = vec![
            entry(b"a", 5, Some(b"a5")),
            entry(b"a", 2, Some(b"a2")),
            entry(b"b", 6, Some(b"b6")),
            entry(b"c", 1, Some(b"c1")),
        ];
        let (bytes, _) = encode(&entries, 1, 6, 0).unwrap();
        let seg = decode(&bytes).unwrap();
        let at4: Vec<_> = seg
            .range(b"a", None, 4)
            .map(|(k, t, _)| (k.to_vec(), t))
            .collect();
        assert_eq!(at4, vec![(b"a".to_vec(), 2), (b"c".to_vec(), 1)]);
        let bounded: Vec<_> = seg
            .range(b"a", Some(b"c"), 9)
            .map(|(k, _, _)| k.to_vec())
            .collect();
        assert_eq!(bounded, vec![b"a".to_vec(), b"b".to_vec()]);
    }

    #[test]
    fn many_entries_cross_block_boundaries() {
        let mut entries = Vec::new();
        for i in 0..5000u32 {
            let key = format!("key{i:06}").into_bytes();
            entries.push(entry(&key, 1, Some(&[b'x'; 32])));
        }
        let (bytes, _) = encode(&entries, 1, 1, 1).unwrap();
        let seg = decode(&bytes).unwrap();
        assert_eq!(seg.entries.len(), 5000);
        assert_eq!(
            seg.get(b"key004999", 1),
            Some(Some(vec![b'x'; 32].as_ref()))
        );
    }

    #[test]
    fn corruption_is_detected() {
        let (mut bytes, _) = encode(&[entry(b"a", 1, Some(b"v"))], 1, 1, 0).unwrap();
        // Flip a byte inside the first data block (CRC-protected region).
        let header_len = u32::from_le_bytes(bytes[5..9].try_into().unwrap()) as usize;
        let block_at = 9 + header_len + 2;
        bytes[block_at] ^= 0xFF;
        assert!(decode(&bytes).is_err());
    }
}
