//! Verifiable erasure (ADR-0010 phase 3): coupons and signed receipts.
//!
//! An erasure coupon records a forget at txid `T` and the promise that, after
//! a grace window, every trace below `T` is removed from object storage and
//! the removal is *proven* (objects are listed by their txid-encoded names)
//! and *signed*. Coupons live at
//! `{root}/_governance/erasures/{db_name}/{id}.json` — outside the database's
//! `{uuid}/` prefix so deleting the database doesn't destroy the evidence,
//! keyed by name so it survives uuid re-mint, and outside `__memoturn_*`
//! tables so a branch rewind can't resurrect the datum and lose the coupon
//! with it.

use crate::{GovernanceError, Result};
use bytes::Bytes;
use object_store::path::Path as ObjPath;
use object_store::{ObjectStore, PutPayload};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::collections::BTreeMap;
use std::sync::Arc;

/// What an erasure targets — exactly one of memory id, topic chain, or
/// session (optionally with its transcript).
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct ErasureTarget {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub memory_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub topic_key: Option<String>,
    #[serde(rename = "type", skip_serializing_if = "Option::is_none")]
    pub mtype: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub turns: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ErasureStatus {
    /// Forgotten at `forget_txid`; history rewrite awaits the grace window.
    Pending,
    /// History rewrite cannot proceed; see `blocked_by`. Re-checked each pass.
    Blocked,
    /// History below `forget_txid` is gone and verified; `receipt` proves it.
    Completed,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct BlockedBy {
    /// Named checkpoints pinning history below the forget txid — delete the
    /// checkpoint (or accept the pin) to proceed.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub checkpoints: Vec<String>,
    /// Branches forked below the forget txid: there the datum is live
    /// content, not history — forget it there (or delete the branch) too.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub branches: Vec<String>,
}

impl BlockedBy {
    pub fn any(&self) -> bool {
        !self.checkpoints.is_empty() || !self.branches.is_empty()
    }
}

/// The signed proof embedded in a completed coupon. `payload` is the exact
/// JSON that was signed (workspace serde_json sorts map keys, so its string
/// form is canonical); anyone holding the cluster public key verifies
/// offline. `alg: "none"` on auth-disabled dev nodes — stated, not implied.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Receipt {
    pub payload: Value,
    pub alg: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub key_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sig: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ErasureCoupon {
    pub id: String,
    /// Database name (`{ns}--{profile}`) — coupons are keyed by name, not
    /// uuid, so the trail survives deletion and re-creation.
    pub db: String,
    pub uuid: String,
    pub target: ErasureTarget,
    /// The ids the forget actually removed at request time.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub memory_ids: Vec<String>,
    pub requested_at: i64,
    pub grace_until: i64,
    /// branch → txid of the forget on that branch (v1: the request branch).
    pub forget_txid: BTreeMap<String, u64>,
    pub status: ErasureStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub blocked_by: Option<BlockedBy>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub completed_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub receipt: Option<Receipt>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

const SIGN_CONTEXT: &[u8] = b"memoturn-erasure-receipt-v1\0";

/// Sign a receipt payload with the cluster's Ed25519 key (the same pkcs8 the
/// JWTs use, domain-separated so the signatures can never be confused).
/// `None` pkcs8 (auth disabled) yields an explicit unsigned receipt.
pub fn sign_receipt(pkcs8: Option<&[u8]>, payload: Value) -> Result<Receipt> {
    let Some(der) = pkcs8 else {
        return Ok(Receipt {
            payload,
            alg: "none".into(),
            key_id: None,
            sig: None,
        });
    };
    let pair = ring::signature::Ed25519KeyPair::from_pkcs8(der)
        .map_err(|e| GovernanceError::Invalid(format!("signing key: {e}")))?;
    use ring::signature::KeyPair;
    let mut msg = SIGN_CONTEXT.to_vec();
    msg.extend_from_slice(payload.to_string().as_bytes());
    let sig = pair.sign(&msg);
    use base64::Engine as _;
    Ok(Receipt {
        payload,
        alg: "ed25519".into(),
        key_id: Some(key_id(pair.public_key().as_ref())),
        sig: Some(base64::engine::general_purpose::STANDARD.encode(sig.as_ref())),
    })
}

/// Verify a receipt against the cluster public key (raw Ed25519 public bytes).
pub fn verify_receipt(public_key: &[u8], receipt: &Receipt) -> bool {
    let (Some(sig), "ed25519") = (&receipt.sig, receipt.alg.as_str()) else {
        return false;
    };
    use base64::Engine as _;
    let Ok(sig) = base64::engine::general_purpose::STANDARD.decode(sig) else {
        return false;
    };
    let mut msg = SIGN_CONTEXT.to_vec();
    msg.extend_from_slice(receipt.payload.to_string().as_bytes());
    ring::signature::UnparsedPublicKey::new(&ring::signature::ED25519, public_key)
        .verify(&msg, &sig)
        .is_ok()
}

fn key_id(public_key: &[u8]) -> String {
    let digest = ring::digest::digest(&ring::digest::SHA256, public_key);
    digest.as_ref()[..8]
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// The coupon store. Creation is create-if-absent (fresh ids); status
/// updates are plain puts — maintenance passes are idempotent and converge,
/// so a lost race between two nodes re-verifying the same coupon is benign.
pub struct ErasureLedger {
    store: Arc<dyn ObjectStore>,
    root: String,
}

impl ErasureLedger {
    pub fn new(store: Arc<dyn ObjectStore>, root: &str) -> Self {
        Self {
            store,
            root: root.trim_matches('/').to_string(),
        }
    }

    fn key(&self, db: &str, id: &str) -> ObjPath {
        ObjPath::from(format!("{}/_governance/erasures/{db}/{id}.json", self.root))
    }

    pub async fn create(&self, coupon: &ErasureCoupon) -> Result<()> {
        let body = serde_json::to_vec_pretty(coupon)
            .map_err(|e| GovernanceError::Corrupt(e.to_string()))?;
        let opts = object_store::PutOptions {
            mode: object_store::PutMode::Create,
            ..Default::default()
        };
        match self
            .store
            .put_opts(
                &self.key(&coupon.db, &coupon.id),
                PutPayload::from(Bytes::from(body.clone())),
                opts,
            )
            .await
        {
            Ok(_) => Ok(()),
            Err(object_store::Error::AlreadyExists { .. }) => Err(GovernanceError::CasConflict),
            Err(object_store::Error::NotSupported { .. })
            | Err(object_store::Error::NotImplemented) => {
                self.store
                    .put(
                        &self.key(&coupon.db, &coupon.id),
                        PutPayload::from(Bytes::from(body)),
                    )
                    .await?;
                Ok(())
            }
            Err(e) => Err(e.into()),
        }
    }

    pub async fn update(&self, coupon: &ErasureCoupon) -> Result<()> {
        let body = serde_json::to_vec_pretty(coupon)
            .map_err(|e| GovernanceError::Corrupt(e.to_string()))?;
        self.store
            .put(
                &self.key(&coupon.db, &coupon.id),
                PutPayload::from(Bytes::from(body)),
            )
            .await?;
        Ok(())
    }

    pub async fn get(&self, db: &str, id: &str) -> Result<Option<ErasureCoupon>> {
        match self.store.get(&self.key(db, id)).await {
            Ok(r) => {
                let bytes = r.bytes().await?;
                Ok(Some(
                    serde_json::from_slice(&bytes)
                        .map_err(|e| GovernanceError::Corrupt(e.to_string()))?,
                ))
            }
            Err(object_store::Error::NotFound { .. }) => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    /// All coupons for one database, newest request first.
    pub async fn list(&self, db: &str) -> Result<Vec<ErasureCoupon>> {
        let prefix = ObjPath::from(format!("{}/_governance/erasures/{db}", self.root));
        let mut coupons = self.collect(&prefix).await?;
        coupons.sort_by_key(|c| std::cmp::Reverse(c.requested_at));
        Ok(coupons)
    }

    /// Every coupon not yet completed, across all databases — the maintenance
    /// pass's work list.
    pub async fn unfinished(&self) -> Result<Vec<ErasureCoupon>> {
        let prefix = ObjPath::from(format!("{}/_governance/erasures", self.root));
        let mut coupons = self.collect(&prefix).await?;
        coupons.retain(|c| c.status != ErasureStatus::Completed);
        coupons.sort_by_key(|c| c.requested_at);
        Ok(coupons)
    }

    async fn collect(&self, prefix: &ObjPath) -> Result<Vec<ErasureCoupon>> {
        use futures::TryStreamExt;
        let keys: Vec<ObjPath> = self
            .store
            .list(Some(prefix))
            .map_ok(|m| m.location)
            .try_collect()
            .await
            .map_err(GovernanceError::from)?;
        let mut out = Vec::with_capacity(keys.len());
        for key in keys {
            match self.store.get(&key).await {
                Ok(r) => {
                    let bytes = r.bytes().await?;
                    match serde_json::from_slice::<ErasureCoupon>(&bytes) {
                        Ok(c) => out.push(c),
                        Err(e) => {
                            tracing::warn!(key = %key, error = %e, "skipping corrupt erasure coupon")
                        }
                    }
                }
                Err(object_store::Error::NotFound { .. }) => {}
                Err(e) => return Err(e.into()),
            }
        }
        Ok(out)
    }
}

/// The receipt payload for a verified erasure — what gets signed.
pub fn receipt_payload(coupon: &ErasureCoupon, completed_at: i64, evidence: Value) -> Value {
    json!({
        "db": coupon.db,
        "uuid": coupon.uuid,
        "erasure_id": coupon.id,
        "target": coupon.target,
        "memory_ids": coupon.memory_ids,
        "forget_txid": coupon.forget_txid,
        "completed_at": completed_at,
        "evidence": evidence,
        "claims": [
            "rows, full-text entries, and vectors deleted at forget_txid with secure_delete page zeroing",
            "no object-storage snapshot or segment below forget_txid remains referenced or stored",
            "node-local cache copies are transient and converge or evict; object storage is the source of truth",
        ],
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn coupon(id: &str, status: ErasureStatus) -> ErasureCoupon {
        ErasureCoupon {
            id: id.into(),
            db: "acme--alice".into(),
            uuid: "u1".into(),
            target: ErasureTarget {
                memory_id: Some("mem_x".into()),
                ..Default::default()
            },
            memory_ids: vec!["mem_x".into()],
            requested_at: 5,
            grace_until: 10,
            forget_txid: BTreeMap::from([("main".to_string(), 42u64)]),
            status,
            blocked_by: None,
            completed_at: None,
            receipt: None,
            extra: Map::new(),
        }
    }

    fn ledger() -> ErasureLedger {
        ErasureLedger::new(Arc::new(object_store::memory::InMemory::new()), "v1")
    }

    #[tokio::test]
    async fn create_get_update_roundtrip() {
        let l = ledger();
        let mut c = coupon("ers_1", ErasureStatus::Pending);
        l.create(&c).await.unwrap();
        // Fresh ids never collide; a duplicate create is a conflict.
        assert!(matches!(
            l.create(&c).await,
            Err(GovernanceError::CasConflict)
        ));
        let got = l.get("acme--alice", "ers_1").await.unwrap().unwrap();
        assert_eq!(got.status, ErasureStatus::Pending);
        assert_eq!(got.forget_txid["main"], 42);

        c.status = ErasureStatus::Completed;
        c.completed_at = Some(11);
        l.update(&c).await.unwrap();
        let got = l.get("acme--alice", "ers_1").await.unwrap().unwrap();
        assert_eq!(got.status, ErasureStatus::Completed);
    }

    #[tokio::test]
    async fn unfinished_filters_completed() {
        let l = ledger();
        l.create(&coupon("ers_a", ErasureStatus::Pending))
            .await
            .unwrap();
        l.create(&coupon("ers_b", ErasureStatus::Completed))
            .await
            .unwrap();
        l.create(&coupon("ers_c", ErasureStatus::Blocked))
            .await
            .unwrap();
        let work: Vec<String> = l
            .unfinished()
            .await
            .unwrap()
            .into_iter()
            .map(|c| c.id)
            .collect();
        assert_eq!(work.len(), 2);
        assert!(work.contains(&"ers_a".to_string()));
        assert!(work.contains(&"ers_c".to_string()));
        assert_eq!(l.list("acme--alice").await.unwrap().len(), 3);
    }

    #[test]
    fn receipt_signs_and_verifies() {
        let rng = ring::rand::SystemRandom::new();
        let pkcs8 = ring::signature::Ed25519KeyPair::generate_pkcs8(&rng).unwrap();
        let pair = ring::signature::Ed25519KeyPair::from_pkcs8(pkcs8.as_ref()).unwrap();
        use ring::signature::KeyPair;
        let public = pair.public_key().as_ref().to_vec();

        let payload = receipt_payload(
            &coupon("ers_1", ErasureStatus::Pending),
            99,
            json!({"manifests_checked": 1}),
        );
        let receipt = sign_receipt(Some(pkcs8.as_ref()), payload.clone()).unwrap();
        assert_eq!(receipt.alg, "ed25519");
        assert!(verify_receipt(&public, &receipt));

        // Tampering with the payload breaks verification.
        let mut tampered = receipt.clone();
        tampered.payload["db"] = json!("acme--mallory");
        assert!(!verify_receipt(&public, &tampered));
        // A different key does not verify.
        let other = ring::signature::Ed25519KeyPair::generate_pkcs8(&rng).unwrap();
        let other_pair = ring::signature::Ed25519KeyPair::from_pkcs8(other.as_ref()).unwrap();
        assert!(!verify_receipt(other_pair.public_key().as_ref(), &receipt));

        // Auth-disabled nodes produce an explicit unsigned receipt.
        let unsigned = sign_receipt(None, payload).unwrap();
        assert_eq!(unsigned.alg, "none");
        assert!(unsigned.sig.is_none());
    }
}
