//! Authentication & authorization (docs/architecture/03).
//!
//! Three credentials:
//! - **Per-database JWT** (Ed25519/EdDSA): claims `{db, scope, exp}` with
//!   `read < write < admin`. The default posture for agents — a token is
//!   locked to one database (all branches). The optional `ns` claim widens a
//!   token to every memory profile under one namespace (`{ns}--*` databases;
//!   docs/architecture/07) — the orchestrator posture.
//! - **Platform key**: control-plane operations (`/v1/databases*`,
//!   `/v1/namespaces*`, including token minting).
//! - **Cluster key**: node-internal hops (`/internal/*`, forwarded writes) —
//!   the original request was already authenticated at the edge.
//!
//! Auth can be disabled for local development; `memoturnd` warns loudly.

use jsonwebtoken::{decode, encode, Algorithm, DecodingKey, EncodingKey, Header, Validation};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

pub const INTERNAL_HEADER: &str = "X-Memoturn-Internal";

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Scope {
    Read,
    Write,
    Admin,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Claims {
    /// Database name the token is locked to (covers all its branches).
    /// Empty for namespace tokens.
    pub db: String,
    /// Namespace the token covers (every `{ns}--*` profile database).
    /// Absent on per-database tokens — old tokens deserialize unchanged.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ns: Option<String>,
    pub scope: Scope,
    pub exp: u64,
    pub iat: u64,
}

/// A namespace or profile part of a `{ns}--{profile}` memory database name:
/// lowercase alphanumeric start, `[a-z0-9_-]` body, no leading/trailing hyphen,
/// and never the reserved `--` delimiter. The single canonical definition of
/// the convention — `create_db` reserves `--`, and `covers_db` validates the
/// profile remainder against it, so a namespace token cannot reach an
/// unrelated database (e.g. `team` must not cover `team---x` or a plain db
/// literally named `acme--prod`).
pub fn part_ok(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 64
        && !s.contains("--")
        && !s.ends_with('-')
        && s.chars()
            .next()
            .is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
        && s.chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '-')
}

impl Claims {
    /// Does this token cover database `db_name`? Either locked to it, or a
    /// namespace token whose namespace owns it as a `{ns}--{profile}` memory
    /// database. The remainder after `{ns}--` must be exactly one valid profile
    /// part — anchoring on the full delimiter and re-validating the profile is
    /// what keeps the prefix match from leaking into sibling namespaces or
    /// hyphen-smuggled names.
    pub fn covers_db(&self, db_name: &str) -> bool {
        if !self.db.is_empty() && self.db == db_name {
            return true;
        }
        match self.ns.as_deref() {
            Some(ns) if part_ok(ns) => db_name
                .strip_prefix(&format!("{ns}--"))
                .is_some_and(part_ok),
            _ => false,
        }
    }
}

#[derive(Clone)]
pub enum Auth {
    Disabled,
    Enabled(Arc<AuthKeys>),
}

pub struct AuthKeys {
    encoding: EncodingKey,
    decoding: DecodingKey,
    pub platform_key: String,
    pub cluster_key: String,
}

fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

impl AuthKeys {
    /// Generate a fresh Ed25519 keypair; returns the keys plus the pkcs8
    /// document to persist (so tokens survive restarts).
    pub fn generate(platform_key: String, cluster_key: String) -> Result<(Self, Vec<u8>), String> {
        let rng = ring::rand::SystemRandom::new();
        let pkcs8 =
            ring::signature::Ed25519KeyPair::generate_pkcs8(&rng).map_err(|e| e.to_string())?;
        let keys = Self::from_pkcs8(pkcs8.as_ref(), platform_key, cluster_key)?;
        Ok((keys, pkcs8.as_ref().to_vec()))
    }

    pub fn from_pkcs8(
        pkcs8: &[u8],
        platform_key: String,
        cluster_key: String,
    ) -> Result<Self, String> {
        let pair = ring::signature::Ed25519KeyPair::from_pkcs8(pkcs8).map_err(|e| e.to_string())?;
        use ring::signature::KeyPair;
        Ok(Self {
            encoding: EncodingKey::from_ed_der(pkcs8),
            decoding: DecodingKey::from_ed_der(pair.public_key().as_ref()),
            platform_key,
            cluster_key,
        })
    }

    /// Mint a per-database token. `ttl_secs` may be negative (tests).
    pub fn mint(&self, db: &str, scope: Scope, ttl_secs: i64) -> Result<String, String> {
        let iat = now();
        let claims = Claims {
            db: db.to_string(),
            ns: None,
            scope,
            exp: (iat as i64 + ttl_secs).max(0) as u64,
            iat,
        };
        encode(&Header::new(Algorithm::EdDSA), &claims, &self.encoding).map_err(|e| e.to_string())
    }

    /// Mint a namespace token: covers every memory profile under `ns`.
    pub fn mint_ns(&self, ns: &str, scope: Scope, ttl_secs: i64) -> Result<String, String> {
        let iat = now();
        let claims = Claims {
            db: String::new(),
            ns: Some(ns.to_string()),
            scope,
            exp: (iat as i64 + ttl_secs).max(0) as u64,
            iat,
        };
        encode(&Header::new(Algorithm::EdDSA), &claims, &self.encoding).map_err(|e| e.to_string())
    }

    pub fn verify(&self, token: &str) -> Result<Claims, String> {
        let mut validation = Validation::new(Algorithm::EdDSA);
        validation.leeway = 5;
        validation.validate_exp = true;
        validation.required_spec_claims.clear();
        decode::<Claims>(token, &self.decoding, &validation)
            .map(|d| d.claims)
            .map_err(|e| e.to_string())
    }
}

/// Scope a data-plane request needs, by method + path under `/v1/db/{db}/`.
/// Deny-by-default: unknown shapes require admin. `/sql` maps to read here;
/// the handler additionally requires write when any statement mutates.
fn required_scope(method: &axum::http::Method, rest: &[&str]) -> Scope {
    use axum::http::Method;
    match rest {
        ["sql"] => Scope::Read,
        ["sync"] => Scope::Write,
        ["branches", ..] => Scope::Admin,
        ["kv", ..] if *method == Method::GET => Scope::Read,
        ["kv", ..] => Scope::Write,
        ["docs", _, "find"] => Scope::Read,
        ["docs", _, _] => Scope::Write,
        ["vectors", _, "search"] => Scope::Read,
        ["vectors", _] => Scope::Write,
        ["memory", _, "turns"] if *method == Method::GET => Scope::Read,
        ["memory", _, "turns"] => Scope::Write,
        ["memory", _, "search"] => Scope::Read,
        _ => Scope::Admin,
    }
}

/// Scope an agent-memory request needs, by method + path segments after
/// `/v1/memory/{ns}/{profile}/`. Deny-by-default like `required_scope`.
fn required_scope_memory(method: &axum::http::Method, rest: &[&str]) -> Scope {
    use axum::http::Method;
    match rest {
        ["recall"] => Scope::Read,
        ["ask"] => Scope::Read,       // recall + LLM synthesis, no writes
        ["extract"] => Scope::Write,  // LLM distill → ingest
        ["memories"] => Scope::Write, // POST ingest
        ["memories", _] if *method == Method::GET => Scope::Read,
        ["memories", _] => Scope::Write, // DELETE forget
        ["sessions"] => Scope::Read,
        ["sessions", _] => Scope::Write, // DELETE end-session
        _ => Scope::Admin,
    }
}

fn bearer(headers: &axum::http::HeaderMap) -> Option<&str> {
    headers
        .get(axum::http::header::AUTHORIZATION)?
        .to_str()
        .ok()?
        .strip_prefix("Bearer ")
}

/// Constant-time string equality for secret comparison. Plain `==` short-circuits
/// on the first differing byte, leaking key bytes through response timing; this
/// does not. (Length still differs in timing, but the keys are fixed-length
/// random tokens, so length is not secret.)
pub fn ct_eq(a: &str, b: &str) -> bool {
    use subtle::ConstantTimeEq;
    let (a, b) = (a.as_bytes(), b.as_bytes());
    // Length is not secret (fixed-length random tokens); guard it before the
    // constant-time byte compare, which requires equal-length slices.
    a.len() == b.len() && a.ct_eq(b).into()
}

/// Derive a stable cluster key from the Ed25519 signing-key DER. The signing key
/// is already shared fleet-wide, so this yields the same cluster key on every
/// node with no extra secret to manage, and it is distinct from any operator
/// platform key. Domain-separated so it can never collide with another use of
/// the signing material.
pub fn derive_cluster_key(signing_der: &[u8]) -> String {
    let mut ctx = ring::digest::Context::new(&ring::digest::SHA256);
    ctx.update(b"memoturn-cluster-key-v1\0");
    ctx.update(signing_der);
    ctx.finish()
        .as_ref()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// Constant-time check of a bearer token against an expected secret. Returns
/// false when the header is absent (without a comparison, which is fine — the
/// absence is not secret).
fn bearer_is(headers: &axum::http::HeaderMap, expected: &str) -> bool {
    bearer(headers).is_some_and(|tok| ct_eq(tok, expected))
}

fn deny(code: axum::http::StatusCode, msg: &str) -> axum::response::Response {
    use axum::response::IntoResponse;
    (code, axum::Json(serde_json::json!({ "error": msg }))).into_response()
}

/// Is this token revoked for `db_name` by a deletion tombstone? A write token
/// minted at or before the database's last deletion must not resurrect or
/// mutate a re-created database of the same name. `iat` is unix-seconds, the
/// tombstone unix-ms. A control-lookup failure falls open (availability over a
/// narrow revocation window — a partitioned control plane already blocks the
/// lease the write needs).
async fn token_revoked(state: &crate::AppState, db_name: &str, iat: u64) -> bool {
    match state.control.deleted_at(db_name).await {
        Ok(Some(deleted_ms)) => (iat as i64).saturating_mul(1000) <= deleted_ms,
        _ => false,
    }
}

/// Router-wide auth middleware. Inserts verified [`Claims`] into request
/// extensions for handlers that need finer checks (e.g. `/sql`).
pub async fn require_auth(
    axum::extract::State(state): axum::extract::State<crate::AppState>,
    mut req: axum::extract::Request,
    next: axum::middleware::Next,
) -> axum::response::Response {
    use axum::http::StatusCode;
    let keys = match &state.auth {
        Auth::Disabled => return next.run(req).await,
        Auth::Enabled(k) => k.clone(),
    };
    let path = req.uri().path().to_string();
    if path == "/health" {
        return next.run(req).await;
    }
    let internal_ok = req
        .headers()
        .get(INTERNAL_HEADER)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| ct_eq(v, &keys.cluster_key));

    if path.starts_with("/internal/") {
        return if internal_ok {
            next.run(req).await
        } else {
            deny(StatusCode::UNAUTHORIZED, "cluster key required")
        };
    }
    if path.starts_with("/v1/databases") || path.starts_with("/v1/namespaces") {
        return if bearer_is(req.headers(), &keys.platform_key) {
            next.run(req).await
        } else {
            deny(StatusCode::UNAUTHORIZED, "platform key required")
        };
    }
    if let Some(rest) = path.strip_prefix("/v1/memory/") {
        // Forwarded hop from a peer node: already authenticated at the edge.
        if internal_ok {
            return next.run(req).await;
        }
        let mut segments = rest.split('/').filter(|s| !s.is_empty());
        let Some(ns) = segments.next() else {
            return deny(StatusCode::NOT_FOUND, "missing namespace");
        };
        let Some(token) = bearer(req.headers()) else {
            return deny(StatusCode::UNAUTHORIZED, "bearer token required");
        };
        let claims = match keys.verify(token) {
            Ok(c) => c,
            Err(e) => return deny(StatusCode::UNAUTHORIZED, &format!("invalid token: {e}")),
        };
        let (authorized, needed, db_name) = match segments.next() {
            // `/v1/memory/{ns}` — profile listing: namespace tokens only.
            None => (claims.ns.as_deref() == Some(ns), Scope::Read, None),
            Some(profile) => {
                let rest: Vec<&str> = segments.collect();
                let db = format!("{ns}--{profile}");
                (
                    claims.covers_db(&db),
                    required_scope_memory(req.method(), &rest),
                    Some(db),
                )
            }
        };
        if !authorized {
            return deny(StatusCode::FORBIDDEN, "token does not cover this profile");
        }
        if claims.scope < needed {
            return deny(
                StatusCode::FORBIDDEN,
                &format!("scope {:?} required", needed),
            );
        }
        if needed >= Scope::Write {
            if let Some(db) = &db_name {
                if token_revoked(&state, db, claims.iat).await {
                    return deny(StatusCode::FORBIDDEN, REVOKED_MSG);
                }
            }
        }
        req.extensions_mut().insert(claims);
        return next.run(req).await;
    }
    if let Some(rest) = path.strip_prefix("/v1/db/") {
        // Forwarded hop from a peer node: already authenticated at the edge.
        if internal_ok {
            return next.run(req).await;
        }
        let mut segments = rest.split('/');
        let Some(db_spec) = segments.next() else {
            return deny(StatusCode::NOT_FOUND, "missing database");
        };
        let db_name = db_spec.split('@').next().unwrap_or(db_spec);
        let Some(token) = bearer(req.headers()) else {
            return deny(StatusCode::UNAUTHORIZED, "bearer token required");
        };
        let claims = match keys.verify(token) {
            Ok(c) => c,
            Err(e) => return deny(StatusCode::UNAUTHORIZED, &format!("invalid token: {e}")),
        };
        // Namespace tokens cover their `{ns}--*` profile databases too (so
        // orchestrators can branch/checkpoint profile memories).
        if !claims.covers_db(db_name) {
            return deny(StatusCode::FORBIDDEN, "token is for a different database");
        }
        let rest: Vec<&str> = segments.collect();
        let needed = required_scope(req.method(), &rest);
        if claims.scope < needed {
            return deny(
                StatusCode::FORBIDDEN,
                &format!("scope {:?} required", needed),
            );
        }
        if needed >= Scope::Write && token_revoked(&state, db_name, claims.iat).await {
            return deny(StatusCode::FORBIDDEN, REVOKED_MSG);
        }
        req.extensions_mut().insert(claims);
        return next.run(req).await;
    }
    next.run(req).await
}

const REVOKED_MSG: &str = "token revoked: it predates this database's deletion; mint a fresh token";

#[cfg(test)]
mod tests {
    use super::*;

    fn ns_token(ns: &str) -> Claims {
        Claims {
            db: String::new(),
            ns: Some(ns.to_string()),
            scope: Scope::Admin,
            exp: 0,
            iat: 0,
        }
    }

    #[test]
    fn covers_db_anchors_on_the_full_delimiter() {
        let t = ns_token("acme");
        // Genuine profiles under the namespace are covered.
        assert!(t.covers_db("acme--alice"));
        assert!(t.covers_db("acme--support_bot"));
        // A plain database literally named with `--` is NOT a profile of `acme`
        // beyond the first part; the remainder must be one valid profile part.
        assert!(!t.covers_db("acme--a--b"));
        // Sibling namespaces and hyphen smuggling do not leak across.
        assert!(!t.covers_db("acme---bob")); // ns `acme-` profile `bob`
        assert!(!t.covers_db("acmex--alice"));
        assert!(!t.covers_db("acme"));
        assert!(!t.covers_db("other--alice"));
        // The trailing-hyphen namespace collision is closed from both sides.
        assert!(!ns_token("team").covers_db("team---x"));
        assert!(!ns_token("team-").covers_db("team---x")); // `team-` itself invalid
    }

    #[test]
    fn covers_db_per_database_token_is_exact() {
        let t = Claims {
            db: "acme--alice".into(),
            ns: None,
            scope: Scope::Write,
            exp: 0,
            iat: 0,
        };
        assert!(t.covers_db("acme--alice"));
        assert!(!t.covers_db("acme--bob"));
        assert!(!t.covers_db("acme--alice--x"));
    }

    #[test]
    fn part_ok_rejects_delimiter_and_edge_hyphens() {
        assert!(part_ok("alice"));
        assert!(part_ok("support-bot"));
        assert!(part_ok("a1_b-2"));
        assert!(!part_ok("")); // empty
        assert!(!part_ok("a--b")); // reserved delimiter
        assert!(!part_ok("team-")); // trailing hyphen
        assert!(!part_ok("-team")); // leading hyphen
        assert!(!part_ok("Team")); // uppercase
        assert!(!part_ok(&"x".repeat(65))); // too long
    }

    #[test]
    fn ct_eq_matches_only_identical_strings() {
        assert!(ct_eq("hunter2", "hunter2"));
        assert!(ct_eq("", ""));
        assert!(!ct_eq("hunter2", "hunter3"));
        assert!(!ct_eq("hunter2", "hunter")); // length differs
        assert!(!ct_eq("hunter", "hunter2"));
    }

    #[test]
    fn derived_cluster_key_is_stable_and_distinct() {
        let (_, der) = AuthKeys::generate(String::new(), String::new()).unwrap();
        let a = derive_cluster_key(&der);
        let b = derive_cluster_key(&der);
        assert_eq!(a, b, "derivation must be deterministic across nodes");
        assert_eq!(a.len(), 64, "sha256 hex");
        // A different signing key derives a different cluster key.
        let (_, der2) = AuthKeys::generate(String::new(), String::new()).unwrap();
        assert_ne!(a, derive_cluster_key(&der2));
    }
}
