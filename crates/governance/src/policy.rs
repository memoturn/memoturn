//! Policy document model: one JSON document per namespace holding the
//! namespace policy plus per-profile tighten-only overrides.

use crate::{GovernanceError, Result};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::BTreeMap;

pub const SCHEMA_VERSION: u32 = 1;

/// Policy durations must be at least this long. `0` stays reserved for the
/// node env vars' "pass disabled" meaning and must never enter a policy.
pub const MIN_DURATION_SECS: u64 = 60;

const MAX_PROFILE_OVERRIDES: usize = 1000;

/// The stored document at `{root}/_policy/{ns}.json`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PolicyDoc {
    pub schema_version: u32,
    pub namespace: String,
    /// Monotonic, bumped on every CAS write — lets clients and audit detect change.
    pub revision: u64,
    pub updated_at: i64,
    #[serde(default)]
    pub policy: Policy,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub profiles: BTreeMap<String, Policy>,
    /// Fields written by newer nodes survive an older node's read-modify-write.
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl PolicyDoc {
    pub fn new(namespace: &str) -> Self {
        Self {
            schema_version: SCHEMA_VERSION,
            namespace: namespace.to_string(),
            revision: 0,
            updated_at: 0,
            policy: Policy::default(),
            profiles: BTreeMap::new(),
            extra: Map::new(),
        }
    }

    /// Effective policy for a profile: field-wise strictest of the namespace
    /// policy and the profile override. Node env ceilings are applied by the
    /// caller — they are deployment config, not part of the document.
    pub fn effective(&self, profile: Option<&str>) -> Effective {
        let over = profile.and_then(|p| self.profiles.get(p));
        Effective::resolve(&self.policy, over)
    }
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Policy {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retention: Option<RetentionPolicy>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub memory: Option<MemoryPolicy>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub erasure: Option<ErasurePolicy>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub audit: Option<AuditPolicy>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ai_egress: Option<AiEgressPolicy>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct RetentionPolicy {
    /// Cap on the fine-grained PITR window (restore to any txid).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pitr_secs: Option<u64>,
    /// Cap on the snapshot-grained PITR tier.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pitr_snapshot_secs: Option<u64>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct MemoryPolicy {
    /// Ceiling on task-memory TTL; ingest clamps requested TTLs to this.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub task_ttl_max_secs: Option<u64>,
    /// Events older than this are deleted by the maintenance sweep.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub event_max_age_secs: Option<u64>,
    /// Superseded rows older than this are deleted by the maintenance sweep.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub superseded_max_age_secs: Option<u64>,
    /// Per (type, topic_key), keep at most this many superseded rows.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub superseded_max_count: Option<u64>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct ErasurePolicy {
    /// Upgrade every plain forget into a tracked erasure (phase 3).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub purge_on_forget: Option<bool>,
    /// Undo window before an erasure's history rewrite begins.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub grace_secs: Option<u64>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct AuditPolicy {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    /// Also record recall/get/ask read events (high volume).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub include_reads: Option<bool>,
    /// Retention of the audit stream itself; absent = keep indefinitely.
    /// Namespace-level only — rejected in profile overrides.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retention_secs: Option<u64>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// Ordering is strictness: tighten-only merge takes `max`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EgressRule {
    #[default]
    Allow,
    SelfHostedOnly,
    Deny,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct AiEgressPolicy {
    /// Server-side extraction (sends conversation turns to the extractor model).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub extract: Option<EgressRule>,
    /// Recall answer synthesis (sends recalled memories to the assistant model).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ask: Option<EgressRule>,
    /// Auto-embedding on ingest/recall (sends summaries/queries to the embedder).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub embed: Option<EgressRule>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl Policy {
    /// Structural validation, shared by namespace policies and overrides.
    pub fn validate(&self) -> Result<()> {
        let mut errs = Vec::new();
        let dur = |errs: &mut Vec<String>, field: &str, v: Option<u64>| {
            if let Some(v) = v {
                if v < MIN_DURATION_SECS {
                    errs.push(format!("{field} must be >= {MIN_DURATION_SECS}, got {v}"));
                }
            }
        };
        if let Some(r) = &self.retention {
            dur(&mut errs, "retention.pitr_secs", r.pitr_secs);
            dur(
                &mut errs,
                "retention.pitr_snapshot_secs",
                r.pitr_snapshot_secs,
            );
            if let (Some(fine), Some(snap)) = (r.pitr_secs, r.pitr_snapshot_secs) {
                if snap < fine {
                    errs.push(format!(
                        "retention.pitr_snapshot_secs ({snap}) must be >= retention.pitr_secs ({fine})"
                    ));
                }
            }
        }
        if let Some(m) = &self.memory {
            dur(&mut errs, "memory.task_ttl_max_secs", m.task_ttl_max_secs);
            dur(&mut errs, "memory.event_max_age_secs", m.event_max_age_secs);
            dur(
                &mut errs,
                "memory.superseded_max_age_secs",
                m.superseded_max_age_secs,
            );
            if m.superseded_max_count == Some(0) {
                errs.push("memory.superseded_max_count must be >= 1".into());
            }
        }
        if let Some(e) = &self.erasure {
            dur(&mut errs, "erasure.grace_secs", e.grace_secs);
        }
        if let Some(a) = &self.audit {
            dur(&mut errs, "audit.retention_secs", a.retention_secs);
        }
        if let Some(eg) = &self.ai_egress {
            // No self-hosted extractor/answerer exists; the variant is reserved
            // so allowing it later is not a schema break.
            for (field, rule) in [("extract", eg.extract), ("ask", eg.ask)] {
                if rule == Some(EgressRule::SelfHostedOnly) {
                    errs.push(format!(
                        "ai_egress.{field} supports allow|deny (self_hosted_only is embed-only)"
                    ));
                }
            }
        }
        if errs.is_empty() {
            Ok(())
        } else {
            Err(GovernanceError::Invalid(errs.join("; ")))
        }
    }

    /// Extra rules for profile overrides on top of `validate()`.
    pub fn validate_as_override(&self) -> Result<()> {
        self.validate()?;
        if self
            .audit
            .as_ref()
            .is_some_and(|a| a.retention_secs.is_some())
        {
            return Err(GovernanceError::Invalid(
                "audit.retention_secs is namespace-level only (the audit stream is per-namespace)"
                    .into(),
            ));
        }
        Ok(())
    }

    /// Tighten-only check: every field this override sets must be at least as
    /// strict as the namespace value. Returns per-field violations.
    pub fn tightens(&self, base: &Policy) -> std::result::Result<(), Vec<String>> {
        let mut viol = Vec::new();

        // A cap tightens iff the base is uncapped or the override is <= base.
        fn cap(viol: &mut Vec<String>, field: &str, over: Option<u64>, base: Option<u64>) {
            if let (Some(o), Some(b)) = (over, base) {
                if o > b {
                    viol.push(format!("{field} {o} > {b}"));
                }
            }
        }
        // A bool tightens iff it never turns the base's `true` off.
        fn flag(viol: &mut Vec<String>, field: &str, over: Option<bool>, base: Option<bool>) {
            if over == Some(false) && base == Some(true) {
                viol.push(format!("{field} false < true"));
            }
        }

        let (or, br) = (self.retention.as_ref(), base.retention.as_ref());
        cap(
            &mut viol,
            "retention.pitr_secs",
            or.and_then(|r| r.pitr_secs),
            br.and_then(|r| r.pitr_secs),
        );
        cap(
            &mut viol,
            "retention.pitr_snapshot_secs",
            or.and_then(|r| r.pitr_snapshot_secs),
            br.and_then(|r| r.pitr_snapshot_secs),
        );

        let (om, bm) = (self.memory.as_ref(), base.memory.as_ref());
        cap(
            &mut viol,
            "memory.task_ttl_max_secs",
            om.and_then(|m| m.task_ttl_max_secs),
            bm.and_then(|m| m.task_ttl_max_secs),
        );
        cap(
            &mut viol,
            "memory.event_max_age_secs",
            om.and_then(|m| m.event_max_age_secs),
            bm.and_then(|m| m.event_max_age_secs),
        );
        cap(
            &mut viol,
            "memory.superseded_max_age_secs",
            om.and_then(|m| m.superseded_max_age_secs),
            bm.and_then(|m| m.superseded_max_age_secs),
        );
        cap(
            &mut viol,
            "memory.superseded_max_count",
            om.and_then(|m| m.superseded_max_count),
            bm.and_then(|m| m.superseded_max_count),
        );

        let (oe, be) = (self.erasure.as_ref(), base.erasure.as_ref());
        flag(
            &mut viol,
            "erasure.purge_on_forget",
            oe.and_then(|e| e.purge_on_forget),
            be.and_then(|e| e.purge_on_forget),
        );
        cap(
            &mut viol,
            "erasure.grace_secs",
            oe.and_then(|e| e.grace_secs),
            be.and_then(|e| e.grace_secs),
        );

        let (oa, ba) = (self.audit.as_ref(), base.audit.as_ref());
        flag(
            &mut viol,
            "audit.enabled",
            oa.and_then(|a| a.enabled),
            ba.and_then(|a| a.enabled),
        );
        flag(
            &mut viol,
            "audit.include_reads",
            oa.and_then(|a| a.include_reads),
            ba.and_then(|a| a.include_reads),
        );

        let (og, bg) = (self.ai_egress.as_ref(), base.ai_egress.as_ref());
        for (field, o, b) in [
            (
                "ai_egress.extract",
                og.and_then(|g| g.extract),
                bg.and_then(|g| g.extract),
            ),
            (
                "ai_egress.ask",
                og.and_then(|g| g.ask),
                bg.and_then(|g| g.ask),
            ),
            (
                "ai_egress.embed",
                og.and_then(|g| g.embed),
                bg.and_then(|g| g.embed),
            ),
        ] {
            if let (Some(o), Some(b)) = (o, b) {
                if o < b {
                    viol.push(format!("{field} {o:?} looser than {b:?}"));
                }
            }
        }

        if viol.is_empty() {
            Ok(())
        } else {
            Err(viol)
        }
    }
}

pub(crate) fn validate_doc(doc: &PolicyDoc) -> Result<()> {
    doc.policy.validate()?;
    if doc.profiles.len() > MAX_PROFILE_OVERRIDES {
        return Err(GovernanceError::Invalid(format!(
            "at most {MAX_PROFILE_OVERRIDES} profile overrides per namespace"
        )));
    }
    for (profile, p) in &doc.profiles {
        p.validate_as_override()
            .map_err(|e| GovernanceError::Invalid(format!("profiles.{profile}: {e}")))?;
    }
    Ok(())
}

/// Fully resolved caps for one profile — the only type enforcement code sees.
/// `None` = uncapped. Strictest-wins is recomputed here regardless of what
/// PUT-time validation allowed, so the invariant survives racing updates.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Effective {
    pub pitr_secs: Option<u64>,
    pub pitr_snapshot_secs: Option<u64>,
    pub task_ttl_max_secs: Option<u64>,
    pub event_max_age_secs: Option<u64>,
    pub superseded_max_age_secs: Option<u64>,
    pub superseded_max_count: Option<u64>,
    pub purge_on_forget: bool,
    pub erasure_grace_secs: u64,
    pub audit_enabled: bool,
    pub audit_include_reads: bool,
    pub audit_retention_secs: Option<u64>,
    pub extract: EgressRule,
    pub ask: EgressRule,
    pub embed: EgressRule,
}

pub const DEFAULT_ERASURE_GRACE_SECS: u64 = 86_400;

impl Default for Effective {
    fn default() -> Self {
        Self {
            pitr_secs: None,
            pitr_snapshot_secs: None,
            task_ttl_max_secs: None,
            event_max_age_secs: None,
            superseded_max_age_secs: None,
            superseded_max_count: None,
            purge_on_forget: false,
            erasure_grace_secs: DEFAULT_ERASURE_GRACE_SECS,
            audit_enabled: false,
            audit_include_reads: false,
            audit_retention_secs: None,
            extract: EgressRule::Allow,
            ask: EgressRule::Allow,
            embed: EgressRule::Allow,
        }
    }
}

impl Effective {
    pub fn resolve(ns: &Policy, profile: Option<&Policy>) -> Self {
        fn min_cap<T: Ord + Copy>(a: Option<T>, b: Option<T>) -> Option<T> {
            match (a, b) {
                (Some(a), Some(b)) => Some(a.min(b)),
                (a, b) => a.or(b),
            }
        }
        let p = profile;
        let ret = |f: fn(&RetentionPolicy) -> Option<u64>| {
            min_cap(
                ns.retention.as_ref().and_then(f),
                p.and_then(|p| p.retention.as_ref()).and_then(f),
            )
        };
        let mem = |f: fn(&MemoryPolicy) -> Option<u64>| {
            min_cap(
                ns.memory.as_ref().and_then(f),
                p.and_then(|p| p.memory.as_ref()).and_then(f),
            )
        };
        let egress = |f: fn(&AiEgressPolicy) -> Option<EgressRule>| {
            ns.ai_egress.as_ref().and_then(f).unwrap_or_default().max(
                p.and_then(|p| p.ai_egress.as_ref())
                    .and_then(f)
                    .unwrap_or_default(),
            )
        };
        let era = |f: fn(&ErasurePolicy) -> Option<u64>| {
            min_cap(
                ns.erasure.as_ref().and_then(f),
                p.and_then(|p| p.erasure.as_ref()).and_then(f),
            )
        };
        let audit_flag = |f: fn(&AuditPolicy) -> Option<bool>| {
            ns.audit.as_ref().and_then(f).unwrap_or(false)
                || p.and_then(|p| p.audit.as_ref())
                    .and_then(f)
                    .unwrap_or(false)
        };

        Self {
            pitr_secs: ret(|r| r.pitr_secs),
            pitr_snapshot_secs: ret(|r| r.pitr_snapshot_secs),
            task_ttl_max_secs: mem(|m| m.task_ttl_max_secs),
            event_max_age_secs: mem(|m| m.event_max_age_secs),
            superseded_max_age_secs: mem(|m| m.superseded_max_age_secs),
            superseded_max_count: mem(|m| m.superseded_max_count),
            purge_on_forget: ns
                .erasure
                .as_ref()
                .and_then(|e| e.purge_on_forget)
                .unwrap_or(false)
                || p.and_then(|p| p.erasure.as_ref())
                    .and_then(|e| e.purge_on_forget)
                    .unwrap_or(false),
            erasure_grace_secs: era(|e| e.grace_secs).unwrap_or(DEFAULT_ERASURE_GRACE_SECS),
            audit_enabled: audit_flag(|a| a.enabled),
            audit_include_reads: audit_flag(|a| a.include_reads),
            // Namespace-level only; overrides are rejected at validation.
            audit_retention_secs: ns.audit.as_ref().and_then(|a| a.retention_secs),
            extract: egress(|g| g.extract),
            ask: egress(|g| g.ask),
            embed: egress(|g| g.embed),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn policy(v: Value) -> Policy {
        serde_json::from_value(v).unwrap()
    }

    #[test]
    fn effective_is_field_wise_strictest() {
        let ns = policy(json!({
            "retention": { "pitr_secs": 3600 },
            "memory": { "task_ttl_max_secs": 600 },
            "ai_egress": { "extract": "deny", "embed": "self_hosted_only" },
            "audit": { "enabled": true, "retention_secs": 86400 },
        }));
        let over = policy(json!({
            "retention": { "pitr_secs": 7200, "pitr_snapshot_secs": 86400 },
            "memory": { "event_max_age_secs": 1000 },
            "ai_egress": { "embed": "deny", "ask": "deny" },
        }));
        let eff = Effective::resolve(&ns, Some(&over));
        // min wins even when the override is looser (defense in depth).
        assert_eq!(eff.pitr_secs, Some(3600));
        // override adds caps the namespace didn't have
        assert_eq!(eff.pitr_snapshot_secs, Some(86400));
        assert_eq!(eff.task_ttl_max_secs, Some(600));
        assert_eq!(eff.event_max_age_secs, Some(1000));
        // egress takes max strictness from either side
        assert_eq!(eff.extract, EgressRule::Deny);
        assert_eq!(eff.ask, EgressRule::Deny);
        assert_eq!(eff.embed, EgressRule::Deny);
        assert!(eff.audit_enabled);
        assert_eq!(eff.audit_retention_secs, Some(86400));
    }

    #[test]
    fn effective_defaults_when_unset() {
        let eff = Effective::resolve(&Policy::default(), None);
        assert_eq!(eff, Effective::default());
        assert_eq!(eff.extract, EgressRule::Allow);
        assert_eq!(eff.erasure_grace_secs, DEFAULT_ERASURE_GRACE_SECS);
    }

    #[test]
    fn tightens_rejects_looser_fields() {
        let ns = policy(json!({
            "retention": { "pitr_secs": 3600 },
            "ai_egress": { "embed": "self_hosted_only" },
            "audit": { "enabled": true },
            "erasure": { "purge_on_forget": true },
        }));
        let over = policy(json!({
            "retention": { "pitr_secs": 7200 },
            "ai_egress": { "embed": "allow" },
            "audit": { "enabled": false },
            "erasure": { "purge_on_forget": false },
        }));
        let viol = over.tightens(&ns).unwrap_err();
        assert_eq!(viol.len(), 4, "{viol:?}");
        assert!(viol[0].contains("retention.pitr_secs 7200 > 3600"));
    }

    #[test]
    fn tightens_accepts_stricter_or_new_caps() {
        let ns = policy(json!({ "retention": { "pitr_secs": 3600 } }));
        let over = policy(json!({
            "retention": { "pitr_secs": 600 },
            "memory": { "task_ttl_max_secs": 300 },
            "ai_egress": { "extract": "deny" },
            "audit": { "enabled": true },
        }));
        assert!(over.tightens(&ns).is_ok());
        // Setting a cap where the namespace has none is always a tighten.
        assert!(policy(json!({ "retention": { "pitr_secs": 99999 } }))
            .tightens(&Policy::default())
            .is_ok());
    }

    #[test]
    fn validate_rejects_bad_values() {
        assert!(policy(json!({ "retention": { "pitr_secs": 0 } }))
            .validate()
            .is_err());
        assert!(policy(json!({ "retention": { "pitr_secs": 59 } }))
            .validate()
            .is_err());
        assert!(
            policy(json!({ "retention": { "pitr_secs": 7200, "pitr_snapshot_secs": 3600 } }))
                .validate()
                .is_err()
        );
        assert!(policy(json!({ "memory": { "superseded_max_count": 0 } }))
            .validate()
            .is_err());
        assert!(
            policy(json!({ "ai_egress": { "extract": "self_hosted_only" } }))
                .validate()
                .is_err()
        );
        assert!(
            policy(json!({ "ai_egress": { "embed": "self_hosted_only" } }))
                .validate()
                .is_ok()
        );
    }

    #[test]
    fn override_rejects_namespace_only_fields() {
        let p = policy(json!({ "audit": { "retention_secs": 86400 } }));
        assert!(p.validate().is_ok());
        assert!(p.validate_as_override().is_err());
    }

    #[test]
    fn unknown_fields_round_trip() {
        let raw = json!({
            "schema_version": 1, "namespace": "acme", "revision": 3, "updated_at": 5,
            "policy": {
                "retention": { "pitr_secs": 3600, "future_knob": true },
                "quotas": { "max_bytes": 1 }
            },
            "future_top_level": "kept"
        });
        let doc: PolicyDoc = serde_json::from_value(raw.clone()).unwrap();
        assert_eq!(doc.policy.retention.as_ref().unwrap().pitr_secs, Some(3600));
        let back = serde_json::to_value(&doc).unwrap();
        assert_eq!(back["future_top_level"], "kept");
        assert_eq!(back["policy"]["quotas"]["max_bytes"], 1);
        assert_eq!(back["policy"]["retention"]["future_knob"], true);
    }

    #[test]
    fn egress_rule_ordering_is_strictness() {
        assert!(EgressRule::Allow < EgressRule::SelfHostedOnly);
        assert!(EgressRule::SelfHostedOnly < EgressRule::Deny);
    }
}
