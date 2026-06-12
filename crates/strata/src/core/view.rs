//! The merged read view: round overlay → memtable → live segments, visibility
//! "newest version with txid ≤ at". Staging and serving reads share this type
//! — the overlay is what lets request *i+1* in a group-commit round see
//! request *i*'s staged effects (the savepoint replacement, 09 § write path).

use crate::core::memtable::Memtable;
use crate::core::segment::DecodedSegment;
use crate::{Key, Txid};
use std::collections::BTreeMap;
use std::sync::Arc;

/// Staged-but-uncommitted effects of earlier requests in the current round.
/// Values are post-image (`None` = staged delete); they sit above every
/// committed source.
pub type Overlay = BTreeMap<Key, Option<Vec<u8>>>;

pub struct View<'a> {
    pub overlay: Option<&'a Overlay>,
    pub mem: &'a Memtable,
    pub segments: &'a [Arc<DecodedSegment>],
    /// Visibility horizon (the branch head, or a clamp for forked/rewound reads).
    pub at: Txid,
}

impl View<'_> {
    pub fn get(&self, key: &[u8]) -> Option<Vec<u8>> {
        if let Some(overlay) = self.overlay {
            if let Some(v) = overlay.get(key) {
                return v.clone();
            }
        }
        if let Some(v) = self.mem.get(key, self.at) {
            return v.map(|b| b.to_vec());
        }
        // Newest segment version across runs (runs may overlap; txid decides).
        let mut best: Option<(Txid, Option<&[u8]>)> = None;
        for seg in self.segments {
            if key < seg.header.key_min.as_slice() || key > seg.header.key_max.as_slice() {
                continue;
            }
            // A segment's visible version is its newest ≤ at; compare across runs.
            let start = seg.entries.partition_point(|e| e.key.as_slice() < key);
            if let Some(e) = seg.entries[start..]
                .iter()
                .take_while(|e| e.key == key)
                .find(|e| e.txid <= self.at)
            {
                if best.is_none_or(|(t, _)| e.txid > t) {
                    best = Some((e.txid, e.value.as_deref()));
                }
            }
        }
        best.and_then(|(_, v)| v.map(|b| b.to_vec()))
    }

    /// Live `(key, value)` pairs in `[start, end)` as borrows into the view —
    /// the zero-copy path the hot recall channels use (a 10k×256-dim vector
    /// scan must not memcpy ~10 MB of embeddings per query). Tombstones
    /// shadow lower sources and are omitted.
    pub fn scan_refs<'v>(&'v self, start: &[u8], end: Option<&[u8]>) -> Vec<(&'v [u8], &'v [u8])> {
        // Winner per key: (txid, source priority, value) — overlay outranks
        // everything.
        type Merged<'v> = BTreeMap<&'v [u8], (Txid, u8, Option<&'v [u8]>)>;
        let mut merged: Merged<'v> = BTreeMap::new();
        let consider =
            |merged: &mut Merged<'v>, k: &'v [u8], txid: Txid, prio: u8, v: Option<&'v [u8]>| {
                match merged.get_mut(k) {
                    Some(cur) => {
                        if (txid, prio) > (cur.0, cur.1) {
                            *cur = (txid, prio, v);
                        }
                    }
                    None => {
                        merged.insert(k, (txid, prio, v));
                    }
                }
            };

        for seg in self.segments {
            for (k, t, v) in seg.range(start, end, self.at) {
                consider(&mut merged, k, t, 0, v);
            }
        }
        for (k, t, v) in self.mem.range(start, end, self.at) {
            consider(&mut merged, k, t, 1, v);
        }
        if let Some(overlay) = self.overlay {
            let upper = end.map(|e| e.to_vec());
            for (k, v) in overlay.range(start.to_vec()..) {
                if let Some(u) = &upper {
                    if k.as_slice() >= u.as_slice() {
                        break;
                    }
                }
                consider(&mut merged, k, Txid::MAX, 2, v.as_deref());
            }
        }

        merged
            .into_iter()
            .filter_map(|(k, (_, _, v))| v.map(|v| (k, v)))
            .collect()
    }

    /// Live `(key, value)` pairs in `[start, end)`, ascending, up to `limit`
    /// (`None` = unbounded), as owned copies.
    pub fn scan(
        &self,
        start: &[u8],
        end: Option<&[u8]>,
        limit: Option<usize>,
    ) -> Vec<(Key, Vec<u8>)> {
        let refs = self.scan_refs(start, end);
        let n = limit.unwrap_or(refs.len()).min(refs.len());
        refs[..n]
            .iter()
            .map(|(k, v)| (k.to_vec(), v.to_vec()))
            .collect()
    }

    /// Convenience: scan everything under a prefix.
    pub fn scan_prefix(&self, prefix: &[u8], limit: Option<usize>) -> Vec<(Key, Vec<u8>)> {
        let end = crate::codec::key::prefix_end(prefix);
        self.scan(prefix, end.as_deref(), limit)
    }

    /// Zero-copy prefix scan.
    pub fn scan_prefix_refs<'v>(&'v self, prefix: &[u8]) -> Vec<(&'v [u8], &'v [u8])> {
        let end = crate::codec::key::prefix_end(prefix);
        self.scan_refs(prefix, end.as_deref())
    }

    /// Last live key under a prefix (transcript seq assignment).
    pub fn last_in_prefix(&self, prefix: &[u8]) -> Option<(Key, Vec<u8>)> {
        self.scan_prefix(prefix, None).into_iter().next_back()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::segment::{decode, encode, Entry};
    use crate::Op;

    fn seg(entries: Vec<Entry>) -> Arc<DecodedSegment> {
        let min = entries.iter().map(|e| e.txid).min().unwrap_or(0);
        let max = entries.iter().map(|e| e.txid).max().unwrap_or(0);
        let (bytes, _) = encode(&entries, min, max, 0).unwrap();
        Arc::new(decode(&bytes).unwrap())
    }

    #[test]
    fn overlay_shadows_mem_shadows_segments() {
        let s = seg(vec![Entry {
            key: b"k".to_vec(),
            txid: 1,
            value: Some(b"seg".to_vec()),
        }]);
        let mut mem = Memtable::default();
        mem.apply(
            2,
            &[Op::Put {
                key: b"k".to_vec(),
                value: b"mem".to_vec(),
            }],
        );
        let mut overlay = Overlay::new();
        let segs = vec![s];

        let v = View {
            overlay: None,
            mem: &mem,
            segments: &segs,
            at: 9,
        };
        assert_eq!(v.get(b"k"), Some(b"mem".to_vec()));
        let v1 = View {
            overlay: None,
            mem: &mem,
            segments: &segs,
            at: 1,
        };
        assert_eq!(v1.get(b"k"), Some(b"seg".to_vec()), "txid horizon");

        overlay.insert(b"k".to_vec(), Some(b"ovl".to_vec()));
        let vo = View {
            overlay: Some(&overlay),
            mem: &mem,
            segments: &segs,
            at: 9,
        };
        assert_eq!(vo.get(b"k"), Some(b"ovl".to_vec()));

        overlay.insert(b"k".to_vec(), None);
        let vd = View {
            overlay: Some(&overlay),
            mem: &mem,
            segments: &segs,
            at: 9,
        };
        assert_eq!(vd.get(b"k"), None, "staged delete shadows");
        assert!(vd.scan(b"a", None, None).is_empty());
    }

    #[test]
    fn scan_merges_and_drops_tombstones() {
        let s = seg(vec![
            Entry {
                key: b"a".to_vec(),
                txid: 1,
                value: Some(b"1".to_vec()),
            },
            Entry {
                key: b"b".to_vec(),
                txid: 1,
                value: Some(b"1".to_vec()),
            },
        ]);
        let mut mem = Memtable::default();
        mem.apply(3, &[Op::Del { key: b"a".to_vec() }]);
        mem.apply(
            4,
            &[Op::Put {
                key: b"c".to_vec(),
                value: b"4".to_vec(),
            }],
        );
        let segs = vec![s];
        let v = View {
            overlay: None,
            mem: &mem,
            segments: &segs,
            at: 9,
        };
        let keys: Vec<_> = v
            .scan(b"a", None, None)
            .into_iter()
            .map(|(k, _)| k)
            .collect();
        assert_eq!(keys, vec![b"b".to_vec(), b"c".to_vec()]);
        // At txid 2 the delete is invisible.
        let v2 = View {
            overlay: None,
            mem: &mem,
            segments: &segs,
            at: 2,
        };
        let keys: Vec<_> = v2
            .scan(b"a", None, None)
            .into_iter()
            .map(|(k, _)| k)
            .collect();
        assert_eq!(keys, vec![b"a".to_vec(), b"b".to_vec()]);
    }
}
