//! The per-branch memtable: a versioned ordered map holding every op since
//! the last flush. Never authoritative — always reconstructible from the
//! local log / WAL chunks, which is what makes rewind a discard.

use crate::{Key, Op, Txid};
use std::collections::BTreeMap;
use std::ops::Bound;

/// Versions per key, newest txid first. `None` value = tombstone.
type Versions = Vec<(Txid, Option<Vec<u8>>)>;

#[derive(Debug, Default)]
pub struct Memtable {
    map: BTreeMap<Key, Versions>,
    approx_bytes: usize,
}

impl Memtable {
    pub fn apply(&mut self, txid: Txid, ops: &[Op]) {
        for op in ops {
            let (key, value) = match op {
                Op::Put { key, value } => (key, Some(value.clone())),
                Op::Del { key } => (key, None),
            };
            self.approx_bytes += key.len() + value.as_ref().map_or(0, |v| v.len()) + 24;
            let versions = self.map.entry(key.clone()).or_default();
            // Same-round overwrite: last op wins for one (key, txid).
            if let Some(first) = versions.first_mut() {
                if first.0 == txid {
                    *first = (txid, value);
                    continue;
                }
            }
            versions.insert(0, (txid, value));
        }
    }

    /// Newest version at or below `at`. Outer `None` = the memtable holds no
    /// visible version (fall through to segments); inner `None` = tombstone.
    pub fn get(&self, key: &[u8], at: Txid) -> Option<Option<&[u8]>> {
        self.map
            .get(key)?
            .iter()
            .find(|(t, _)| *t <= at)
            .map(|(_, v)| v.as_deref())
    }

    /// All keys in `[start, end)` with a version ≤ `at`, with that version.
    pub fn range<'a>(
        &'a self,
        start: &[u8],
        end: Option<&[u8]>,
        at: Txid,
    ) -> impl Iterator<Item = (&'a [u8], Txid, Option<&'a [u8]>)> + 'a {
        let upper = match end {
            Some(e) => Bound::Excluded(e.to_vec()),
            None => Bound::Unbounded,
        };
        self.map
            .range((Bound::Included(start.to_vec()), upper))
            .filter_map(move |(k, versions)| {
                versions
                    .iter()
                    .find(|(t, _)| *t <= at)
                    .map(|(t, v)| (k.as_slice(), *t, v.as_deref()))
            })
    }

    /// Every version, for flushing into a segment: (key, txid, value),
    /// key-ascending, txid-descending within a key.
    pub fn all_versions(&self) -> impl Iterator<Item = (&[u8], Txid, Option<&[u8]>)> {
        self.map.iter().flat_map(|(k, versions)| {
            versions
                .iter()
                .map(move |(t, v)| (k.as_slice(), *t, v.as_deref()))
        })
    }

    pub fn is_empty(&self) -> bool {
        self.map.is_empty()
    }

    pub fn approx_bytes(&self) -> usize {
        self.approx_bytes
    }

    pub fn clear(&mut self) {
        self.map.clear();
        self.approx_bytes = 0;
    }

    pub fn min_txid(&self) -> Option<Txid> {
        self.map
            .values()
            .flat_map(|v| v.iter().map(|(t, _)| *t))
            .min()
    }

    pub fn max_txid(&self) -> Option<Txid> {
        self.map
            .values()
            .flat_map(|v| v.iter().map(|(t, _)| *t))
            .max()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn put(k: &[u8], v: &[u8]) -> Op {
        Op::Put {
            key: k.to_vec(),
            value: v.to_vec(),
        }
    }

    #[test]
    fn versions_resolve_by_txid() {
        let mut m = Memtable::default();
        m.apply(1, &[put(b"k", b"v1")]);
        m.apply(3, &[put(b"k", b"v3")]);
        m.apply(5, &[Op::Del { key: b"k".to_vec() }]);
        assert_eq!(m.get(b"k", 1), Some(Some(b"v1".as_ref())));
        assert_eq!(m.get(b"k", 2), Some(Some(b"v1".as_ref())));
        assert_eq!(m.get(b"k", 4), Some(Some(b"v3".as_ref())));
        assert_eq!(m.get(b"k", 5), Some(None), "tombstone visible");
        assert_eq!(m.get(b"k", 0), None, "before first version");
        assert_eq!(m.get(b"x", 9), None);
    }

    #[test]
    fn same_txid_overwrite_keeps_last() {
        let mut m = Memtable::default();
        m.apply(2, &[put(b"k", b"a"), put(b"k", b"b")]);
        assert_eq!(m.get(b"k", 2), Some(Some(b"b".as_ref())));
        assert_eq!(
            m.all_versions().count(),
            1,
            "one version per (key, txid) round"
        );
    }

    #[test]
    fn range_respects_bounds_and_txid() {
        let mut m = Memtable::default();
        m.apply(1, &[put(b"a", b"1"), put(b"c", b"3")]);
        m.apply(4, &[put(b"b", b"2")]);
        let at2: Vec<_> = m.range(b"a", None, 2).map(|(k, _, _)| k.to_vec()).collect();
        assert_eq!(at2, vec![b"a".to_vec(), b"c".to_vec()]);
        let bounded: Vec<_> = m
            .range(b"a", Some(b"c"), 9)
            .map(|(k, _, _)| k.to_vec())
            .collect();
        assert_eq!(bounded, vec![b"a".to_vec(), b"b".to_vec()]);
    }
}
