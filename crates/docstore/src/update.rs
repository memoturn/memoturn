//! Mongo-style update operators → a single SQL expression rewriting `doc`.
//! Supported: `$set`, `$unset`, `$inc`, `$push` (ADR-0006).

use crate::filter::compile as compile_filter;
use crate::{DocError, Result};
use memoturn_engine::Value;
use serde_json::Value as Json;

pub struct CompiledUpdate {
    /// Expression producing the new `doc` value.
    pub doc_expr: String,
    pub params: Vec<Value>,
}

fn valid_path(path: &str) -> Result<()> {
    if path.is_empty()
        || path == "_id"
        || !path
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '.' || c == '-')
    {
        return Err(DocError::InvalidUpdate(format!("bad update path: {path}")));
    }
    Ok(())
}

pub fn compile(update: &Json) -> Result<CompiledUpdate> {
    let Json::Object(ops) = update else {
        return Err(DocError::InvalidUpdate("update must be an object".into()));
    };
    if ops.is_empty() || ops.keys().any(|k| !k.starts_with('$')) {
        return Err(DocError::InvalidUpdate(
            "update must use operators ($set/$unset/$inc/$push)".into(),
        ));
    }
    let mut expr = "doc".to_string();
    let mut params = Vec::new();
    for (op, fields) in ops {
        let Json::Object(fields) = fields else {
            return Err(DocError::InvalidUpdate(format!("{op} expects an object")));
        };
        for (path, val) in fields {
            valid_path(path)?;
            match op.as_str() {
                "$set" => {
                    // Bind the value as JSON text so objects/arrays/strings
                    // all set correctly.
                    params.push(Value::Text(val.to_string()));
                    expr = format!("jsonb_set({expr}, '$.{path}', jsonb(?))");
                }
                "$unset" => {
                    expr = format!("jsonb_remove({expr}, '$.{path}')");
                }
                "$inc" => {
                    let by = val.as_f64().ok_or_else(|| {
                        DocError::InvalidUpdate("$inc expects a number".into())
                    })?;
                    params.push(if val.is_i64() {
                        Value::Integer(val.as_i64().unwrap())
                    } else {
                        Value::Real(by)
                    });
                    expr = format!(
                        "jsonb_set({expr}, '$.{path}', coalesce(doc ->> '$.{path}', 0) + ?)"
                    );
                }
                "$push" => {
                    params.push(Value::Text(val.to_string()));
                    expr = format!("jsonb_insert({expr}, '$.{path}[#]', jsonb(?))");
                }
                other => {
                    return Err(DocError::InvalidUpdate(format!("unknown operator {other}")))
                }
            }
        }
    }
    Ok(CompiledUpdate { doc_expr: expr, params })
}

/// Build the full UPDATE statement for a collection table.
pub fn update_stmt(
    table: &str,
    filter: &Json,
    update: &Json,
    multi: bool,
) -> Result<(String, Vec<Value>)> {
    let f = compile_filter(filter)?;
    let u = compile(update)?;
    let limit = if multi { "" } else { " LIMIT 1" };
    let sql = format!(
        "UPDATE \"{table}\" SET doc = {expr}, updated_at = unixepoch('subsec') * 1000
         WHERE id IN (SELECT id FROM \"{table}\" WHERE {where_sql}{limit})",
        expr = u.doc_expr,
        where_sql = f.where_sql,
    );
    let mut params = u.params;
    params.extend(f.params);
    Ok((sql, params))
}
