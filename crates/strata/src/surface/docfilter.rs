//! Mongo-style filter subset: the grammar, caps, and validation port from
//! the libSQL engine's `docstore/filter.rs`; SQL emission is replaced by a
//! direct evaluator (`matches`) plus a planner over keyspace access paths
//! (09 § documents).
//!
//! Comparison semantics: an operator matches only within a value's type
//! class (numbers compare numerically across int/float; strings binary) — a
//! documented divergence from SQLite `->>` affinity, closer to document-store
//! convention. JSON `null` at a path counts as present for `$exists` but
//! never matches a comparison.

use crate::{Result, StrataError};
use serde_json::Value as Json;
use std::cmp::Ordering;

/// Maximum nesting of `$and`/`$or`/`$not` (ported cap).
pub const MAX_FILTER_DEPTH: usize = 32;
/// Maximum elements in a single `$in`/`$nin` array (ported cap).
pub const MAX_IN_ITEMS: usize = 1000;

fn invalid(msg: impl Into<String>) -> StrataError {
    StrataError::Invalid(msg.into())
}

pub fn valid_path(path: &str) -> Result<()> {
    if path.is_empty()
        || path.len() > 200
        || !path
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '.' || c == '-')
    {
        return Err(invalid(format!("bad field path: {path}")));
    }
    Ok(())
}

#[derive(Debug, Clone, PartialEq)]
pub enum Cmp {
    Eq,
    Ne,
    Gt,
    Gte,
    Lt,
    Lte,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Filter {
    True,
    And(Vec<Filter>),
    Or(Vec<Filter>),
    Not(Box<Filter>),
    Cmp {
        path: String,
        op: Cmp,
        value: Json,
    },
    In {
        path: String,
        values: Vec<Json>,
        negate: bool,
    },
    Exists {
        path: String,
        expected: bool,
    },
}

/// Parse + validate a filter document (ported grammar and caps).
pub fn parse(filter: &Json) -> Result<Filter> {
    parse_obj(filter, 0)
}

fn parse_obj(filter: &Json, depth: usize) -> Result<Filter> {
    if depth > MAX_FILTER_DEPTH {
        return Err(invalid(format!(
            "filter nested deeper than {MAX_FILTER_DEPTH}"
        )));
    }
    let Json::Object(map) = filter else {
        return Err(invalid("filter must be an object"));
    };
    if map.is_empty() {
        return Ok(Filter::True);
    }
    let mut clauses = Vec::new();
    for (key, val) in map {
        match key.as_str() {
            "$and" | "$or" => {
                let Json::Array(items) = val else {
                    return Err(invalid(format!("{key} expects an array")));
                };
                let parts: Result<Vec<Filter>> =
                    items.iter().map(|f| parse_obj(f, depth + 1)).collect();
                let parts = parts?;
                clauses.push(if key == "$and" {
                    Filter::And(parts)
                } else {
                    Filter::Or(parts)
                });
            }
            "$not" => clauses.push(Filter::Not(Box::new(parse_obj(val, depth + 1)?))),
            k if k.starts_with('$') => return Err(invalid(format!("unknown operator {k}"))),
            field => clauses.push(parse_field(field, val)?),
        }
    }
    Ok(if clauses.len() == 1 {
        clauses.pop().expect("one clause")
    } else {
        Filter::And(clauses)
    })
}

fn scalar(v: &Json) -> Result<Json> {
    match v {
        Json::Array(_) | Json::Object(_) => Err(invalid(
            "cannot compare against arrays/objects; use operators",
        )),
        other => Ok(other.clone()),
    }
}

fn parse_field(field: &str, val: &Json) -> Result<Filter> {
    valid_path(field)?;
    let path = field.to_string();
    if let Json::Object(ops) = val {
        if ops.keys().any(|k| k.starts_with('$')) {
            let mut parts = Vec::new();
            for (op, v) in ops {
                let f = match op.as_str() {
                    "$eq" => Filter::Cmp {
                        path: path.clone(),
                        op: Cmp::Eq,
                        value: scalar(v)?,
                    },
                    "$ne" => Filter::Cmp {
                        path: path.clone(),
                        op: Cmp::Ne,
                        value: scalar(v)?,
                    },
                    "$gt" => Filter::Cmp {
                        path: path.clone(),
                        op: Cmp::Gt,
                        value: scalar(v)?,
                    },
                    "$gte" => Filter::Cmp {
                        path: path.clone(),
                        op: Cmp::Gte,
                        value: scalar(v)?,
                    },
                    "$lt" => Filter::Cmp {
                        path: path.clone(),
                        op: Cmp::Lt,
                        value: scalar(v)?,
                    },
                    "$lte" => Filter::Cmp {
                        path: path.clone(),
                        op: Cmp::Lte,
                        value: scalar(v)?,
                    },
                    "$in" | "$nin" => {
                        let Json::Array(items) = v else {
                            return Err(invalid(format!("{op} expects an array")));
                        };
                        if items.len() > MAX_IN_ITEMS {
                            return Err(invalid(format!(
                                "{op} array exceeds {MAX_IN_ITEMS} items"
                            )));
                        }
                        let values: Result<Vec<Json>> = items.iter().map(scalar).collect();
                        Filter::In {
                            path: path.clone(),
                            values: values?,
                            negate: op == "$nin",
                        }
                    }
                    "$exists" => match v.as_bool() {
                        Some(expected) => Filter::Exists {
                            path: path.clone(),
                            expected,
                        },
                        None => return Err(invalid("$exists expects a boolean")),
                    },
                    other => return Err(invalid(format!("unknown operator {other}"))),
                };
                parts.push(f);
            }
            return Ok(if parts.len() == 1 {
                parts.pop().expect("one part")
            } else {
                Filter::And(parts)
            });
        }
    }
    Ok(Filter::Cmp {
        path,
        op: Cmp::Eq,
        value: scalar(val)?,
    })
}

// ---- evaluation ----

/// Value at a dot-path. `_id` aliases the document id field.
pub fn path_value<'a>(doc: &'a Json, path: &str) -> Option<&'a Json> {
    let mut cur = doc;
    for part in path.split('.') {
        cur = cur.as_object()?.get(part)?;
    }
    Some(cur)
}

/// Compare two scalar JSON values within type classes; `None` = incomparable
/// (different classes, or either side is null/missing).
pub fn cmp_scalar(a: &Json, b: &Json) -> Option<Ordering> {
    match (a, b) {
        (Json::Number(x), Json::Number(y)) => x.as_f64()?.partial_cmp(&y.as_f64()?),
        (Json::String(x), Json::String(y)) => Some(x.cmp(y)),
        (Json::Bool(x), Json::Bool(y)) => Some(x.cmp(y)),
        _ => None,
    }
}

pub fn matches(doc: &Json, filter: &Filter) -> bool {
    match filter {
        Filter::True => true,
        Filter::And(parts) => parts.iter().all(|f| matches(doc, f)),
        Filter::Or(parts) => parts.iter().any(|f| matches(doc, f)),
        Filter::Not(inner) => !matches(doc, inner),
        Filter::Cmp { path, op, value } => {
            // JSON null at the path behaves like missing for comparisons.
            let present = path_value(doc, path).filter(|v| !v.is_null());
            match op {
                Cmp::Eq => present.is_some_and(|v| cmp_scalar(v, value) == Some(Ordering::Equal)),
                // `$ne` is null-safe (ported `IS NOT` semantics): a missing
                // field is "not equal".
                Cmp::Ne => present.is_none_or(|v| cmp_scalar(v, value) != Some(Ordering::Equal)),
                Cmp::Gt => present.is_some_and(|v| cmp_scalar(v, value) == Some(Ordering::Greater)),
                Cmp::Gte => present.is_some_and(|v| {
                    matches!(
                        cmp_scalar(v, value),
                        Some(Ordering::Greater | Ordering::Equal)
                    )
                }),
                Cmp::Lt => present.is_some_and(|v| cmp_scalar(v, value) == Some(Ordering::Less)),
                Cmp::Lte => present.is_some_and(|v| {
                    matches!(cmp_scalar(v, value), Some(Ordering::Less | Ordering::Equal))
                }),
            }
        }
        Filter::In {
            path,
            values,
            negate,
        } => {
            let hit = path_value(doc, path)
                .filter(|v| !v.is_null())
                .is_some_and(|v| {
                    values
                        .iter()
                        .any(|c| cmp_scalar(v, c) == Some(Ordering::Equal))
                });
            hit != *negate
        }
        Filter::Exists { path, expected } => {
            // JSON null counts as present (ported `doc -> path IS NOT NULL`).
            (path_value(doc, path).is_some()) == *expected
        }
    }
}

// ---- planning ----

#[derive(Debug, Clone, PartialEq)]
pub enum Bound {
    Unbounded,
    Inclusive(Json),
    Exclusive(Json),
}

/// Access path chosen for a find. The residual filter always re-checks the
/// full predicate against the decoded document.
#[derive(Debug, Clone, PartialEq)]
pub enum Plan {
    /// `{_id: "…"}` — one point get.
    PointGet { id: String },
    /// One indexed conjunct: scan `DOC_IDX(coll, path, lo‥hi)`.
    IndexRange { path: String, lo: Bound, hi: Bound },
    /// `$in` over an indexed path: a union of point ranges.
    IndexUnion { path: String, values: Vec<Json> },
    /// No usable index — scan the collection.
    FullScan,
}

/// Pick an access path from the top-level conjunction (fixed selectivity
/// heuristic: `_id` > eq > `$in` > range; `$ne`/`$nin`/`$exists:false`/`$or`/
/// `$not` are never access paths).
pub fn plan(filter: &Filter, indexed_paths: &[String]) -> Plan {
    let conjuncts: Vec<&Filter> = match filter {
        Filter::And(parts) => parts.iter().collect(),
        other => vec![other],
    };
    let mut best: Option<(u8, Plan)> = None; // lower rank = better
    let consider = |rank: u8, plan: Plan, best: &mut Option<(u8, Plan)>| {
        if best.as_ref().is_none_or(|(r, _)| rank < *r) {
            *best = Some((rank, plan));
        }
    };
    for c in &conjuncts {
        match c {
            Filter::Cmp {
                path,
                op: Cmp::Eq,
                value,
            } => {
                if path == "_id" {
                    if let Json::String(id) = value {
                        consider(0, Plan::PointGet { id: id.clone() }, &mut best);
                    }
                } else if indexed_paths.contains(path) {
                    consider(
                        1,
                        Plan::IndexRange {
                            path: path.clone(),
                            lo: Bound::Inclusive(value.clone()),
                            hi: Bound::Inclusive(value.clone()),
                        },
                        &mut best,
                    );
                }
            }
            Filter::In {
                path,
                values,
                negate: false,
            } if indexed_paths.contains(path) => {
                consider(
                    2,
                    Plan::IndexUnion {
                        path: path.clone(),
                        values: values.clone(),
                    },
                    &mut best,
                );
            }
            Filter::Cmp { path, op, value } if indexed_paths.contains(path) => {
                let (lo, hi) = match op {
                    Cmp::Gt => (Bound::Exclusive(value.clone()), Bound::Unbounded),
                    Cmp::Gte => (Bound::Inclusive(value.clone()), Bound::Unbounded),
                    Cmp::Lt => (Bound::Unbounded, Bound::Exclusive(value.clone())),
                    Cmp::Lte => (Bound::Unbounded, Bound::Inclusive(value.clone())),
                    _ => continue,
                };
                consider(
                    3,
                    Plan::IndexRange {
                        path: path.clone(),
                        lo,
                        hi,
                    },
                    &mut best,
                );
            }
            _ => {}
        }
    }
    best.map(|(_, p)| p).unwrap_or(Plan::FullScan)
}

/// `sort: {"field": 1|-1, …}` — ported validation, applied in memory.
pub fn parse_sort(sort: &Json) -> Result<Vec<(String, bool)>> {
    let Json::Object(map) = sort else {
        return Err(invalid("sort must be an object"));
    };
    let mut out = Vec::new();
    for (field, dir) in map {
        valid_path(field)?;
        let asc = match dir.as_i64() {
            Some(1) => true,
            Some(-1) => false,
            _ => return Err(invalid("sort direction must be 1 or -1")),
        };
        out.push((field.clone(), asc));
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn nested(depth: usize) -> Json {
        let mut f = json!({ "a": 1 });
        for _ in 0..depth {
            f = json!({ "$not": f });
        }
        f
    }

    #[test]
    fn accepts_filters_at_the_depth_limit() {
        assert!(parse(&nested(MAX_FILTER_DEPTH - 1)).is_ok());
    }

    #[test]
    fn rejects_overdeep_filters_instead_of_overflowing() {
        assert!(matches!(
            parse(&nested(MAX_FILTER_DEPTH + 5)),
            Err(StrataError::Invalid(_))
        ));
    }

    #[test]
    fn rejects_oversized_in_arrays() {
        let big: Vec<i64> = (0..(MAX_IN_ITEMS as i64 + 1)).collect();
        assert!(parse(&json!({ "x": { "$in": big } })).is_err());
        let ok: Vec<i64> = (0..MAX_IN_ITEMS as i64).collect();
        assert!(parse(&json!({ "x": { "$in": ok } })).is_ok());
    }

    #[test]
    fn matches_implements_the_operator_semantics() {
        let doc = json!({"a": 5, "b": "x", "n": null, "nest": {"deep": 2}});
        let m = |f: Json| matches(&doc, &parse(&f).unwrap());
        assert!(m(json!({"a": 5})));
        assert!(!m(json!({"a": 6})));
        assert!(m(json!({"a": {"$gt": 4, "$lte": 5}})));
        assert!(!m(json!({"a": {"$gt": "4"}})), "cross-class never matches");
        assert!(m(json!({"missing": {"$ne": 1}})), "$ne is null-safe");
        assert!(
            m(json!({"n": {"$ne": 1}})),
            "json null behaves missing for cmp"
        );
        assert!(m(json!({"n": {"$exists": true}})), "json null exists");
        assert!(m(json!({"missing": {"$exists": false}})));
        assert!(m(json!({"a": {"$in": [1, 5]}})));
        assert!(m(json!({"a": {"$nin": [1, 2]}})));
        assert!(m(json!({"$or": [{"a": 9}, {"b": "x"}]})));
        assert!(m(json!({"$not": {"a": 9}})));
        assert!(m(json!({"nest.deep": 2})));
        // Empty $in matches nothing; empty $nin matches everything (ported).
        assert!(!m(json!({"a": {"$in": []}})));
        assert!(m(json!({"a": {"$nin": []}})));
    }

    #[test]
    fn planner_prefers_id_then_eq_then_in_then_range() {
        let idx = vec!["a".to_string(), "b".to_string()];
        let p = |f: Json| plan(&parse(&f).unwrap(), &idx);
        assert_eq!(
            p(json!({"_id": "x", "a": 1})),
            Plan::PointGet { id: "x".into() }
        );
        assert!(matches!(
            p(json!({"a": 1, "b": {"$gt": 2}})),
            Plan::IndexRange { path, lo: Bound::Inclusive(_), hi: Bound::Inclusive(_) } if path == "a"
        ));
        assert!(matches!(
            p(json!({"a": {"$in": [1, 2]}, "b": {"$gt": 0}})),
            Plan::IndexUnion { path, .. } if path == "a"
        ));
        assert!(matches!(
            p(json!({"b": {"$lte": 9}})),
            Plan::IndexRange { path, lo: Bound::Unbounded, hi: Bound::Inclusive(_) } if path == "b"
        ));
        assert_eq!(p(json!({"c": 1})), Plan::FullScan);
        assert_eq!(p(json!({"a": {"$ne": 1}})), Plan::FullScan);
    }
}
