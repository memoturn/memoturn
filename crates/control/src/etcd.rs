use crate::{ControlError, LeaseManager, NodeIdentity, Owner, Ownership, Result};
use async_trait::async_trait;
use etcd_client::{Client, Compare, CompareOp, PutOptions, Txn, TxnOp};
use tokio::sync::Mutex;

const OWNER_PREFIX: &str = "/memoturn/owner/";
const EPOCH_PREFIX: &str = "/memoturn/epoch/";
const UUID_PREFIX: &str = "/memoturn/dbuuid/";
const TOMBSTONE_PREFIX: &str = "/memoturn/tombstone/";

/// etcd-backed leases: one etcd lease per node (TTL ~10 s, kept alive by a
/// background task); every owned database's owner key is attached to that
/// lease, so node death releases all its databases within the TTL. Epoch
/// counters are plain keys (no lease) — they survive and only move forward.
pub struct EtcdLeases {
    client: Mutex<Client>,
    lease_id: i64,
    identity: NodeIdentity,
}

fn err(e: etcd_client::Error) -> ControlError {
    ControlError::Etcd(e.to_string())
}

impl EtcdLeases {
    pub async fn connect(
        endpoints: &[String],
        identity: NodeIdentity,
        ttl_secs: i64,
    ) -> Result<Self> {
        let mut client = Client::connect(endpoints, None).await.map_err(err)?;
        let lease = client.lease_grant(ttl_secs, None).await.map_err(err)?;
        let lease_id = lease.id();
        let (mut keeper, mut stream) = client.lease_keep_alive(lease_id).await.map_err(err)?;
        let interval = std::time::Duration::from_secs((ttl_secs as u64 / 3).max(1));
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(interval).await;
                if keeper.keep_alive().await.is_err() {
                    tracing::error!("etcd lease keepalive failed; node will lose ownership");
                    break;
                }
                let _ = stream.message().await;
            }
        });
        Ok(Self {
            client: Mutex::new(client),
            lease_id,
            identity,
        })
    }
}

#[async_trait]
impl LeaseManager for EtcdLeases {
    fn identity(&self) -> &NodeIdentity {
        &self.identity
    }

    async fn lookup(&self, key: &str) -> Result<Option<Ownership>> {
        let mut client = self.client.lock().await;
        let resp = client
            .get(format!("{OWNER_PREFIX}{key}"), None)
            .await
            .map_err(err)?;
        match resp.kvs().first() {
            Some(kv) => Ok(Some(
                serde_json::from_slice(kv.value())
                    .map_err(|e| ControlError::Corrupt(e.to_string()))?,
            )),
            None => Ok(None),
        }
    }

    async fn resolve_owner(&self, key: &str) -> Result<Owner> {
        // Fast path: somebody owns it.
        if let Some(o) = self.lookup(key).await? {
            return Ok(if o.node_id == self.identity.node_id {
                Owner::Local {
                    epoch: o.epoch,
                    acquired: false,
                }
            } else {
                Owner::Remote(o)
            });
        }
        // Lazy acquisition: epoch+1 with the owner key attached to this
        // node's lease, atomically guarded against races on both keys.
        let owner_key = format!("{OWNER_PREFIX}{key}");
        let epoch_key = format!("{EPOCH_PREFIX}{key}");
        for _ in 0..4 {
            let mut client = self.client.lock().await;
            let cur = client.get(epoch_key.as_str(), None).await.map_err(err)?;
            let (cur_epoch, epoch_cmp) = match cur.kvs().first() {
                Some(kv) => {
                    let e: u64 = String::from_utf8_lossy(kv.value())
                        .parse()
                        .map_err(|_| ControlError::Corrupt("bad epoch".into()))?;
                    (
                        e,
                        Compare::mod_revision(
                            epoch_key.as_str(),
                            CompareOp::Equal,
                            kv.mod_revision(),
                        ),
                    )
                }
                None => (
                    0,
                    Compare::create_revision(epoch_key.as_str(), CompareOp::Equal, 0),
                ),
            };
            let next = Ownership {
                node_id: self.identity.node_id.clone(),
                addr: self.identity.addr.clone(),
                epoch: cur_epoch + 1,
            };
            let value =
                serde_json::to_vec(&next).map_err(|e| ControlError::Corrupt(e.to_string()))?;
            let txn = Txn::new()
                .when(vec![
                    Compare::create_revision(owner_key.as_str(), CompareOp::Equal, 0),
                    epoch_cmp,
                ])
                .and_then(vec![
                    TxnOp::put(
                        owner_key.as_str(),
                        value,
                        Some(PutOptions::new().with_lease(self.lease_id)),
                    ),
                    TxnOp::put(epoch_key.as_str(), next.epoch.to_string(), None),
                ]);
            let resp = client.txn(txn).await.map_err(err)?;
            drop(client);
            if resp.succeeded() {
                return Ok(Owner::Local {
                    epoch: next.epoch,
                    acquired: true,
                });
            }
            // Lost the race — someone else owns it now (or epoch moved).
            if let Some(o) = self.lookup(key).await? {
                return Ok(if o.node_id == self.identity.node_id {
                    Owner::Local {
                        epoch: o.epoch,
                        acquired: false,
                    }
                } else {
                    Owner::Remote(o)
                });
            }
        }
        Err(ControlError::Etcd(
            "ownership acquisition kept racing".into(),
        ))
    }

    async fn resolve_uuid(&self, key: &str, proposed: &str) -> Result<String> {
        let uuid_key = format!("{UUID_PREFIX}{key}");
        let mut client = self.client.lock().await;
        // CAS-create: put `proposed` iff the key is absent; otherwise read the
        // value that won. Either branch returns the single canonical uuid.
        let txn = Txn::new()
            .when(vec![Compare::create_revision(
                uuid_key.as_str(),
                CompareOp::Equal,
                0,
            )])
            .and_then(vec![TxnOp::put(uuid_key.as_str(), proposed, None)])
            .or_else(vec![TxnOp::get(uuid_key.as_str(), None)]);
        let resp = client.txn(txn).await.map_err(err)?;
        if resp.succeeded() {
            return Ok(proposed.to_string());
        }
        for op in resp.op_responses() {
            if let etcd_client::TxnOpResponse::Get(g) = op {
                if let Some(kv) = g.kvs().first() {
                    return Ok(String::from_utf8_lossy(kv.value()).into_owned());
                }
            }
        }
        Err(ControlError::Etcd(
            "uuid resolution returned no value".into(),
        ))
    }

    async fn tombstone(&self, key: &str, at_ms: i64) -> Result<()> {
        let tkey = format!("{TOMBSTONE_PREFIX}{key}");
        let mut client = self.client.lock().await;
        // Monotonic: keep the latest deletion time if one already exists.
        let cur = client.get(tkey.as_str(), None).await.map_err(err)?;
        let prev = cur
            .kvs()
            .first()
            .and_then(|kv| String::from_utf8_lossy(kv.value()).parse::<i64>().ok())
            .unwrap_or(i64::MIN);
        if at_ms > prev {
            client
                .put(tkey.as_str(), at_ms.to_string(), None)
                .await
                .map_err(err)?;
        }
        Ok(())
    }

    async fn deleted_at(&self, key: &str) -> Result<Option<i64>> {
        let mut client = self.client.lock().await;
        let resp = client
            .get(format!("{TOMBSTONE_PREFIX}{key}"), None)
            .await
            .map_err(err)?;
        Ok(resp
            .kvs()
            .first()
            .and_then(|kv| String::from_utf8_lossy(kv.value()).parse::<i64>().ok()))
    }

    async fn release(&self, key: &str) -> Result<()> {
        let mut client = self.client.lock().await;
        client
            .delete(format!("{OWNER_PREFIX}{key}"), None)
            .await
            .map_err(err)?;
        Ok(())
    }

    async fn release_all(&self) -> Result<()> {
        let mut client = self.client.lock().await;
        client.lease_revoke(self.lease_id).await.map_err(err)?;
        Ok(())
    }
}
