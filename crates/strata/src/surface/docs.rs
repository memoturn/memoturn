//! Document collections on the keyspace: canonical-JSON bodies under DOC,
//! dot-path index rows under DOC_IDX maintained alongside every write, and
//! the planner from `docfilter` choosing point gets / index ranges / scans.
//! Update operators (`$set/$unset/$inc/$push`) apply to the decoded document
//! during staging — ported semantics from `docstore/update.rs`, no SQL.

use crate::codec::key::{self, prefix_end};
use crate::codec::record::{self, DocMetaRecord, DocRecord};
use crate::core::view::View;
use crate::surface::docfilter::{self, matches, parse, parse_sort, path_value, plan, Bound, Plan};
use crate::{now_ms, Op, Result, StrataError};
use serde_json::Value as Json;

pub struct FindOpts {
    pub sort: Option<Json>,
    pub limit: u32,
    pub skip: u32,
}

impl Default for FindOpts {
    fn default() -> Self {
        Self {
            sort: None,
            limit: 100,
            skip: 0,
        }
    }
}

pub fn valid_collection(collection: &str) -> Result<()> {
    if collection.is_empty()
        || collection.len() > 64
        || !collection
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        return Err(StrataError::Invalid(format!(
            "invalid collection name: {collection}"
        )));
    }
    Ok(())
}

fn indexed_paths(view: &View<'_>, collection: &str) -> Result<Vec<String>> {
    match view.get(&key::doc_meta(collection)) {
        Some(bytes) => {
            let DocMetaRecord::V1 { indexed_paths } = record::decode(&bytes)?;
            Ok(indexed_paths)
        }
        None => Ok(Vec::new()),
    }
}

/// Index rows for one document over the collection's indexed paths. Only
/// scalar values are indexed (arrays/objects fall to the residual matcher).
fn index_ops(collection: &str, id: &str, doc: &Json, paths: &[String], del: bool) -> Vec<Op> {
    let mut ops = Vec::new();
    for path in paths {
        if let Some(v) = path_value(doc, path) {
            if v.is_array() || v.is_object() {
                continue;
            }
            let k = key::doc_idx(collection, path, v, id);
            ops.push(if del {
                Op::Del { key: k }
            } else {
                Op::Put {
                    key: k,
                    value: Vec::new(),
                }
            });
        }
    }
    ops
}

// ---- writes ----

pub fn stage_insert(
    view: &View<'_>,
    collection: &str,
    docs: Vec<Json>,
) -> Result<(Vec<Op>, Vec<String>)> {
    valid_collection(collection)?;
    let paths = indexed_paths(view, collection)?;
    let now = now_ms();
    let mut ops = Vec::new();
    let mut ids = Vec::with_capacity(docs.len());
    for mut doc in docs {
        let Json::Object(ref mut map) = doc else {
            return Err(StrataError::Invalid("documents must be objects".into()));
        };
        let id = match map.get("_id") {
            Some(Json::String(s)) => s.clone(),
            None => {
                let id = uuid::Uuid::new_v4().simple().to_string();
                map.insert("_id".into(), Json::String(id.clone()));
                id
            }
            Some(_) => return Err(StrataError::Invalid("_id must be a string".into())),
        };
        ops.push(Op::Put {
            key: key::doc(collection, &id),
            value: record::encode(&DocRecord::V1 {
                json: doc.to_string().into_bytes(),
                created_at: now,
                updated_at: now,
            }),
        });
        ops.extend(index_ops(collection, &id, &doc, &paths, false));
        ids.push(id);
    }
    Ok((ops, ids))
}

fn decode_doc(bytes: &[u8]) -> Result<(Json, i64)> {
    let DocRecord::V1 {
        json, created_at, ..
    } = record::decode(bytes)?;
    let doc = serde_json::from_slice(&json)
        .map_err(|e| StrataError::Corrupt(format!("doc body: {e}")))?;
    Ok((doc, created_at))
}

/// Execute the access path, returning candidate `(id, doc, created_at)` —
/// the residual filter is applied by the caller.
fn candidates(view: &View<'_>, collection: &str, p: &Plan) -> Result<Vec<(String, Json, i64)>> {
    let mut out = Vec::new();
    let push_id = |view: &View<'_>, id: &str, out: &mut Vec<(String, Json, i64)>| -> Result<()> {
        if let Some(bytes) = view.get(&key::doc(collection, id)) {
            let (doc, created) = decode_doc(&bytes)?;
            out.push((id.to_string(), doc, created));
        }
        Ok(())
    };
    match p {
        Plan::PointGet { id } => push_id(view, id, &mut out)?,
        Plan::IndexUnion { path, values } => {
            let mut seen = std::collections::HashSet::new();
            for v in values {
                let prefix = key::doc_idx_value_prefix(collection, path, v);
                for (k, _) in view.scan_prefix(&prefix, None) {
                    if let Some((id, _)) = decode_idx_id(&k) {
                        if seen.insert(id.clone()) {
                            push_id(view, &id, &mut out)?;
                        }
                    }
                }
            }
        }
        Plan::IndexRange { path, lo, hi } => {
            let path_prefix = key::doc_idx_path_prefix(collection, path);
            let start = match lo {
                Bound::Unbounded => path_prefix.clone(),
                Bound::Inclusive(v) | Bound::Exclusive(v) => {
                    key::doc_idx_value_prefix(collection, path, v)
                }
            };
            let end_owned = match hi {
                Bound::Unbounded => prefix_end(&path_prefix),
                Bound::Inclusive(v) | Bound::Exclusive(v) => {
                    prefix_end(&key::doc_idx_value_prefix(collection, path, v))
                }
            };
            // Exclusive bounds re-check exactly via the residual; the range
            // only needs to be a superset within the path's keyspace.
            for (k, _) in view.scan(&start, end_owned.as_deref(), None) {
                if let Some((id, _)) = decode_idx_id(&k) {
                    push_id(view, &id, &mut out)?;
                }
            }
        }
        Plan::FullScan => {
            for (k, v) in view.scan_prefix(&key::doc_prefix(collection), None) {
                let Some((id, _)) = decode_doc_id(&k) else {
                    continue;
                };
                let (doc, created) = decode_doc(&v)?;
                out.push((id, doc, created));
            }
        }
    }
    Ok(out)
}

/// Doc id off a DOC_IDX key (last string component).
fn decode_idx_id(k: &[u8]) -> Option<(String, usize)> {
    // tag, str(coll), str(path), scalar, str(id) — walk from the front.
    let (_, after_coll) = key::decode_str(k, 1)?;
    let (_, after_path) = key::decode_str(k, after_coll)?;
    let after_scalar = match *k.get(after_path)? {
        0x01..=0x03 | 0x06 => after_path + 1,
        0x04 => after_path + 9,
        0x05 => key::decode_str(k, after_path + 1)?.1,
        _ => return None,
    };
    key::decode_str(k, after_scalar)
}

/// Doc id off a DOC key (second string component).
fn decode_doc_id(k: &[u8]) -> Option<(String, usize)> {
    let (_, after_coll) = key::decode_str(k, 1)?;
    key::decode_str(k, after_coll)
}

pub fn find(
    view: &View<'_>,
    collection: &str,
    filter_json: &Json,
    opts: FindOpts,
) -> Result<Vec<Json>> {
    valid_collection(collection)?;
    let filter = parse(filter_json)?;
    let paths = indexed_paths(view, collection)?;
    let p = plan(&filter, &paths);
    let mut rows: Vec<(String, Json, i64)> = candidates(view, collection, &p)?
        .into_iter()
        .filter(|(_, doc, _)| matches(doc, &filter))
        .collect();
    match &opts.sort {
        Some(s) => {
            let keys = parse_sort(s)?;
            rows.sort_by(|(_, a, _), (_, b, _)| {
                for (path, asc) in &keys {
                    let av = path_value(a, path);
                    let bv = path_value(b, path);
                    let ord = match (av, bv) {
                        (Some(x), Some(y)) => {
                            docfilter::cmp_scalar(x, y).unwrap_or(std::cmp::Ordering::Equal)
                        }
                        (None, Some(_)) => std::cmp::Ordering::Less,
                        (Some(_), None) => std::cmp::Ordering::Greater,
                        (None, None) => std::cmp::Ordering::Equal,
                    };
                    let ord = if *asc { ord } else { ord.reverse() };
                    if ord != std::cmp::Ordering::Equal {
                        return ord;
                    }
                }
                std::cmp::Ordering::Equal
            });
        }
        // Stable default: insertion-ish order via created_at, then id.
        None => rows.sort_by(|a, b| (a.2, &a.0).cmp(&(b.2, &b.0))),
    }
    Ok(rows
        .into_iter()
        .skip(opts.skip as usize)
        .take(opts.limit as usize)
        .map(|(_, doc, _)| doc)
        .collect())
}

/// Apply update operators to a decoded document (ported operator set).
pub fn apply_update(doc: &mut Json, update: &Json) -> Result<()> {
    let Json::Object(ops) = update else {
        return Err(StrataError::Invalid("update must be an object".into()));
    };
    if ops.is_empty() || ops.keys().any(|k| !k.starts_with('$')) {
        return Err(StrataError::Invalid(
            "update must use operators ($set/$unset/$inc/$push)".into(),
        ));
    }
    for (op, fields) in ops {
        let Json::Object(fields) = fields else {
            return Err(StrataError::Invalid(format!("{op} expects an object")));
        };
        for (path, val) in fields {
            if path == "_id" {
                return Err(StrataError::Invalid("bad update path: _id".into()));
            }
            docfilter::valid_path(path)?;
            match op.as_str() {
                "$set" => set_path(doc, path, val.clone()),
                "$unset" => unset_path(doc, path),
                "$inc" => {
                    let by = val
                        .as_f64()
                        .ok_or_else(|| StrataError::Invalid("$inc expects a number".into()))?;
                    let cur = path_value(doc, path)
                        .and_then(|v| v.as_f64())
                        .unwrap_or(0.0);
                    let next = cur + by;
                    let as_int = val.is_i64()
                        && path_value(doc, path).is_none_or(|v| v.is_i64() || v.is_null());
                    let v = if as_int && next.fract() == 0.0 {
                        Json::from(next as i64)
                    } else {
                        serde_json::Number::from_f64(next)
                            .map(Json::Number)
                            .unwrap_or(Json::Null)
                    };
                    set_path(doc, path, v);
                }
                "$push" => {
                    match path_value(doc, path) {
                        Some(Json::Array(_)) => {
                            if let Some(Json::Array(arr)) = path_value_mut(doc, path) {
                                arr.push(val.clone());
                            }
                        }
                        // Missing → new single-element array (jsonb_insert
                        // on a missing path creates it).
                        None => set_path(doc, path, Json::Array(vec![val.clone()])),
                        Some(_) => {} // non-array target: no-op (ported tolerance)
                    }
                }
                other => {
                    return Err(StrataError::Invalid(format!("unknown operator {other}")));
                }
            }
        }
    }
    Ok(())
}

fn set_path(doc: &mut Json, path: &str, value: Json) {
    let parts: Vec<&str> = path.split('.').collect();
    let mut cur = doc;
    for (i, part) in parts.iter().enumerate() {
        if !cur.is_object() {
            *cur = Json::Object(Default::default());
        }
        let map = cur.as_object_mut().expect("just ensured object");
        if i == parts.len() - 1 {
            map.insert((*part).to_string(), value);
            return;
        }
        cur = map
            .entry((*part).to_string())
            .or_insert_with(|| Json::Object(Default::default()));
    }
}

fn unset_path(doc: &mut Json, path: &str) {
    let parts: Vec<&str> = path.split('.').collect();
    let mut cur = doc;
    for (i, part) in parts.iter().enumerate() {
        let Some(map) = cur.as_object_mut() else {
            return;
        };
        if i == parts.len() - 1 {
            map.remove(*part);
            return;
        }
        match map.get_mut(*part) {
            Some(next) => cur = next,
            None => return,
        }
    }
}

fn path_value_mut<'a>(doc: &'a mut Json, path: &str) -> Option<&'a mut Json> {
    let mut cur = doc;
    for part in path.split('.') {
        cur = cur.as_object_mut()?.get_mut(part)?;
    }
    Some(cur)
}

/// Stage an update: plan → candidates → residual → rewrite docs + index rows.
pub fn stage_update(
    view: &View<'_>,
    collection: &str,
    filter_json: &Json,
    update_json: &Json,
    multi: bool,
) -> Result<(Vec<Op>, u64)> {
    valid_collection(collection)?;
    let filter = parse(filter_json)?;
    let paths = indexed_paths(view, collection)?;
    let p = plan(&filter, &paths);
    let now = now_ms();
    let mut ops = Vec::new();
    let mut modified = 0u64;
    for (id, mut doc, created_at) in candidates(view, collection, &p)? {
        if !matches(&doc, &filter) {
            continue;
        }
        ops.extend(index_ops(collection, &id, &doc, &paths, true));
        apply_update(&mut doc, update_json)?;
        ops.push(Op::Put {
            key: key::doc(collection, &id),
            value: record::encode(&DocRecord::V1 {
                json: doc.to_string().into_bytes(),
                created_at,
                updated_at: now,
            }),
        });
        ops.extend(index_ops(collection, &id, &doc, &paths, false));
        modified += 1;
        if !multi {
            break;
        }
    }
    Ok((ops, modified))
}

pub fn stage_delete(
    view: &View<'_>,
    collection: &str,
    filter_json: &Json,
    multi: bool,
) -> Result<(Vec<Op>, u64)> {
    valid_collection(collection)?;
    let filter = parse(filter_json)?;
    let paths = indexed_paths(view, collection)?;
    let p = plan(&filter, &paths);
    let mut ops = Vec::new();
    let mut deleted = 0u64;
    for (id, doc, _) in candidates(view, collection, &p)? {
        if !matches(&doc, &filter) {
            continue;
        }
        ops.push(Op::Del {
            key: key::doc(collection, &id),
        });
        ops.extend(index_ops(collection, &id, &doc, &paths, true));
        deleted += 1;
        if !multi {
            break;
        }
    }
    Ok((ops, deleted))
}

/// Register a dot-path index and backfill it from the live collection.
pub fn stage_create_index(view: &View<'_>, collection: &str, path: &str) -> Result<Vec<Op>> {
    valid_collection(collection)?;
    docfilter::valid_path(path)?;
    let mut paths = indexed_paths(view, collection)?;
    if paths.iter().any(|p| p == path) {
        return Ok(Vec::new());
    }
    paths.push(path.to_string());
    let mut ops = vec![Op::Put {
        key: key::doc_meta(collection),
        value: record::encode(&DocMetaRecord::V1 {
            indexed_paths: paths,
        }),
    }];
    let single = [path.to_string()];
    for (k, v) in view.scan_prefix(&key::doc_prefix(collection), None) {
        let Some((id, _)) = decode_doc_id(&k) else {
            continue;
        };
        let (doc, _) = decode_doc(&v)?;
        ops.extend(index_ops(collection, &id, &doc, &single, false));
    }
    Ok(ops)
}
