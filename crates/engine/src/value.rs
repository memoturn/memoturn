use base64::Engine as _;
use serde::{Deserialize, Serialize};

/// Engine-neutral SQL value. JSON mapping: null↔Null, integer↔Integer,
/// float↔Real, string↔Text, bool→Integer, `{"$base64": "..."}`↔Blob.
#[derive(Debug, Clone, PartialEq)]
pub enum Value {
    Null,
    Integer(i64),
    Real(f64),
    Text(String),
    Blob(Vec<u8>),
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct QueryResult {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<serde_json::Value>>,
    pub rows_affected: u64,
}

impl Value {
    pub fn from_json(v: &serde_json::Value) -> Self {
        match v {
            serde_json::Value::Null => Value::Null,
            serde_json::Value::Bool(b) => Value::Integer(*b as i64),
            serde_json::Value::Number(n) => {
                if let Some(i) = n.as_i64() {
                    Value::Integer(i)
                } else {
                    Value::Real(n.as_f64().unwrap_or(f64::NAN))
                }
            }
            serde_json::Value::String(s) => Value::Text(s.clone()),
            serde_json::Value::Object(m) => {
                if let Some(serde_json::Value::String(b64)) = m.get("$base64") {
                    match base64::engine::general_purpose::STANDARD.decode(b64) {
                        Ok(bytes) => Value::Blob(bytes),
                        Err(_) => Value::Null,
                    }
                } else {
                    Value::Text(v.to_string())
                }
            }
            serde_json::Value::Array(_) => Value::Text(v.to_string()),
        }
    }

    pub fn to_json(&self) -> serde_json::Value {
        match self {
            Value::Null => serde_json::Value::Null,
            Value::Integer(i) => serde_json::json!(i),
            Value::Real(f) => serde_json::json!(f),
            Value::Text(s) => serde_json::json!(s),
            Value::Blob(b) => serde_json::json!({
                "$base64": base64::engine::general_purpose::STANDARD.encode(b)
            }),
        }
    }
}
