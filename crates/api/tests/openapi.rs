//! The OpenAPI spec (docs/api/openapi.yaml) is hand-maintained; this test
//! keeps it honest by extracting the router's path+method set straight from
//! the source and diffing it against the spec. Adding, removing, or
//! re-verbing a public route without updating the spec fails here.

use std::collections::BTreeSet;

const EXCLUDED_PREFIXES: &[&str] = &["/internal/"];
const EXCLUDED_PATHS: &[&str] = &["/health"];

/// (path, METHOD) pairs from every `.route("…", …)` call in lib.rs.
fn routes_from_source() -> BTreeSet<(String, String)> {
    let src = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/lib.rs")).unwrap();
    let mut out = BTreeSet::new();
    let mut rest = src.as_str();
    while let Some(i) = rest.find(".route(") {
        rest = &rest[i + ".route(".len()..];
        // Balanced-paren scan over the call's arguments.
        let mut depth = 1usize;
        let mut end = 0usize;
        for (j, c) in rest.char_indices() {
            match c {
                '(' => depth += 1,
                ')' => {
                    depth -= 1;
                    if depth == 0 {
                        end = j;
                        break;
                    }
                }
                _ => {}
            }
        }
        let call = &rest[..end];
        let Some(path) = call.split('"').nth(1) else {
            continue;
        };
        if EXCLUDED_PATHS.contains(&path) || EXCLUDED_PREFIXES.iter().any(|p| path.starts_with(p)) {
            continue;
        }
        let after_path = &call[call.find('"').unwrap()..];
        for (token, method) in [
            ("get(", "GET"),
            ("post(", "POST"),
            ("put(", "PUT"),
            ("delete(", "DELETE"),
        ] {
            // Match `get(handler)` / `.put(handler)` / `routing::delete(...)`
            // but not identifiers merely containing the token.
            let mut found = false;
            let mut hay = after_path;
            while let Some(k) = hay.find(token) {
                let prev = after_path.len() - hay.len() + k;
                let prev_char = after_path[..prev].chars().next_back();
                if !matches!(prev_char, Some(c) if c.is_alphanumeric() || c == '_') {
                    found = true;
                    break;
                }
                hay = &hay[k + token.len()..];
            }
            if found {
                out.insert((path.to_string(), method.to_string()));
            }
        }
    }
    out
}

/// (path, METHOD) pairs from the spec.
fn routes_from_spec() -> BTreeSet<(String, String)> {
    let spec = std::fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../docs/api/openapi.yaml"
    ))
    .expect("docs/api/openapi.yaml must exist");
    let doc: serde_yaml::Value = serde_yaml::from_str(&spec).expect("spec must be valid YAML");
    let mut out = BTreeSet::new();
    let paths = doc["paths"].as_mapping().expect("spec has paths");
    for (path, item) in paths {
        let path = path.as_str().unwrap();
        if EXCLUDED_PATHS.contains(&path) {
            continue;
        }
        for method in ["get", "post", "put", "delete"] {
            if item.get(method).is_some() {
                out.insert((path.to_string(), method.to_uppercase()));
            }
        }
    }
    out
}

#[test]
fn spec_matches_router() {
    let in_code = routes_from_source();
    let in_spec = routes_from_spec();

    let missing_from_spec: Vec<_> = in_code.difference(&in_spec).collect();
    let stale_in_spec: Vec<_> = in_spec.difference(&in_code).collect();

    assert!(
        missing_from_spec.is_empty() && stale_in_spec.is_empty(),
        "openapi.yaml is out of sync with the router.\n\
         routes missing from the spec: {missing_from_spec:#?}\n\
         spec entries with no route: {stale_in_spec:#?}\n\
         Update docs/api/openapi.yaml (and run /sync-docs)."
    );

    // Sanity floor so a parser regression can't silently pass on empty sets.
    assert!(
        in_code.len() > 30,
        "route extraction looks broken: {in_code:#?}"
    );
}

#[test]
fn spec_documents_the_error_envelope() {
    let spec = std::fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../docs/api/openapi.yaml"
    ))
    .unwrap();
    let doc: serde_yaml::Value = serde_yaml::from_str(&spec).unwrap();
    let envelope = &doc["components"]["schemas"]["ErrorEnvelope"];
    let codes: Vec<&str> = envelope["properties"]["code"]["enum"]
        .as_sequence()
        .expect("ErrorEnvelope.code must enumerate the stable codes")
        .iter()
        .filter_map(|v| v.as_str())
        .collect();
    for required in [
        "unauthorized",
        "forbidden",
        "not_found",
        "database_not_found",
        "branch_not_found",
        "already_exists",
        "conflict",
        "invalid_request",
        "payload_too_large",
        "request_timeout",
        "overloaded",
        "unconfigured",
        "unavailable",
        "internal",
    ] {
        assert!(
            codes.contains(&required),
            "spec is missing error code {required}"
        );
    }
}
