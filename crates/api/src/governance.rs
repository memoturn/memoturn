//! Data-governance enforcement (ADR-0010, docs/architecture/08): the AI
//! egress gate and the env-ceiling fold for effective-policy responses.
//! Policy storage and the document model live in `memoturn-governance`.

use crate::{ApiError, AppState};
use axum::http::StatusCode;

pub use memoturn_governance::{Effective, EgressRule, Policy, PolicyDoc, PolicyStore};

/// AI egress operations whose endpoints exist to call the model — a policy
/// denial is a deterministic 403, not a degrade. Embedding is implicit
/// (ingest/recall side-effect) and gated by [`embed_rule_allows`] instead.
#[derive(Debug, Clone, Copy)]
pub enum EgressOp {
    Extract,
    Ask,
}

/// Gate an explicit AI egress endpoint. Fail-closed: when no policy has ever
/// been loadable (cold cache + unreachable store) the request is refused —
/// the right posture for a compliance control, and with a warm cache the
/// window is cold-boot-only.
pub(crate) async fn check_egress(
    state: &AppState,
    ns: &str,
    profile: &str,
    op: EgressOp,
) -> Result<(), ApiError> {
    let eff = state
        .governance
        .effective(ns, Some(profile))
        .await
        .map_err(|e| {
            tracing::warn!(ns, error = %e, "policy unavailable; refusing AI egress (fail closed)");
            ApiError::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "governance policy unavailable; refusing AI egress",
            )
        })?;
    let (rule, field) = match op {
        EgressOp::Extract => (eff.extract, "extract"),
        EgressOp::Ask => (eff.ask, "ask"),
    };
    match rule {
        EgressRule::Allow => Ok(()),
        // self_hosted_only is rejected for extract/ask at validation; treat a
        // racing/legacy value as deny.
        _ => Err(ApiError::new(
            StatusCode::FORBIDDEN,
            format!("ai egress denied by policy (ai_egress.{field} = deny for namespace '{ns}')"),
        )),
    }
}

/// Gate the implicit auto-embed side channel against an already-resolved
/// policy. A denied embed behaves exactly like an unconfigured embedder:
/// skip silently, never fail the write/read — keyword and topic recall still
/// work, and the caller never asked for egress so there is nothing to 403.
pub fn embed_rule_allows(
    eff: &Effective,
    provenance: Option<&crate::embed::EmbedProvenance>,
) -> bool {
    match eff.embed {
        EgressRule::Allow => true,
        EgressRule::SelfHostedOnly => provenance.is_some_and(|p| p.self_hosted),
        EgressRule::Deny => false,
    }
}

/// Audit metadata for the extractor/answerer egress events: provider, model,
/// endpoint host. Both speak to the Claude API; the model comes from env the
/// same way the clients configure themselves.
pub(crate) fn llm_egress_meta(
    op: EgressOp,
    input_items: usize,
    input_bytes: usize,
) -> crate::audit::EgressMeta {
    let model_var = match op {
        EgressOp::Extract => "MEMOTURN_EXTRACT_MODEL",
        EgressOp::Ask => "MEMOTURN_ASSISTANT_MODEL",
    };
    crate::audit::EgressMeta {
        provider: "anthropic".into(),
        model: std::env::var(model_var).unwrap_or_else(|_| "claude-opus-4-8".into()),
        endpoint_host: Some("api.anthropic.com".into()),
        self_hosted: false,
        input_items,
        input_bytes,
        output_items: None,
        duration_ms: 0,
    }
}

pub(crate) fn env_u64(name: &str, default: u64) -> u64 {
    std::env::var(name)
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(default)
}

/// Fold the node's PITR env ceilings into a resolved policy so the reported
/// `effective` values are exactly what enforcement will do: `min(env, policy)`
/// when the retention pass is on; nothing pruned at all when the operator
/// disabled it (`MEMOTURN_PITR_RETENTION_SECS=0` — env `0` means "pass off",
/// which is why policies reserve it).
pub fn fold_env_ceilings(eff: &mut Effective) {
    let fine = env_u64("MEMOTURN_PITR_RETENTION_SECS", 86_400);
    if fine == 0 {
        eff.pitr_secs = None;
        eff.pitr_snapshot_secs = None;
    } else {
        let snap = env_u64("MEMOTURN_PITR_SNAPSHOT_RETENTION_SECS", 2_592_000);
        eff.pitr_secs = Some(eff.pitr_secs.map_or(fine, |p| p.min(fine)));
        eff.pitr_snapshot_secs = Some(eff.pitr_snapshot_secs.map_or(snap, |p| p.min(snap)));
    }
}
