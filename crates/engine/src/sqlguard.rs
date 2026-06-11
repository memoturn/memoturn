//! Lexical guard for user-supplied SQL (the `/v1/db/{db}/sql` escape hatch).
//!
//! We tokenize rather than fully parse: SQLite's grammar is larger than any Rust
//! parser models, and a lexer is permissive enough to never reject a legitimate
//! query it merely doesn't understand. The reserved-table check keys off
//! *identifier* tokens, so a reserved name appearing inside a string literal
//! (`'__memoturn_kv'`) or built by concatenation is not a false positive — and a
//! real table reference, however quoted (`"__memoturn_kv"`, `` `__memoturn_kv` ``,
//! `[__memoturn_kv]`), still is.

use crate::{EngineError, Result};
use sqlparser::dialect::SQLiteDialect;
use sqlparser::tokenizer::{Token, Tokenizer};

const RESERVED_PREFIX: &str = "__memoturn_";

/// Statement-leading keywords that mutate, so a read-scoped token must not run
/// them. Presence anywhere (including inside a CTE body) is enough to classify
/// a statement as not-read-only — conservative, never under-restrictive.
const MUTATING: &[&str] = &[
    "insert", "update", "delete", "replace", "create", "drop", "alter", "vacuum", "attach",
    "detach", "reindex", "truncate", "upsert",
];

/// Lowercased identifier/keyword words, with statement boundaries (`;`) marked,
/// so we can reason per-statement. Non-word tokens are irrelevant to the checks.
enum Sig {
    Word(String),
    Semi,
}

fn lex(sql: &str) -> Result<Vec<Sig>> {
    let dialect = SQLiteDialect {};
    let tokens = Tokenizer::new(&dialect, sql)
        .tokenize()
        // Unlexable input cannot name a real table or run a real statement;
        // refuse it rather than guess.
        .map_err(|_| EngineError::Reserved)?;
    Ok(tokens
        .into_iter()
        .filter_map(|t| match t {
            Token::Word(w) => Some(Sig::Word(w.value.to_ascii_lowercase())),
            Token::SemiColon => Some(Sig::Semi),
            _ => None,
        })
        .collect())
}

pub fn guard(sql: &str) -> Result<()> {
    // Fast path: nothing that could touch a reserved table or escape the
    // sandbox. `attach`/`vacuum`/`pragma` are cheap to scan for and rare.
    let lower = sql.to_ascii_lowercase();
    if !lower.contains(RESERVED_PREFIX)
        && !lower.contains("attach")
        && !lower.contains("vacuum")
        && !lower.contains("pragma")
    {
        return Ok(());
    }

    let sig = lex(sql)?;

    // Reserved-table identifiers, anywhere in any statement.
    if sig
        .iter()
        .any(|s| matches!(s, Sig::Word(w) if w.starts_with(RESERVED_PREFIX)))
    {
        return Err(EngineError::Reserved);
    }

    // Per-statement sandbox-escape checks, keyed on the leading keyword.
    for stmt in sig.split(|s| matches!(s, Sig::Semi)) {
        let words: Vec<&str> = stmt
            .iter()
            .filter_map(|s| match s {
                Sig::Word(w) => Some(w.as_str()),
                Sig::Semi => None,
            })
            .collect();
        let Some(&first) = words.first() else {
            continue;
        };
        match first {
            "attach" => return Err(EngineError::Reserved),
            "vacuum" if words.iter().any(|w| *w == "into") => return Err(EngineError::Reserved),
            "pragma" if words.get(1) == Some(&"writable_schema") => {
                return Err(EngineError::Reserved)
            }
            _ => {}
        }
    }
    Ok(())
}

/// Whether a statement only reads. Used to gate mutating SQL behind write scope.
/// Conservative: any mutating keyword anywhere (even inside a `WITH ...` CTE that
/// fronts an `UPDATE`) makes it non-read-only. A non-keyword false match only
/// over-requires scope; it never lets a write through at read scope.
pub fn is_read_only(sql: &str) -> bool {
    match lex(sql) {
        Ok(sig) => !sig.iter().any(|s| match s {
            Sig::Word(w) => MUTATING.contains(&w.as_str()),
            Sig::Semi => false,
        }),
        // Unlexable → treat as not-read-only so it needs write scope.
        Err(_) => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allows_plain_queries_and_reserved_in_literals() {
        assert!(guard("SELECT * FROM users WHERE name = 'alice'").is_ok());
        // Reserved name only inside a string literal — not a table reference.
        assert!(guard("SELECT '__memoturn_kv' AS label").is_ok());
        assert!(guard("INSERT INTO notes(body) VALUES ('see __memoturn_kv')").is_ok());
        // Read-only introspection stays allowed.
        assert!(guard("PRAGMA integrity_check").is_ok());
        assert!(guard("PRAGMA table_info('users')").is_ok());
    }

    #[test]
    fn blocks_reserved_table_references_however_quoted() {
        assert!(guard("SELECT * FROM __memoturn_kv").is_err());
        assert!(guard("SELECT * FROM \"__memoturn_kv\"").is_err());
        assert!(guard("SELECT * FROM `__memoturn_memories`").is_err());
        assert!(guard("SELECT * FROM [__memoturn_docs_x]").is_err());
        assert!(guard("UPDATE __memoturn_memories SET x = 1").is_err());
        // Concatenation cannot smuggle one past us: the identifier is what counts.
        assert!(guard("SELECT * FROM main.__memoturn_kv").is_err());
    }

    #[test]
    fn blocks_sandbox_escapes_but_not_benign_pragmas() {
        assert!(guard("ATTACH DATABASE 'other.db' AS o").is_err());
        assert!(guard("VACUUM INTO 'dump.db'").is_err());
        assert!(guard("PRAGMA writable_schema = ON").is_err());
        // Plain VACUUM (no file target) is harmless and allowed.
        assert!(guard("VACUUM").is_ok());
    }

    #[test]
    fn read_only_classification() {
        assert!(is_read_only("SELECT 1"));
        assert!(is_read_only("WITH t AS (SELECT 1) SELECT * FROM t"));
        assert!(!is_read_only("INSERT INTO t VALUES (1)"));
        assert!(!is_read_only("DELETE FROM t"));
        // CTE fronting a mutation is NOT read-only.
        assert!(!is_read_only("WITH t AS (SELECT 1) UPDATE u SET x = 1"));
        // RETURNING write is caught by the INSERT/UPDATE keyword, not the suffix.
        assert!(!is_read_only("INSERT INTO t VALUES (1) RETURNING id"));
    }
}
