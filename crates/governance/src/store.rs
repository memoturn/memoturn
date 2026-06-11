//! Policy storage: authoritative documents in object storage at
//! `{root}/_policy/{ns}.json`, CAS-written, read through a per-node cache.
//!
//! Object storage (not the control plane) holds policies for the same reason
//! deletion tombstones ended up there: the in-process control plane forgets on
//! restart, and nodes must stay disposable. Every node — single- or
//! multi-node — converges on a policy change within the cache TTL without a
//! restart; the writer sees its own change immediately.

use crate::policy::{validate_doc, Effective, Policy, PolicyDoc};
use crate::{GovernanceError, Result};
use bytes::Bytes;
use futures::TryStreamExt;
use object_store::path::Path as ObjPath;
use object_store::{ObjectStore, PutPayload};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::sync::RwLock;

const PUT_RETRIES: usize = 3;

struct CacheEntry {
    fetched: Instant,
    doc: Option<Arc<PolicyDoc>>,
}

pub struct PolicyStore {
    store: Arc<dyn ObjectStore>,
    root: String,
    cache: RwLock<HashMap<String, CacheEntry>>,
    ttl: Duration,
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

impl PolicyStore {
    /// Standalone store over a private in-memory backend with no read cache —
    /// for tests and tools that need policy plumbing without a node's store.
    pub fn in_memory() -> Self {
        Self::new(
            Arc::new(object_store::memory::InMemory::new()),
            "v1",
            Duration::ZERO,
        )
    }

    pub fn new(store: Arc<dyn ObjectStore>, root: &str, cache_ttl: Duration) -> Self {
        Self {
            store,
            root: root.trim_matches('/').to_string(),
            cache: RwLock::new(HashMap::new()),
            ttl: cache_ttl,
        }
    }

    fn key(&self, ns: &str) -> ObjPath {
        ObjPath::from(format!("{}/_policy/{ns}.json", self.root))
    }

    /// Cached namespace document; `None` = no policy set (also cached).
    /// On a fetch error a stale cached entry is served rather than failing —
    /// a policy constrains, so stale-but-recent beats unavailable. Only a
    /// cold miss with the store unreachable errors; callers choose their
    /// posture (egress checks fail closed, TTL clamps fail open).
    pub async fn get(&self, ns: &str) -> Result<Option<Arc<PolicyDoc>>> {
        {
            let cache = self.cache.read().await;
            if let Some(e) = cache.get(ns) {
                if e.fetched.elapsed() < self.ttl {
                    return Ok(e.doc.clone());
                }
            }
        }
        match self.fetch(ns).await {
            Ok(doc) => {
                let doc = doc.map(Arc::new);
                self.cache.write().await.insert(
                    ns.to_string(),
                    CacheEntry {
                        fetched: Instant::now(),
                        doc: doc.clone(),
                    },
                );
                Ok(doc)
            }
            Err(e) => {
                let cache = self.cache.read().await;
                if let Some(stale) = cache.get(ns) {
                    tracing::warn!(ns, error = %e, "policy fetch failed; serving stale cache");
                    return Ok(stale.doc.clone());
                }
                Err(e)
            }
        }
    }

    /// Effective policy for `(ns, profile)` — env ceilings are the caller's.
    pub async fn effective(&self, ns: &str, profile: Option<&str>) -> Result<Effective> {
        Ok(self
            .get(ns)
            .await?
            .map(|doc| doc.effective(profile))
            .unwrap_or_default())
    }

    /// Effective policy for a database name. Memory databases are named
    /// `{ns}--{profile}`; anything else has no namespace and gets no caps.
    pub async fn effective_for_db(&self, db_name: &str) -> Result<Effective> {
        match db_name.split_once("--") {
            Some((ns, profile)) => self.effective(ns, Some(profile)).await,
            None => Ok(Effective::default()),
        }
    }

    /// Replace the namespace-level policy (CAS read-modify-write).
    pub async fn put_namespace(&self, ns: &str, policy: Policy) -> Result<PolicyDoc> {
        policy.validate()?;
        self.update(ns, |doc| {
            doc.policy = policy.clone();
            Ok(())
        })
        .await
    }

    /// Set or clear (`None`) a profile override. The override must tighten
    /// the current namespace policy.
    pub async fn put_profile(
        &self,
        ns: &str,
        profile: &str,
        over: Option<Policy>,
    ) -> Result<PolicyDoc> {
        if let Some(p) = &over {
            p.validate_as_override()?;
        }
        self.update(ns, |doc| {
            match &over {
                Some(p) => {
                    p.tightens(&doc.policy)
                        .map_err(|viol| GovernanceError::Loosens(viol.join("; ")))?;
                    doc.profiles.insert(profile.to_string(), p.clone());
                }
                None => {
                    doc.profiles.remove(profile);
                }
            }
            Ok(())
        })
        .await
    }

    /// All policy documents — one LIST + N GETs, used by maintenance passes
    /// (always fresh; the sweep cadence already bounds staleness).
    pub async fn list(&self) -> Result<Vec<PolicyDoc>> {
        let prefix = ObjPath::from(format!("{}/_policy", self.root));
        let metas: Vec<_> = self
            .store
            .list(Some(&prefix))
            .try_collect()
            .await
            .map_err(GovernanceError::from)?;
        let mut docs = Vec::with_capacity(metas.len());
        for meta in metas {
            match self.store.get(&meta.location).await {
                Ok(r) => {
                    let bytes = r.bytes().await?;
                    match serde_json::from_slice::<PolicyDoc>(&bytes) {
                        Ok(doc) => docs.push(doc),
                        Err(e) => {
                            tracing::warn!(key = %meta.location, error = %e, "skipping corrupt policy doc")
                        }
                    }
                }
                Err(object_store::Error::NotFound { .. }) => {}
                Err(e) => return Err(e.into()),
            }
        }
        Ok(docs)
    }

    async fn fetch(&self, ns: &str) -> Result<Option<PolicyDoc>> {
        match self.store.get(&self.key(ns)).await {
            Ok(r) => {
                let bytes = r.bytes().await?;
                let doc = serde_json::from_slice(&bytes)
                    .map_err(|e| GovernanceError::Corrupt(e.to_string()))?;
                Ok(Some(doc))
            }
            Err(object_store::Error::NotFound { .. }) => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    async fn fetch_versioned(
        &self,
        ns: &str,
    ) -> Result<Option<(PolicyDoc, object_store::UpdateVersion)>> {
        match self.store.get(&self.key(ns)).await {
            Ok(r) => {
                let version = object_store::UpdateVersion {
                    e_tag: r.meta.e_tag.clone(),
                    version: r.meta.version.clone(),
                };
                let bytes = r.bytes().await?;
                let doc = serde_json::from_slice(&bytes)
                    .map_err(|e| GovernanceError::Corrupt(e.to_string()))?;
                Ok(Some((doc, version)))
            }
            Err(object_store::Error::NotFound { .. }) => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    /// CAS read-modify-write with retry, mirroring the manifest discipline
    /// (ADR-0004): create-if-absent or update-if-unchanged; backends without
    /// conditional put fall back to plain put (governance writes are
    /// admin-rare, so last-writer-wins there is acceptable).
    async fn update<F>(&self, ns: &str, mut apply: F) -> Result<PolicyDoc>
    where
        F: FnMut(&mut PolicyDoc) -> Result<()>,
    {
        let mut last = GovernanceError::CasConflict;
        for _ in 0..PUT_RETRIES {
            let (mut doc, prev) = match self.fetch_versioned(ns).await? {
                Some((doc, v)) => (doc, Some(v)),
                None => (PolicyDoc::new(ns), None),
            };
            apply(&mut doc)?;
            doc.revision += 1;
            doc.updated_at = now_ms();
            validate_doc(&doc)?;

            let body = serde_json::to_vec_pretty(&doc)
                .map_err(|e| GovernanceError::Corrupt(e.to_string()))?;
            let payload = PutPayload::from(Bytes::from(body));
            let mode = match prev {
                Some(v) => object_store::PutMode::Update(v),
                None => object_store::PutMode::Create,
            };
            let opts = object_store::PutOptions {
                mode,
                ..Default::default()
            };
            match self
                .store
                .put_opts(&self.key(ns), payload.clone(), opts)
                .await
            {
                Ok(_) => {
                    self.cache.write().await.insert(
                        ns.to_string(),
                        CacheEntry {
                            fetched: Instant::now(),
                            doc: Some(Arc::new(doc.clone())),
                        },
                    );
                    return Ok(doc);
                }
                Err(object_store::Error::Precondition { .. })
                | Err(object_store::Error::AlreadyExists { .. }) => {
                    last = GovernanceError::CasConflict;
                    continue;
                }
                Err(object_store::Error::NotSupported { .. })
                | Err(object_store::Error::NotImplemented) => {
                    self.store.put(&self.key(ns), payload).await?;
                    self.cache.write().await.insert(
                        ns.to_string(),
                        CacheEntry {
                            fetched: Instant::now(),
                            doc: Some(Arc::new(doc.clone())),
                        },
                    );
                    return Ok(doc);
                }
                Err(e) => return Err(e.into()),
            }
        }
        Err(last)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::policy::EgressRule;
    use serde_json::json;

    fn store() -> PolicyStore {
        PolicyStore::new(
            Arc::new(object_store::memory::InMemory::new()),
            "v1",
            Duration::from_secs(30),
        )
    }

    fn policy(v: serde_json::Value) -> Policy {
        serde_json::from_value(v).unwrap()
    }

    #[tokio::test]
    async fn put_get_roundtrip_and_revision() {
        let s = store();
        assert!(s.get("acme").await.unwrap().is_none());
        let d1 = s
            .put_namespace(
                "acme",
                policy(json!({ "retention": { "pitr_secs": 3600 } })),
            )
            .await
            .unwrap();
        assert_eq!(d1.revision, 1);
        let d2 = s
            .put_namespace("acme", policy(json!({ "retention": { "pitr_secs": 600 } })))
            .await
            .unwrap();
        assert_eq!(d2.revision, 2);
        let got = s.get("acme").await.unwrap().unwrap();
        assert_eq!(got.policy.retention.as_ref().unwrap().pitr_secs, Some(600));
    }

    #[tokio::test]
    async fn profile_override_tighten_only() {
        let s = store();
        s.put_namespace(
            "acme",
            policy(json!({ "retention": { "pitr_secs": 3600 } })),
        )
        .await
        .unwrap();
        let err = s
            .put_profile(
                "acme",
                "alice",
                Some(policy(json!({ "retention": { "pitr_secs": 7200 } }))),
            )
            .await
            .unwrap_err();
        assert!(matches!(err, GovernanceError::Loosens(_)), "{err}");

        s.put_profile(
            "acme",
            "alice",
            Some(policy(json!({ "retention": { "pitr_secs": 600 } }))),
        )
        .await
        .unwrap();
        let eff = s.effective_for_db("acme--alice").await.unwrap();
        assert_eq!(eff.pitr_secs, Some(600));
        let eff = s.effective_for_db("acme--bob").await.unwrap();
        assert_eq!(eff.pitr_secs, Some(3600));

        // clearing the override restores the namespace value
        s.put_profile("acme", "alice", None).await.unwrap();
        let eff = s.effective_for_db("acme--alice").await.unwrap();
        assert_eq!(eff.pitr_secs, Some(3600));
    }

    #[tokio::test]
    async fn non_memory_db_names_get_no_caps() {
        let s = store();
        s.put_namespace("acme", policy(json!({ "retention": { "pitr_secs": 600 } })))
            .await
            .unwrap();
        let eff = s.effective_for_db("plain-db").await.unwrap();
        assert_eq!(eff.pitr_secs, None);
    }

    #[tokio::test]
    async fn egress_policy_resolves() {
        let s = store();
        s.put_namespace(
            "acme",
            policy(json!({ "ai_egress": { "extract": "deny", "embed": "self_hosted_only" } })),
        )
        .await
        .unwrap();
        let eff = s.effective("acme", Some("alice")).await.unwrap();
        assert_eq!(eff.extract, EgressRule::Deny);
        assert_eq!(eff.embed, EgressRule::SelfHostedOnly);
        assert_eq!(eff.ask, EgressRule::Allow);
    }

    #[tokio::test]
    async fn list_returns_all_docs() {
        let s = store();
        s.put_namespace("acme", policy(json!({ "retention": { "pitr_secs": 600 } })))
            .await
            .unwrap();
        s.put_namespace(
            "globex",
            policy(json!({ "memory": { "task_ttl_max_secs": 300 } })),
        )
        .await
        .unwrap();
        let docs = s.list().await.unwrap();
        let mut names: Vec<_> = docs.iter().map(|d| d.namespace.as_str()).collect();
        names.sort();
        assert_eq!(names, vec!["acme", "globex"]);
    }

    #[tokio::test]
    async fn invalid_policy_rejected() {
        let s = store();
        let err = s
            .put_namespace("acme", policy(json!({ "retention": { "pitr_secs": 1 } })))
            .await
            .unwrap_err();
        assert!(matches!(err, GovernanceError::Invalid(_)));
    }
}
