//! Conversation transcripts: append-ordered turns per session, window reads,
//! brute-force semantic search — the `__memoturn_messages` contract on MSG
//! keys. Seq assignment reads the session's last key inside the single-writer
//! round (race-free by construction).

use crate::codec::key;
use crate::codec::record::{self, TurnRecord};
use crate::core::view::View;
use crate::surface::vector::cosine_distance;
use crate::{now_ms, Op, Result};
use serde_json::{json, Value as Json};

pub fn stage_append(
    view: &View<'_>,
    session: &str,
    role: &str,
    content: &Json,
    embedding: Option<Vec<f32>>,
) -> Result<(Vec<Op>, u64)> {
    let prefix = key::msg_prefix(session);
    let next_seq = match view.last_in_prefix(&prefix) {
        Some((k, _)) => key::u64_at(&k, k.len() - 8).map_or(1, |s| s + 1),
        None => 1,
    };
    let rec = TurnRecord::V1 {
        role: role.to_string(),
        content: content.to_string().into_bytes(),
        embedding,
        created_at: now_ms(),
    };
    let ops = vec![Op::Put {
        key: key::msg(session, next_seq),
        value: record::encode(&rec),
    }];
    Ok((ops, next_seq))
}

fn turn_json(session: &str, seq: u64, rec: &TurnRecord) -> Json {
    let TurnRecord::V1 {
        role,
        content,
        created_at,
        ..
    } = rec;
    json!({
        "session_id": session,
        "seq": seq,
        "role": role,
        "content": serde_json::from_slice::<Json>(content).unwrap_or(Json::Null),
        "created_at": created_at,
    })
}

/// The last `n` turns of a session, oldest first.
pub fn get_window(view: &View<'_>, session: &str, last: u32) -> Result<Vec<Json>> {
    let mut rows = view.scan_prefix(&key::msg_prefix(session), None);
    let skip = rows.len().saturating_sub(last as usize);
    rows.drain(..skip);
    rows.into_iter()
        .map(|(k, v)| {
            let seq = key::u64_at(&k, k.len() - 8).unwrap_or(0);
            Ok(turn_json(session, seq, &record::decode(&v)?))
        })
        .collect()
}

/// Brute-force cosine search over turn embeddings, optionally session-scoped.
pub fn search(
    view: &View<'_>,
    session: Option<&str>,
    embedding: &[f32],
    k: u32,
) -> Result<Vec<Json>> {
    let prefix = match session {
        Some(s) => key::msg_prefix(s),
        None => vec![key::tag::MSG],
    };
    let mut scored: Vec<(f32, Json)> = Vec::new();
    for (kbytes, v) in view.scan_prefix(&prefix, None) {
        let rec: TurnRecord = record::decode(&v)?;
        let TurnRecord::V1 {
            embedding: stored, ..
        } = &rec;
        let Some(stored) = stored else { continue };
        if stored.len() != embedding.len() {
            continue;
        }
        let dist = cosine_distance(embedding, stored);
        let seq = key::u64_at(&kbytes, kbytes.len() - 8).unwrap_or(0);
        let sid = key::decode_str(&kbytes, 1)
            .map(|(s, _)| s)
            .unwrap_or_default();
        let mut j = turn_json(&sid, seq, &rec);
        j["distance"] = json!(dist);
        scored.push((dist, j));
    }
    scored.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
    scored.truncate(k as usize);
    Ok(scored.into_iter().map(|(_, j)| j).collect())
}
