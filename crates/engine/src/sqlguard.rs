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

/// Statement-leading keywords that drive SQLite transaction control. The
/// engine owns transactions — and group-commits concurrent requests into one
/// transaction with per-request savepoints (`DbHandle`), so a user-issued
/// `COMMIT`/`ROLLBACK`/`SAVEPOINT` could break other requests' atomicity, not
/// just its own. (`end` is COMMIT's alias; trigger bodies are handled below.)
const TXN_CONTROL: &[&str] = &["begin", "commit", "end", "rollback", "savepoint", "release"];

pub fn guard(sql: &str) -> Result<()> {
    // Fast path: nothing that could touch a reserved table, escape the
    // sandbox, or control transactions. The txn-control words make this scan
    // hit more often (`end` matches every CASE expression), but a false hit
    // only costs the lexer pass below.
    let lower = sql.to_ascii_lowercase();
    if !lower.contains(RESERVED_PREFIX)
        && !lower.contains("attach")
        && !lower.contains("vacuum")
        && !lower.contains("pragma")
        && !TXN_CONTROL.iter().any(|w| lower.contains(w))
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

    // Per-statement checks, keyed on the leading keyword. `CREATE TRIGGER …
    // BEGIN body; END` carries semicolons inside the body, so its segments
    // would otherwise look statement-leading; while inside a trigger body
    // only the closing `END` is treated specially.
    let mut in_trigger = false;
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
        if in_trigger {
            if first == "end" {
                in_trigger = false;
            }
            continue;
        }
        match first {
            "attach" => return Err(EngineError::Reserved),
            "vacuum" if words.iter().any(|w| *w == "into") => return Err(EngineError::Reserved),
            "pragma" if words.get(1) == Some(&"writable_schema") => {
                return Err(EngineError::Reserved)
            }
            w if TXN_CONTROL.contains(&w) => {
                return Err(EngineError::Sql(
                    "transaction control is managed by the engine".into(),
                ))
            }
            "create" if words.contains(&"trigger") && words.contains(&"begin") => {
                in_trigger = true;
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
    fn blocks_transaction_control_but_not_lookalikes() {
        // The engine group-commits concurrent requests into one transaction;
        // user transaction control would break round atomicity.
        assert!(guard("COMMIT").is_err());
        assert!(guard("END").is_err());
        assert!(guard("BEGIN").is_err());
        assert!(guard("BEGIN IMMEDIATE").is_err());
        assert!(guard("ROLLBACK").is_err());
        assert!(guard("SAVEPOINT sp1").is_err());
        assert!(guard("RELEASE sp1").is_err());
        assert!(guard("SELECT 1; COMMIT").is_err());
        assert!(guard("INSERT INTO t VALUES (1); ROLLBACK TO sp1").is_err());
        // Lookalikes inside expressions and identifiers stay allowed.
        assert!(guard("SELECT CASE WHEN x > 1 THEN 'a' ELSE 'b' END FROM t").is_ok());
        assert!(guard("SELECT * FROM commits WHERE released = 1").is_ok());
        assert!(guard("SELECT * FROM t WHERE name = 'Wendy'").is_ok());
        // Trigger bodies legitimately contain BEGIN … stmt; … END.
        assert!(guard(
            "CREATE TRIGGER trg AFTER INSERT ON t BEGIN \
             UPDATE t2 SET n = n + 1; INSERT INTO log VALUES (new.id); END;"
        )
        .is_ok());
        // …but a trigger cannot smuggle a reserved table.
        assert!(guard(
            "CREATE TRIGGER trg AFTER INSERT ON t BEGIN \
             DELETE FROM __memoturn_kv; END;"
        )
        .is_err());
        // Statements after a closed trigger body are checked again.
        assert!(guard(
            "CREATE TRIGGER trg AFTER INSERT ON t BEGIN \
             UPDATE t2 SET n = 1; END; COMMIT"
        )
        .is_err());
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
