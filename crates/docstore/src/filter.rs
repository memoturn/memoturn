//! Mongo-style filter subset → SQL over JSONB (ADR-0006).
//!
//! Supported: field equality, `$eq $ne $gt $gte $lt $lte $in $nin $exists`,
//! `$and $or $not`, dot-path fields. Field paths are validated and embedded
//! as JSON-path literals; all values are bound parameters.

use crate::{DocError, Result};
use memoturn_engine::Value;
use serde_json::Value as Json;

pub struct Compiled {
    pub where_sql: String,
    pub params: Vec<Value>,
}

/// Maximum nesting of `$and`/`$or`/`$not`. Bounds recursion so a pathological
/// filter cannot exhaust the stack; far deeper than any real agent query.
pub const MAX_FILTER_DEPTH: usize = 32;

/// Maximum elements in a single `$in`/`$nin` array. Each element binds a SQL
/// parameter and grows the compiled statement; an unbounded list is a cheap way
/// to force expensive compilation/execution.
pub const MAX_IN_ITEMS: usize = 1000;

pub fn compile(filter: &Json) -> Result<Compiled> {
    let mut params = Vec::new();
    let sql = compile_obj(filter, &mut params, 0)?;
    Ok(Compiled {
        where_sql: sql,
        params,
    })
}

fn valid_path(path: &str) -> Result<()> {
    if path.is_empty()
        || path.len() > 200
        || !path
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '.' || c == '-')
    {
        return Err(DocError::InvalidFilter(format!("bad field path: {path}")));
    }
    Ok(())
}

/// `a.b.c` → SQL expression extracting the field as a primitive.
fn field_expr(path: &str) -> Result<String> {
    valid_path(path)?;
    if path == "_id" {
        return Ok("id".to_string());
    }
    Ok(format!("doc ->> '$.{path}'"))
}

/// Same, but as JSON (for existence checks).
fn field_json_expr(path: &str) -> Result<String> {
    valid_path(path)?;
    Ok(format!("doc -> '$.{path}'"))
}

fn bind(v: &Json, params: &mut Vec<Value>) -> Result<String> {
    match v {
        Json::Array(_) | Json::Object(_) => Err(DocError::InvalidFilter(
            "cannot compare against arrays/objects; use operators".into(),
        )),
        other => {
            params.push(Value::from_json(other));
            Ok("?".to_string())
        }
    }
}

fn compile_obj(filter: &Json, params: &mut Vec<Value>, depth: usize) -> Result<String> {
    if depth > MAX_FILTER_DEPTH {
        return Err(DocError::InvalidFilter(format!(
            "filter nested deeper than {MAX_FILTER_DEPTH}"
        )));
    }
    let Json::Object(map) = filter else {
        return Err(DocError::InvalidFilter("filter must be an object".into()));
    };
    if map.is_empty() {
        return Ok("1=1".to_string());
    }
    let mut clauses = Vec::new();
    for (key, val) in map {
        match key.as_str() {
            "$and" | "$or" => {
                let Json::Array(items) = val else {
                    return Err(DocError::InvalidFilter(format!("{key} expects an array")));
                };
                let joiner = if key == "$and" { " AND " } else { " OR " };
                let parts: Result<Vec<String>> = items
                    .iter()
                    .map(|f| compile_obj(f, params, depth + 1))
                    .collect();
                clauses.push(format!("({})", parts?.join(joiner)));
            }
            "$not" => clauses.push(format!("NOT ({})", compile_obj(val, params, depth + 1)?)),
            k if k.starts_with('$') => {
                return Err(DocError::InvalidFilter(format!("unknown operator {k}")))
            }
            field => clauses.push(compile_field(field, val, params)?),
        }
    }
    Ok(clauses.join(" AND "))
}

fn compile_field(field: &str, val: &Json, params: &mut Vec<Value>) -> Result<String> {
    // Operator object vs direct equality.
    if let Json::Object(ops) = val {
        if ops.keys().any(|k| k.starts_with('$')) {
            let mut parts = Vec::new();
            for (op, v) in ops {
                let expr = field_expr(field)?;
                let clause = match op.as_str() {
                    "$eq" => format!("{expr} = {}", bind(v, params)?),
                    "$ne" => format!("({expr} IS NOT {})", bind(v, params)?),
                    "$gt" => format!("{expr} > {}", bind(v, params)?),
                    "$gte" => format!("{expr} >= {}", bind(v, params)?),
                    "$lt" => format!("{expr} < {}", bind(v, params)?),
                    "$lte" => format!("{expr} <= {}", bind(v, params)?),
                    "$in" | "$nin" => {
                        let Json::Array(items) = v else {
                            return Err(DocError::InvalidFilter(format!("{op} expects an array")));
                        };
                        if items.is_empty() {
                            return Ok(if op == "$in" {
                                "0=1".into()
                            } else {
                                "1=1".into()
                            });
                        }
                        if items.len() > MAX_IN_ITEMS {
                            return Err(DocError::InvalidFilter(format!(
                                "{op} array exceeds {MAX_IN_ITEMS} items"
                            )));
                        }
                        let marks: Result<Vec<String>> =
                            items.iter().map(|i| bind(i, params)).collect();
                        let neg = if op == "$nin" { "NOT " } else { "" };
                        format!("{expr} {neg}IN ({})", marks?.join(", "))
                    }
                    "$exists" => {
                        let jexpr = field_json_expr(field)?;
                        match v.as_bool() {
                            Some(true) => format!("{jexpr} IS NOT NULL"),
                            Some(false) => format!("{jexpr} IS NULL"),
                            None => {
                                return Err(DocError::InvalidFilter(
                                    "$exists expects a boolean".into(),
                                ))
                            }
                        }
                    }
                    other => {
                        return Err(DocError::InvalidFilter(format!("unknown operator {other}")))
                    }
                };
                parts.push(clause);
            }
            return Ok(format!("({})", parts.join(" AND ")));
        }
    }
    Ok(format!("{} = {}", field_expr(field)?, bind(val, params)?))
}

/// `sort: {"field": 1|-1, ...}` → ORDER BY clause.
pub fn compile_sort(sort: &Json) -> Result<String> {
    let Json::Object(map) = sort else {
        return Err(DocError::InvalidFilter("sort must be an object".into()));
    };
    if map.is_empty() {
        return Ok(String::new());
    }
    let mut parts = Vec::new();
    for (field, dir) in map {
        let expr = field_expr(field)?;
        let dir = match dir.as_i64() {
            Some(1) => "ASC",
            Some(-1) => "DESC",
            _ => {
                return Err(DocError::InvalidFilter(
                    "sort direction must be 1 or -1".into(),
                ))
            }
        };
        parts.push(format!("{expr} {dir}"));
    }
    Ok(format!(" ORDER BY {}", parts.join(", ")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn nested(depth: usize) -> Json {
        // {"$not": {"$not": ... {"a": 1}}}
        let mut f = json!({ "a": 1 });
        for _ in 0..depth {
            f = json!({ "$not": f });
        }
        f
    }

    #[test]
    fn accepts_filters_at_the_depth_limit() {
        assert!(compile(&nested(MAX_FILTER_DEPTH - 1)).is_ok());
    }

    #[test]
    fn rejects_overdeep_filters_instead_of_overflowing() {
        let err = compile(&nested(MAX_FILTER_DEPTH + 5));
        assert!(matches!(err, Err(DocError::InvalidFilter(_))));
    }

    #[test]
    fn rejects_oversized_in_arrays() {
        let big: Vec<i64> = (0..(MAX_IN_ITEMS as i64 + 1)).collect();
        let f = json!({ "x": { "$in": big } });
        assert!(matches!(compile(&f), Err(DocError::InvalidFilter(_))));
        // At the cap it still compiles.
        let ok: Vec<i64> = (0..MAX_IN_ITEMS as i64).collect();
        assert!(compile(&json!({ "x": { "$in": ok } })).is_ok());
    }
}
