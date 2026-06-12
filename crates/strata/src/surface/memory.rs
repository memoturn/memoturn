//! Typed agent memory on the keyspace (ADR-0009 semantics, 09 § memory):
//! content-addressed idempotent ingest, supersession by `(type, topic_key)`
//! via the MEM_ACTIVE head, hybrid recall (topic + BM25 postings + flat
//! vector scan, RRF-fused), retention sweeps, and forget as the complete
//! derived key set. Staging replaces savepoints: a batch stages into one op
//! vector that enters the commit record whole or not at all.

use crate::codec::key;
use crate::codec::record::{
    self, encode_embedding, FtsPosting, FtsStats, FtsStatsV1, MemoryRecord, MemoryV1, MetaRecord,
    SessionRecord,
};
use crate::core::view::View;
use crate::fuse::{rrf_merge, tokens, W_FTS, W_TOPIC, W_VEC};
use crate::surface::fts::{bm25, postings_for, CandidateHits};
use crate::surface::vector::cosine_distance_le_bytes;
use crate::{now_ms, Op, Result, StrataError};
use serde_json::{json, Value as Json};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};

/// Default task-memory TTL (same contract as the libSQL engine).
pub const DEFAULT_TASK_TTL_SECS: u64 = 86_400;

/// Deletions per maintenance pass — deletes are writes (they flush and ship),
/// so each pass is bounded; the next pass continues the backlog.
const POLICY_SWEEP_LIMIT: usize = 500;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum MemoryType {
    Fact,
    Event,
    Instruction,
    Task,
}

impl MemoryType {
    pub fn parse(s: &str) -> Result<Self> {
        match s {
            "fact" => Ok(Self::Fact),
            "event" => Ok(Self::Event),
            "instruction" => Ok(Self::Instruction),
            "task" => Ok(Self::Task),
            other => Err(StrataError::Invalid(format!(
                "unknown memory type: {other}"
            ))),
        }
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Fact => "fact",
            Self::Event => "event",
            Self::Instruction => "instruction",
            Self::Task => "task",
        }
    }

    /// Stable discriminant byte used in keys (never renumber).
    pub fn byte(&self) -> u8 {
        match self {
            Self::Fact => 0,
            Self::Event => 1,
            Self::Instruction => 2,
            Self::Task => 3,
        }
    }

    pub fn from_byte(b: u8) -> Result<Self> {
        match b {
            0 => Ok(Self::Fact),
            1 => Ok(Self::Event),
            2 => Ok(Self::Instruction),
            3 => Ok(Self::Task),
            other => Err(StrataError::Corrupt(format!(
                "bad memory type byte {other}"
            ))),
        }
    }

    /// Facts and instructions supersede prior active memories on the same topic.
    fn supersedes(&self) -> bool {
        matches!(self, Self::Fact | Self::Instruction)
    }
}

#[derive(Debug, Clone)]
pub struct MemoryInput {
    pub mtype: MemoryType,
    pub topic_key: Option<String>,
    pub summary: String,
    pub content: Json,
    pub keywords: Option<String>,
    pub embedding: Option<Vec<f32>>,
    pub session_id: Option<String>,
    /// Provenance, not identity: excluded from the content-addressed id, so
    /// the same memory from two agents dedupes and the first writer's source wins.
    pub source: Option<String>,
    pub ttl_secs: Option<u64>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct IngestOutcome {
    pub id: String,
    pub status: &'static str, // "created" | "duplicate" | "revived"
    pub superseded: Vec<String>,
}

/// Governance memory-age rules (ADR-0010). `None` = unbounded.
#[derive(Debug, Clone, Default)]
pub struct MemoryRules {
    pub event_max_age_secs: Option<u64>,
    pub superseded_max_age_secs: Option<u64>,
    pub superseded_max_count: Option<u64>,
}

impl MemoryRules {
    pub fn any(&self) -> bool {
        self.event_max_age_secs.is_some()
            || self.superseded_max_age_secs.is_some()
            || self.superseded_max_count.is_some()
    }
}

/// Content-addressed memory id, byte-identical to the libSQL engine's
/// (`memories.rs::memory_id`): workspace serde_json sorts map keys, so
/// `content.to_string()` is canonical for equal JSON values.
pub fn memory_id(mtype: MemoryType, topic_key: Option<&str>, content: &Json) -> String {
    id_string(&memory_id16(mtype, topic_key, content))
}

pub fn memory_id16(mtype: MemoryType, topic_key: Option<&str>, content: &Json) -> [u8; 16] {
    let mut hasher = Sha256::new();
    hasher.update(mtype.as_str().as_bytes());
    hasher.update([0]);
    hasher.update(topic_key.unwrap_or("").as_bytes());
    hasher.update([0]);
    hasher.update(content.to_string().as_bytes());
    let digest = hasher.finalize();
    let mut id = [0u8; 16];
    id.copy_from_slice(&digest[..16]);
    id
}

pub fn id_string(id: &[u8; 16]) -> String {
    let mut hex = String::with_capacity(36);
    hex.push_str("mem_");
    for b in id {
        hex.push_str(&format!("{b:02x}"));
    }
    hex
}

pub fn id_bytes(id: &str) -> Option<[u8; 16]> {
    let hex = id.strip_prefix("mem_")?;
    if hex.len() != 32 {
        return None;
    }
    let mut out = [0u8; 16];
    for i in 0..16 {
        out[i] = u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16).ok()?;
    }
    Some(out)
}

fn validate(item: &MemoryInput) -> Result<()> {
    if item.summary.trim().is_empty() {
        return Err(StrataError::Invalid(
            "memory summary must not be empty".into(),
        ));
    }
    if item.topic_key.is_some() && !item.mtype.supersedes() {
        return Err(StrataError::Invalid(
            "topic_key is only valid on fact/instruction memories".into(),
        ));
    }
    if matches!(&item.embedding, Some(e) if e.is_empty()) {
        return Err(StrataError::Invalid("empty embedding".into()));
    }
    if item.ttl_secs.is_some() && item.mtype != MemoryType::Task {
        return Err(StrataError::Invalid(
            "ttl is only valid on task memories".into(),
        ));
    }
    Ok(())
}

fn read_record(view: &View<'_>, id16: &[u8; 16]) -> Result<Option<MemoryV1>> {
    match view.get(&key::mem(id16)) {
        Some(bytes) => Ok(Some(record::decode::<MemoryRecord>(&bytes)?.v1())),
        None => Ok(None),
    }
}

fn read_active(view: &View<'_>, mtype: MemoryType, topic: &str) -> Option<[u8; 16]> {
    view.get(&key::mem_active(mtype.byte(), topic))
        .and_then(|v| v.try_into().ok())
}

fn read_stats(view: &View<'_>) -> Result<FtsStatsV1> {
    match view.get(&key::fts_stats()) {
        Some(bytes) => Ok(record::decode::<FtsStats>(&bytes)?.v1()),
        None => Ok(FtsStatsV1::default()),
    }
}

fn read_vec_dim(view: &View<'_>) -> Result<Option<u32>> {
    match view.get(&key::meta("vec_dim")) {
        Some(bytes) => match record::decode::<MetaRecord>(&bytes)? {
            MetaRecord::VecDimV1(d) => Ok(Some(d)),
        },
        None => Ok(None),
    }
}

// ---- ingest ----

/// Stage an atomic ingest batch. Idempotent by content-addressed id;
/// re-asserting a superseded memory revives it; facts/instructions with a
/// `topic_key` supersede the prior active head (history preserved).
pub fn stage_ingest(
    view: &View<'_>,
    items: &[MemoryInput],
) -> Result<(Vec<Op>, Vec<IngestOutcome>)> {
    for item in items {
        validate(item)?;
    }
    let now = now_ms();
    let mut ops: Vec<Op> = Vec::new();
    let mut outcomes = Vec::with_capacity(items.len());
    // Records to (re)write at the end — created, revived, and superseded
    // rows all funnel through here so each MEM key is Put exactly once.
    let mut records: HashMap<[u8; 16], MemoryV1> = HashMap::new();
    let mut record_order: Vec<[u8; 16]> = Vec::new();
    let mut seen: HashSet<[u8; 16]> = HashSet::new();
    // Last id made active per (type byte, topic) in this batch (ported
    // shape: each new active supersedes the previous; the first supersedes
    // the DB's current head).
    let mut last_active: HashMap<(u8, String), [u8; 16]> = HashMap::new();
    let mut sessions_touched: HashMap<String, SessionRecord> = HashMap::new();
    let mut stats = read_stats(view)?;
    let stats_before = stats;
    let mut target_dim = read_vec_dim(view)?;
    let dim_was_set = target_dim.is_some();

    let upsert_record = |records: &mut HashMap<[u8; 16], MemoryV1>,
                         order: &mut Vec<[u8; 16]>,
                         id: [u8; 16],
                         rec: MemoryV1| {
        if records.insert(id, rec).is_none() {
            order.push(id);
        }
    };

    for item in items {
        let id16 = memory_id16(item.mtype, item.topic_key.as_deref(), &item.content);
        let id = id_string(&id16);
        let existing = match records.get(&id16) {
            Some(r) => Some(r.clone()),
            None => read_record(view, &id16)?,
        };
        let in_batch = !seen.insert(id16);
        let active_already = existing
            .as_ref()
            .map(|r| r.superseded_by.is_none())
            .unwrap_or(false);
        if in_batch || active_already {
            outcomes.push(IngestOutcome {
                id,
                status: "duplicate",
                superseded: vec![],
            });
            continue;
        }
        let reviving = existing.is_some();

        // Supersession target: the current head for this (type, topic).
        let mut superseded: Vec<[u8; 16]> = Vec::new();
        if let (true, Some(topic)) = (item.mtype.supersedes(), &item.topic_key) {
            let tkey = (item.mtype.byte(), topic.clone());
            let head = match last_active.get(&tkey) {
                Some(prev) => Some(*prev),
                None => read_active(view, item.mtype, topic),
            };
            if let Some(h) = head {
                if h != id16 {
                    superseded.push(h);
                }
            }
            last_active.insert(tkey, id16);
        }

        if let Some(mut rec) = existing {
            // Revive: clear the tombstone; FTS/vector/membership rows are
            // already present (supersession never removes them).
            rec.superseded_by = None;
            rec.superseded_at = None;
            upsert_record(&mut records, &mut record_order, id16, rec);
        } else {
            let expires_at = match item.mtype {
                MemoryType::Task => {
                    Some(now + (item.ttl_secs.unwrap_or(DEFAULT_TASK_TTL_SECS) as i64) * 1000)
                }
                _ => None,
            };
            let keywords = item.keywords.clone().unwrap_or_default();
            let summary_tokens = tokens(&item.summary).len() as u32;
            let keywords_tokens = tokens(&keywords).len() as u32;
            let rec = MemoryV1 {
                id: id16,
                mtype: item.mtype.byte(),
                topic_key: item.topic_key.clone(),
                summary: item.summary.clone(),
                content: item.content.to_string().into_bytes(),
                keywords: keywords.clone(),
                session_id: item.session_id.clone(),
                source: item.source.clone(),
                created_at: now,
                expires_at,
                superseded_by: None,
                superseded_at: None,
                summary_tokens,
                keywords_tokens,
            };
            // Membership + index rows.
            if let (true, Some(topic)) = (item.mtype.supersedes(), &item.topic_key) {
                ops.push(Op::Put {
                    key: key::mem_topic(item.mtype.byte(), topic, &id16),
                    value: Vec::new(),
                });
            }
            if let Some(sid) = &item.session_id {
                ops.push(Op::Put {
                    key: key::mem_session(sid, &id16),
                    value: Vec::new(),
                });
            }
            if let Some(exp) = expires_at {
                ops.push(Op::Put {
                    key: key::mem_expires(exp as u64, &id16),
                    value: Vec::new(),
                });
            }
            for (term, posting) in postings_for(&item.summary, &keywords) {
                ops.push(Op::Put {
                    key: key::fts_term(&term, &id16),
                    value: record::encode(&posting),
                });
            }
            stats.doc_count += 1;
            stats.total_summary_tokens += summary_tokens as u64;
            stats.total_keywords_tokens += keywords_tokens as u64;
            // Tasks skip the vector channel; mismatched dimensions are
            // skipped (keyword + topic stay searchable), never a batch error.
            if item.mtype != MemoryType::Task {
                if let Some(emb) = &item.embedding {
                    let dim = *target_dim.get_or_insert(emb.len() as u32);
                    if emb.len() as u32 == dim {
                        ops.push(Op::Put {
                            key: key::vec_entry(&id16),
                            value: encode_embedding(emb),
                        });
                    }
                }
            }
            upsert_record(&mut records, &mut record_order, id16, rec);
        }

        // Sessions registry (created_at preserved across batch upserts).
        if let Some(sid) = &item.session_id {
            let entry = sessions_touched.entry(sid.clone()).or_insert_with(|| {
                match view
                    .get(&key::session(sid))
                    .and_then(|b| record::decode::<SessionRecord>(&b).ok())
                {
                    Some(SessionRecord::V1 { created_at, .. }) => SessionRecord::V1 {
                        created_at,
                        last_active_at: now,
                    },
                    None => SessionRecord::V1 {
                        created_at: now,
                        last_active_at: now,
                    },
                }
            });
            let SessionRecord::V1 { last_active_at, .. } = entry;
            *last_active_at = now;
        }

        // Tombstone the superseded head.
        for s in &superseded {
            let mut prev = match records.get(s) {
                Some(r) => r.clone(),
                None => match read_record(view, s)? {
                    Some(r) => r,
                    None => continue, // dangling head pointer — repointed below
                },
            };
            prev.superseded_by = Some(id16);
            prev.superseded_at = Some(now);
            upsert_record(&mut records, &mut record_order, *s, prev);
        }

        outcomes.push(IngestOutcome {
            id,
            status: if reviving { "revived" } else { "created" },
            superseded: superseded.iter().map(id_string).collect(),
        });
    }

    for ((tbyte, topic), id16) in &last_active {
        ops.push(Op::Put {
            key: key::mem_active(*tbyte, topic),
            value: id16.to_vec(),
        });
    }
    for id16 in &record_order {
        let rec = records.remove(id16).expect("ordered ids are in the map");
        ops.push(Op::Put {
            key: key::mem(id16),
            value: record::encode(&MemoryRecord::V1(rec)),
        });
    }
    for (sid, rec) in &sessions_touched {
        ops.push(Op::Put {
            key: key::session(sid),
            value: record::encode(rec),
        });
    }
    if stats != stats_before {
        ops.push(Op::Put {
            key: key::fts_stats(),
            value: record::encode(&FtsStats::V1(stats)),
        });
    }
    if !dim_was_set {
        if let Some(dim) = target_dim {
            ops.push(Op::Put {
                key: key::meta("vec_dim"),
                value: record::encode(&MetaRecord::VecDimV1(dim)),
            });
        }
    }
    Ok((ops, outcomes))
}

// ---- forget / sweeps ----

/// The complete derived key set for one record — the erasure-coupon list
/// (09 § erasure): base row, head pointer, memberships, postings, vector.
fn forget_ops(view: &View<'_>, rec: &MemoryV1, stats: &mut FtsStatsV1) -> Vec<Op> {
    let id16 = rec.id;
    let mut ops = vec![Op::Del {
        key: key::mem(&id16),
    }];
    if let Some(topic) = &rec.topic_key {
        if read_active_byte(view, rec.mtype, topic) == Some(id16) {
            ops.push(Op::Del {
                key: key::mem_active(rec.mtype, topic),
            });
        }
        ops.push(Op::Del {
            key: key::mem_topic(rec.mtype, topic, &id16),
        });
    }
    if let Some(sid) = &rec.session_id {
        ops.push(Op::Del {
            key: key::mem_session(sid, &id16),
        });
    }
    if let Some(exp) = rec.expires_at {
        ops.push(Op::Del {
            key: key::mem_expires(exp as u64, &id16),
        });
    }
    for term in postings_for(&rec.summary, &rec.keywords).keys() {
        ops.push(Op::Del {
            key: key::fts_term(term, &id16),
        });
    }
    stats.doc_count = stats.doc_count.saturating_sub(1);
    stats.total_summary_tokens = stats
        .total_summary_tokens
        .saturating_sub(rec.summary_tokens as u64);
    stats.total_keywords_tokens = stats
        .total_keywords_tokens
        .saturating_sub(rec.keywords_tokens as u64);
    ops.push(Op::Del {
        key: key::vec_entry(&id16),
    });
    ops
}

fn read_active_byte(view: &View<'_>, tbyte: u8, topic: &str) -> Option<[u8; 16]> {
    view.get(&key::mem_active(tbyte, topic))
        .and_then(|v| v.try_into().ok())
}

fn stats_put(stats: FtsStatsV1, before: FtsStatsV1, ops: &mut Vec<Op>) {
    if stats != before {
        ops.push(Op::Put {
            key: key::fts_stats(),
            value: record::encode(&FtsStats::V1(stats)),
        });
    }
}

/// Hard-delete one memory. Returns (ops, rows deleted — 0 if already gone).
pub fn stage_forget(view: &View<'_>, id: &str) -> Result<(Vec<Op>, u64)> {
    let Some(id16) = id_bytes(id) else {
        return Ok((Vec::new(), 0));
    };
    let Some(rec) = read_record(view, &id16)? else {
        return Ok((Vec::new(), 0));
    };
    let mut stats = read_stats(view)?;
    let before = stats;
    let mut ops = forget_ops(view, &rec, &mut stats);
    stats_put(stats, before, &mut ops);
    Ok((ops, 1))
}

/// Hard-delete an entire topic: the active row and its whole supersession
/// chain (erasure path, ADR-0010). Returns (ops, ids removed).
pub fn stage_forget_topic(
    view: &View<'_>,
    mtype: MemoryType,
    topic: &str,
) -> Result<(Vec<Op>, Vec<String>)> {
    let mut stats = read_stats(view)?;
    let before = stats;
    let mut ops = Vec::new();
    let mut ids = Vec::new();
    for (k, _) in view.scan_prefix(&key::mem_topic_prefix(mtype.byte(), topic), None) {
        let Some(id16) = key::trailing_id16(&k) else {
            continue;
        };
        if let Some(rec) = read_record(view, &id16)? {
            ops.extend(forget_ops(view, &rec, &mut stats));
            ids.push(id_string(&id16));
        }
    }
    if read_active_byte(view, mtype.byte(), topic).is_some() {
        ops.push(Op::Del {
            key: key::mem_active(mtype.byte(), topic),
        });
    }
    stats_put(stats, before, &mut ops);
    Ok((ops, ids))
}

/// End a session: delete its task memories (durable memories survive their
/// session) and the session row; optionally the transcript too.
pub fn stage_end_session(
    view: &View<'_>,
    session: &str,
    drop_turns: bool,
) -> Result<(Vec<Op>, u64)> {
    let mut stats = read_stats(view)?;
    let before = stats;
    let mut ops = Vec::new();
    let mut deleted = 0u64;
    for (k, _) in view.scan_prefix(&key::mem_session_prefix(session), None) {
        let Some(id16) = key::trailing_id16(&k) else {
            continue;
        };
        if let Some(rec) = read_record(view, &id16)? {
            if rec.mtype == MemoryType::Task.byte() {
                ops.extend(forget_ops(view, &rec, &mut stats));
                deleted += 1;
            }
        }
    }
    ops.push(Op::Del {
        key: key::session(session),
    });
    if drop_turns {
        // Prototype: the range delete is expanded at staging time (09 notes
        // the production design journals a range tombstone instead).
        for (k, _) in view.scan_prefix(&key::msg_prefix(session), None) {
            ops.push(Op::Del { key: k });
        }
    }
    stats_put(stats, before, &mut ops);
    Ok((ops, deleted))
}

/// Sweep expired task memories via the MEM_EXPIRES index (bounded pass).
pub fn stage_sweep_expired(view: &View<'_>) -> Result<(Vec<Op>, u64)> {
    let now = now_ms();
    let mut stats = read_stats(view)?;
    let before = stats;
    let mut ops = Vec::new();
    let mut swept = 0u64;
    for (k, _) in view.scan_prefix(&key::mem_expires_prefix(), None) {
        let Some(exp) = key::u64_at(&k, 1) else {
            continue;
        };
        if exp as i64 > now || swept as usize >= POLICY_SWEEP_LIMIT {
            break; // index is expiry-ordered
        }
        let Some(id16) = key::trailing_id16(&k) else {
            continue;
        };
        match read_record(view, &id16)? {
            Some(rec) => ops.extend(forget_ops(view, &rec, &mut stats)),
            // Dangling index entry (row already forgotten) — drop it.
            None => ops.push(Op::Del { key: k }),
        }
        swept += 1;
    }
    stats_put(stats, before, &mut ops);
    Ok((ops, swept))
}

/// Delete memories the namespace policy has aged out (ported semantics:
/// superseded rows past an age or per-topic count cap, events past max age).
pub fn stage_enforce_policy(view: &View<'_>, rules: &MemoryRules) -> Result<(Vec<Op>, u64)> {
    if !rules.any() {
        return Ok((Vec::new(), 0));
    }
    let now = now_ms();
    let mut doomed: Vec<MemoryV1> = Vec::new();
    let mut doomed_ids: HashSet<[u8; 16]> = HashSet::new();
    // Per (type, topic): superseded rows newest-first for the count cap.
    type Chains = HashMap<(u8, String), Vec<(i64, [u8; 16])>>;
    let mut chains: Chains = HashMap::new();
    let mut by_id: HashMap<[u8; 16], MemoryV1> = HashMap::new();

    for (_, v) in view.scan_prefix(&key::mem_prefix(), None) {
        let rec = record::decode::<MemoryRecord>(&v)?.v1();
        if let (Some(age), Some(at)) = (rules.superseded_max_age_secs, rec.superseded_at) {
            if at <= now - (age as i64) * 1000 && doomed_ids.insert(rec.id) {
                doomed.push(rec.clone());
            }
        }
        if let (Some(age), true) = (
            rules.event_max_age_secs,
            rec.mtype == MemoryType::Event.byte(),
        ) {
            if rec.created_at <= now - (age as i64) * 1000 && doomed_ids.insert(rec.id) {
                doomed.push(rec.clone());
            }
        }
        if rules.superseded_max_count.is_some() {
            if let (Some(topic), Some(at)) = (&rec.topic_key, rec.superseded_at) {
                chains
                    .entry((rec.mtype, topic.clone()))
                    .or_default()
                    .push((at, rec.id));
                by_id.insert(rec.id, rec.clone());
            }
        }
    }
    if let Some(cnt) = rules.superseded_max_count {
        for (_, mut rows) in chains {
            rows.sort_by(|a, b| b.cmp(a)); // newest superseded first
            for (_, id) in rows.into_iter().skip(cnt as usize) {
                if doomed_ids.insert(id) {
                    if let Some(rec) = by_id.get(&id) {
                        doomed.push(rec.clone());
                    }
                }
            }
        }
    }
    doomed.truncate(POLICY_SWEEP_LIMIT);

    let mut stats = read_stats(view)?;
    let before = stats;
    let mut ops = Vec::new();
    let n = doomed.len() as u64;
    for rec in &doomed {
        ops.extend(forget_ops(view, rec, &mut stats));
    }
    stats_put(stats, before, &mut ops);
    Ok((ops, n))
}

// ---- recall / reads ----

#[derive(Debug, Clone, Default)]
pub struct RecallQuery {
    pub query: Option<String>,
    pub embedding: Option<Vec<f32>>,
    pub topic_key: Option<String>,
    pub types: Option<Vec<MemoryType>>,
    pub session_id: Option<String>,
    pub source: Option<String>,
    pub k: u32,
    pub include_superseded: bool,
}

/// The per-channel filter pushdown (ported contract: filters run inside each
/// channel so wanted rows aren't starved out of the candidate window).
fn passes(rec: &MemoryV1, q: &RecallQuery, now: i64) -> bool {
    if !q.include_superseded && rec.superseded_by.is_some() {
        return false;
    }
    if let Some(exp) = rec.expires_at {
        if exp <= now {
            return false;
        }
    }
    if let Some(types) = &q.types {
        // An explicit empty type list matches nothing (ported semantics).
        if !types.iter().any(|t| t.byte() == rec.mtype) {
            return false;
        }
    }
    if let Some(sid) = &q.session_id {
        if rec.session_id.as_deref() != Some(sid.as_str()) {
            return false;
        }
    }
    if let Some(src) = &q.source {
        if rec.source.as_deref() != Some(src.as_str()) {
            return false;
        }
    }
    true
}

fn rec_json(rec: &MemoryV1, extra: Option<(f64, &[&'static str])>) -> Json {
    let content: Json = serde_json::from_slice(&rec.content).unwrap_or(Json::Null);
    let mut o = json!({
        "id": id_string(&rec.id),
        "type": MemoryType::from_byte(rec.mtype).map(|t| t.as_str()).unwrap_or("fact"),
        "topic_key": rec.topic_key,
        "summary": rec.summary,
        "content": content,
        "keywords": rec.keywords,
        "session_id": rec.session_id,
        "source": rec.source,
        "created_at": rec.created_at,
        "superseded_by": rec.superseded_by.as_ref().map(id_string),
    });
    if let Some((score, chans)) = extra {
        o["score"] = json!(score);
        o["channels"] = json!(chans);
    }
    o
}

/// Hybrid recall: topic head/chain + BM25 postings + flat vector scan,
/// RRF-merged (ported weights), ranked memory JSON. Empty is a valid answer.
pub fn recall(view: &View<'_>, q: &RecallQuery) -> Result<Vec<Json>> {
    if q.query.is_none() && q.embedding.is_none() && q.topic_key.is_none() {
        return Err(StrataError::Invalid(
            "recall requires at least one of query, embedding, topic_key".into(),
        ));
    }
    if matches!(&q.embedding, Some(e) if e.is_empty()) {
        return Err(StrataError::Invalid("empty embedding".into()));
    }
    let now = now_ms();
    let k = q.k.max(1) as usize;
    let fetch = k * 5;
    let mut channels: Vec<(&'static str, f64, Vec<String>)> = Vec::new();
    let mut recs: HashMap<[u8; 16], MemoryV1> = HashMap::new();
    let load = |recs: &mut HashMap<[u8; 16], MemoryV1>,
                view: &View<'_>,
                id16: [u8; 16]|
     -> Option<MemoryV1> {
        if let Some(r) = recs.get(&id16) {
            return Some(r.clone());
        }
        let r = read_record(view, &id16).ok().flatten()?;
        recs.insert(id16, r.clone());
        Some(r)
    };

    if let Some(topic) = &q.topic_key {
        let mut hits: Vec<(i64, [u8; 16])> = Vec::new();
        for mtype in [MemoryType::Fact, MemoryType::Instruction] {
            for (k2, _) in view.scan_prefix(&key::mem_topic_prefix(mtype.byte(), topic), None) {
                let Some(id16) = key::trailing_id16(&k2) else {
                    continue;
                };
                if let Some(rec) = load(&mut recs, view, id16) {
                    if passes(&rec, q, now) {
                        hits.push((rec.created_at, id16));
                    }
                }
            }
        }
        hits.sort_by(|a, b| b.cmp(a)); // created_at desc
        hits.truncate(fetch);
        channels.push((
            "topic",
            W_TOPIC,
            hits.iter().map(|(_, id)| id_string(id)).collect(),
        ));
    }

    if let Some(text) = &q.query {
        let query_terms: Vec<String> = {
            let mut t = tokens(text);
            t.dedup();
            t.sort();
            t.dedup();
            t
        };
        if !query_terms.is_empty() {
            let mut dfs: Vec<u64> = vec![0; query_terms.len()];
            let mut cands: HashMap<[u8; 16], CandidateHits> = HashMap::new();
            for (ti, term) in query_terms.iter().enumerate() {
                for (k2, v) in view.scan_prefix_refs(&key::fts_term_prefix(term)) {
                    dfs[ti] += 1;
                    let Some(id16) = key::trailing_id16(k2) else {
                        continue;
                    };
                    let FtsPosting::V1 {
                        tf_summary,
                        tf_keywords,
                    } = record::decode::<FtsPosting>(v)?;
                    cands
                        .entry(id16)
                        .or_default()
                        .hits
                        .push((ti, tf_summary, tf_keywords));
                }
            }
            let stats = read_stats(view)?;
            let mut scored: Vec<(f64, [u8; 16])> = Vec::new();
            for (id16, hits) in &cands {
                let Some(rec) = load(&mut recs, view, *id16) else {
                    continue;
                };
                if !passes(&rec, q, now) {
                    continue;
                }
                scored.push((
                    bm25(hits, &dfs, &stats, rec.summary_tokens, rec.keywords_tokens),
                    *id16,
                ));
            }
            scored.sort_by(|a, b| b.partial_cmp(a).unwrap_or(std::cmp::Ordering::Equal));
            scored.truncate(fetch);
            channels.push((
                "keyword",
                W_FTS,
                scored.iter().map(|(_, id)| id_string(id)).collect(),
            ));
        }
    }

    if let Some(emb) = &q.embedding {
        // Dimension mismatch degrades the channel to empty, never an error
        // (ported best-effort posture).
        let dim_ok = read_vec_dim(view)?.map(|d| d as usize == emb.len());
        if dim_ok == Some(true) {
            // Zero-copy flat scan: distances computed straight off the
            // stored LE bytes — no per-vector decode or memcpy.
            let mut dists: Vec<(f32, [u8; 16])> = Vec::new();
            for (k2, v) in view.scan_prefix_refs(&key::vec_prefix()) {
                let Some(id16) = key::trailing_id16(k2) else {
                    continue;
                };
                if v.len() == emb.len() * 4 {
                    dists.push((cosine_distance_le_bytes(emb, v), id16));
                }
            }
            dists.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
            // Continue-until-fetch: the filter walks past non-matching
            // neighbors instead of starving the pool.
            let mut ids = Vec::new();
            for (_, id16) in dists {
                if let Some(rec) = load(&mut recs, view, id16) {
                    if passes(&rec, q, now) {
                        ids.push(id_string(&id16));
                        if ids.len() >= fetch {
                            break;
                        }
                    }
                }
            }
            channels.push(("vector", W_VEC, ids));
        }
    }

    let merged = rrf_merge(&channels);
    let mut out = Vec::new();
    for (id, score, chans) in merged {
        let Some(id16) = id_bytes(&id) else { continue };
        let Some(rec) = load(&mut recs, view, id16) else {
            continue;
        };
        if !passes(&rec, q, now) {
            continue;
        }
        out.push(rec_json(&rec, Some((score, &chans))));
        if out.len() >= k {
            break;
        }
    }
    Ok(out)
}

/// One memory by id, with its supersession chain.
pub fn get(view: &View<'_>, id: &str) -> Result<Option<Json>> {
    let Some(id16) = id_bytes(id) else {
        return Ok(None);
    };
    let Some(rec) = read_record(view, &id16)? else {
        return Ok(None);
    };
    // `supersedes` = ids this row replaced: chain members pointing at us.
    let mut supersedes = Vec::new();
    if let Some(topic) = &rec.topic_key {
        for (k, _) in view.scan_prefix(&key::mem_topic_prefix(rec.mtype, topic), None) {
            if let Some(other) = key::trailing_id16(&k) {
                if other != id16 {
                    if let Some(o) = read_record(view, &other)? {
                        if o.superseded_by == Some(id16) {
                            supersedes.push(id_string(&other));
                        }
                    }
                }
            }
        }
    }
    let mut o = rec_json(&rec, None);
    o["expires_at"] = json!(rec.expires_at);
    o["superseded_at"] = json!(rec.superseded_at);
    o["supersedes"] = json!(supersedes);
    Ok(Some(o))
}

/// Sessions seen by ingest, most recently active first.
pub fn list_sessions(view: &View<'_>, limit: u32) -> Result<Vec<Json>> {
    let mut rows: Vec<(i64, Json)> = Vec::new();
    for (k, v) in view.scan_prefix(&key::sessions_prefix(), None) {
        let Some((sid, _)) = key::decode_str(&k, 1) else {
            continue;
        };
        let SessionRecord::V1 {
            created_at,
            last_active_at,
        } = record::decode::<SessionRecord>(&v)?;
        rows.push((
            last_active_at,
            json!({ "id": sid, "created_at": created_at, "last_active_at": last_active_at }),
        ));
    }
    rows.sort_by_key(|r| std::cmp::Reverse(r.0));
    rows.truncate(limit as usize);
    Ok(rows.into_iter().map(|(_, j)| j).collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn id_is_stable_and_content_addressed() {
        let a = memory_id(MemoryType::Fact, Some("user.theme"), &json!({"v": "dark"}));
        let b = memory_id(MemoryType::Fact, Some("user.theme"), &json!({"v": "dark"}));
        assert_eq!(a, b);
        assert!(a.starts_with("mem_"));
        assert_eq!(a.len(), 36);
        let c = memory_id(MemoryType::Fact, Some("user.theme"), &json!({"v": "light"}));
        assert_ne!(a, c);
        let d = memory_id(MemoryType::Event, Some("user.theme"), &json!({"v": "dark"}));
        assert_ne!(a, d);
        let e = memory_id(MemoryType::Fact, None, &json!({"v": "dark"}));
        assert_ne!(a, e);
    }

    #[test]
    fn id_ignores_key_order() {
        // Pins the canonicality assumption: workspace serde_json must keep
        // sorted-key maps (no preserve_order feature).
        let a: Json = serde_json::from_str(r#"{"b": 1, "a": 2}"#).unwrap();
        let b: Json = serde_json::from_str(r#"{"a": 2, "b": 1}"#).unwrap();
        assert_eq!(
            memory_id(MemoryType::Fact, None, &a),
            memory_id(MemoryType::Fact, None, &b)
        );
    }

    #[test]
    fn id_string_round_trips_bytes() {
        let id16 = memory_id16(MemoryType::Fact, Some("t"), &json!({"x": 1}));
        let s = id_string(&id16);
        assert_eq!(id_bytes(&s), Some(id16));
        assert_eq!(id_bytes("mem_short"), None);
        assert_eq!(id_bytes("nope"), None);
    }

    #[test]
    fn validate_rejects_bad_inputs() {
        let base = || MemoryInput {
            mtype: MemoryType::Fact,
            topic_key: None,
            summary: "s".into(),
            content: json!({}),
            keywords: None,
            embedding: None,
            session_id: None,
            source: None,
            ttl_secs: None,
        };
        assert!(validate(&base()).is_ok());
        let mut m = base();
        m.summary = "  ".into();
        assert!(validate(&m).is_err());
        let mut m = base();
        m.mtype = MemoryType::Event;
        m.topic_key = Some("k".into());
        assert!(validate(&m).is_err());
        let mut m = base();
        m.embedding = Some(vec![]);
        assert!(validate(&m).is_err());
        let mut m = base();
        m.ttl_secs = Some(60);
        assert!(validate(&m).is_err());
        let mut m = base();
        m.mtype = MemoryType::Task;
        m.ttl_secs = Some(60);
        assert!(validate(&m).is_ok());
    }
}
