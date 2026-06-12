//! Compaction: merge live runs into one full-coverage run (the snapshot
//! analog), honoring the version-retention floor; in erasure mode, rewrite
//! history below a forget txid so erased keys are simply not written
//! (09 § compaction, § erasure).

use crate::core::segment::{DecodedSegment, Entry};
use crate::Txid;
use std::cmp::Reverse;
use std::collections::BTreeMap;
use std::sync::Arc;

/// Version-retention floor F: a version of key k may be dropped only if a
/// newer version of k exists with txid ≤ F (so every read in (F, head] still
/// resolves). Tombstones drop below F once nothing older can resurrect the
/// key — and since the output is full-coverage, nothing can.
#[derive(Debug, Clone, Copy)]
pub enum Mode {
    /// Ordinary merge with floor F.
    Merge { floor: Txid },
    /// Erasure rewrite below X: surviving keys collapse to their newest
    /// version ≤ X (re-tagged at X) plus all versions > X; erased keys (no
    /// live version at X and none after) vanish entirely.
    EraseBelow { txid: Txid },
}

/// Merge `inputs` (live runs of one branch) into the output entry list,
/// visibility-complete up to `head`. Inputs may overlap in keyspace; entry
/// txids decide. Returns entries sorted (key asc, txid desc).
pub fn merge(inputs: &[Arc<DecodedSegment>], head: Txid, mode: Mode) -> Vec<Entry> {
    // Gather all versions ≤ head per key (newest first, deduped by txid —
    // a re-shipped run could duplicate a version; last writer wins).
    type VersionsByKey<'a> = BTreeMap<&'a [u8], BTreeMap<Reverse<Txid>, Option<&'a [u8]>>>;
    let mut by_key: VersionsByKey = BTreeMap::new();
    for seg in inputs {
        for e in &seg.entries {
            if e.txid > head {
                continue; // beyond a rewound head: masked, now physically dropped
            }
            by_key
                .entry(e.key.as_slice())
                .or_default()
                .entry(Reverse(e.txid))
                .or_insert(e.value.as_deref());
        }
    }

    let mut out: Vec<Entry> = Vec::new();
    for (key, versions) in by_key {
        match mode {
            Mode::Merge { floor } => {
                // Keep all versions above the floor, plus the newest ≤ floor
                // (the restore base for reads inside the fine window)…
                let mut kept: Vec<(Txid, Option<&[u8]>)> = Vec::new();
                let mut newest_at_or_below_floor: Option<(Txid, Option<&[u8]>)> = None;
                for (Reverse(t), v) in &versions {
                    if *t > floor {
                        kept.push((*t, *v));
                    } else if newest_at_or_below_floor.is_none() {
                        newest_at_or_below_floor = Some((*t, *v));
                    }
                }
                if let Some((t, v)) = newest_at_or_below_floor {
                    // …unless it's a tombstone with no live versions above it:
                    // the output is full-coverage, so the key just vanishes.
                    if v.is_some() || !kept.is_empty() {
                        kept.push((t, v));
                    }
                }
                // A tombstone shadowing nothing (newest kept version is a Del
                // at or below the floor) is also droppable when it's the only
                // version left.
                if kept.len() == 1 && kept[0].1.is_none() && kept[0].0 <= floor {
                    kept.clear();
                }
                for (t, v) in kept {
                    out.push(Entry {
                        key: key.to_vec(),
                        txid: t,
                        value: v.map(|b| b.to_vec()),
                    });
                }
            }
            Mode::EraseBelow { txid: x } => {
                // Versions above X survive verbatim.
                let mut kept: Vec<(Txid, Option<&[u8]>)> = Vec::new();
                let mut state_at_x: Option<(Txid, Option<&[u8]>)> = None;
                for (Reverse(t), v) in &versions {
                    if *t > x {
                        kept.push((*t, *v));
                    } else if state_at_x.is_none() {
                        state_at_x = Some((*t, *v));
                    }
                }
                // The pre-X history collapses to the state at X, re-tagged at
                // X — a live value survives (collapsed); a tombstone or
                // absent key leaves nothing below X at all.
                if let Some((_, Some(v))) = state_at_x {
                    kept.push((x, Some(v)));
                } else if state_at_x.is_some() && !kept.is_empty() {
                    // Key was dead at X but lives again later: drop the
                    // pre-X history entirely (the later Put stands alone).
                }
                if kept.iter().all(|(_, v)| v.is_none()) {
                    continue; // only tombstones left — vanish
                }
                for (t, v) in kept {
                    out.push(Entry {
                        key: key.to_vec(),
                        txid: t,
                        value: v.map(|b| b.to_vec()),
                    });
                }
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::segment::{decode, encode};

    fn seg(entries: Vec<Entry>) -> Arc<DecodedSegment> {
        let min = entries.iter().map(|e| e.txid).min().unwrap_or(0);
        let max = entries.iter().map(|e| e.txid).max().unwrap_or(0);
        let mut sorted = entries;
        sorted.sort_by(|a, b| (&a.key, Reverse(a.txid)).cmp(&(&b.key, Reverse(b.txid))));
        let (bytes, _) = encode(&sorted, min, max, 0).unwrap();
        Arc::new(decode(&bytes).unwrap())
    }

    fn e(key: &[u8], txid: Txid, value: Option<&[u8]>) -> Entry {
        Entry {
            key: key.to_vec(),
            txid,
            value: value.map(|v| v.to_vec()),
        }
    }

    #[test]
    fn merge_keeps_versions_above_floor_and_one_base_below() {
        let s1 = seg(vec![e(b"k", 2, Some(b"v2")), e(b"k", 5, Some(b"v5"))]);
        let s2 = seg(vec![e(b"k", 8, Some(b"v8"))]);
        let out = merge(&[s1, s2], 10, Mode::Merge { floor: 6 });
        let txids: Vec<Txid> = out.iter().map(|x| x.txid).collect();
        // v8 above floor; v5 is the base (newest ≤ 6); v2 dropped.
        assert_eq!(txids, vec![8, 5]);
    }

    #[test]
    fn merge_drops_fully_dead_keys_below_floor() {
        let s = seg(vec![e(b"k", 2, Some(b"v")), e(b"k", 4, None)]);
        let out = merge(&[s], 10, Mode::Merge { floor: 6 });
        assert!(
            out.is_empty(),
            "tombstoned history below the floor vanishes"
        );
        // But above the floor the tombstone must survive (PITR to txid 3).
        let s = seg(vec![e(b"k", 2, Some(b"v")), e(b"k", 4, None)]);
        let out = merge(&[s], 10, Mode::Merge { floor: 1 });
        assert_eq!(out.len(), 2);
    }

    #[test]
    fn merge_respects_rewound_head() {
        let s = seg(vec![e(b"k", 2, Some(b"v2")), e(b"k", 9, Some(b"v9"))]);
        let out = merge(&[s], 5, Mode::Merge { floor: 0 });
        let txids: Vec<Txid> = out.iter().map(|x| x.txid).collect();
        assert_eq!(txids, vec![2], "entries beyond the head are dropped");
    }

    #[test]
    fn erase_collapses_history_and_vanishes_forgotten_keys() {
        let kept = seg(vec![
            e(b"keep", 2, Some(b"old")),
            e(b"keep", 4, Some(b"mid")),
            e(b"keep", 9, Some(b"new")),
        ]);
        let gone = seg(vec![e(b"gone", 3, Some(b"secret")), e(b"gone", 6, None)]);
        let out = merge(&[kept, gone], 10, Mode::EraseBelow { txid: 7 });
        // "gone" was tombstoned before X=7 → no trace at all.
        assert!(out.iter().all(|x| x.key != b"gone"));
        // "keep" collapses to state-at-7 (re-tagged 7) + the post-X version.
        let keep: Vec<(Txid, Option<&[u8]>)> = out
            .iter()
            .filter(|x| x.key == b"keep")
            .map(|x| (x.txid, x.value.as_deref()))
            .collect();
        assert_eq!(
            keep,
            vec![(9, Some(b"new".as_ref())), (7, Some(b"mid".as_ref()))]
        );
        // Nothing in the output carries a txid below X except the collapse tag.
        assert!(out.iter().all(|x| x.txid >= 7));
    }
}
