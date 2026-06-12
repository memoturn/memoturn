use memoturn_api::AppState;
use memoturn_control::{EtcdLeases, LeaseManager, MemLeases, NodeIdentity};
use memoturn_engine::{LibsqlEngine, NodeConfig, NodeEngine, Registry};
use memoturn_replication::{Replicator, Shipper};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

fn build_object_store(url: &str) -> anyhow::Result<Arc<dyn object_store::ObjectStore>> {
    if let Some(path) = url.strip_prefix("file://") {
        std::fs::create_dir_all(path)?;
        Ok(Arc::new(
            object_store::local::LocalFileSystem::new_with_prefix(path)?,
        ))
    } else if let Some(rest) = url.strip_prefix("s3://") {
        let bucket = rest.split('/').next().unwrap_or(rest);
        let mut builder = object_store::aws::AmazonS3Builder::from_env().with_bucket_name(bucket);
        if std::env::var("AWS_ALLOW_HTTP").as_deref() == Ok("true") {
            builder = builder.with_allow_http(true); // MinIO / in-cluster endpoints
        }
        Ok(Arc::new(builder.build()?))
    } else if url == "mem://" {
        Ok(Arc::new(object_store::memory::InMemory::new()))
    } else {
        anyhow::bail!("unsupported MEMOTURN_OBJECT_STORE: {url}")
    }
}

/// Does the advertised address look reachable by other nodes (i.e. not a
/// loopback / unset default)? Used to detect an implicitly-multi-node setup that
/// must not run on the in-process lease table.
fn advertised_for_peers(advertise: &str) -> bool {
    let host = advertise
        .strip_prefix("http://")
        .or_else(|| advertise.strip_prefix("https://"))
        .unwrap_or(advertise);
    let host = host.split(['/', ':']).next().unwrap_or(host);
    !(host.is_empty()
        || host == "localhost"
        || host == "127.0.0.1"
        || host == "0.0.0.0"
        || host == "::1"
        || host.starts_with("127."))
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| {
                "memoturnd=info,memoturn_api=info,memoturn_replication=info".into()
            }),
        )
        .init();

    let data_dir: PathBuf = std::env::var("MEMOTURN_DATA_DIR")
        .unwrap_or_else(|_| "./data".into())
        .into();
    let listen = std::env::var("MEMOTURN_LISTEN").unwrap_or_else(|_| "127.0.0.1:8080".into());
    let hot_cap: u64 = std::env::var("MEMOTURN_HOT_CAP")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(50_000);
    let write_queue_cap: usize = std::env::var("MEMOTURN_WRITE_QUEUE_DEPTH")
        .ok()
        .and_then(|s| s.parse().ok())
        .filter(|n| *n > 0)
        .unwrap_or(256);
    let store_url = std::env::var("MEMOTURN_OBJECT_STORE")
        .unwrap_or_else(|_| format!("file://{}", data_dir.join("objects").display()));

    let engine = Arc::new(LibsqlEngine);
    let node = Arc::new(NodeEngine::new(
        engine.clone(),
        NodeConfig {
            data_dir: data_dir.clone(),
            hot_cap,
            write_queue_cap,
            ..Default::default()
        },
    ));
    let store = build_object_store(&store_url)?;

    {
        // Write-pressure reporter (docs/architecture/01, "Per-database write
        // ceiling" layer 1): surface per-DB queueing and sheds in the logs so
        // a hot database saturating its single writer is visible, not just a
        // mystery latency cliff. Quiet when there is nothing to report.
        let node = node.clone();
        tokio::spawn(async move {
            let mut last_shed: std::collections::HashMap<String, u64> = Default::default();
            loop {
                tokio::time::sleep(Duration::from_secs(30)).await;
                let mut next = std::collections::HashMap::new();
                for (key, h) in node.hot_entries() {
                    let s = h.write_stats();
                    let prev = last_shed.get(&key).copied().unwrap_or(0);
                    if s.queued > 0 || s.shed > prev {
                        tracing::warn!(
                            db = %key,
                            queued = s.queued,
                            shed_30s = s.shed - prev,
                            writes = s.writes,
                            commit_rounds = s.rounds,
                            "write pressure"
                        );
                    }
                    next.insert(key, s.shed);
                }
                last_shed = next;
            }
        });
    }

    // Prototype catalog durability: nodes are disposable (emptyDir), so the
    // node-local catalog is restored from / backed up to object storage. In
    // the full architecture the catalog lives in the control plane (doc 03).
    let catalog_key = object_store::path::Path::from("v1/_node/catalog.db");
    let registry_file = data_dir.join("registry.db");
    if !registry_file.exists() {
        if let Ok(obj) = store.get(&catalog_key).await {
            let bytes = obj.bytes().await?;
            std::fs::create_dir_all(&data_dir)?;
            std::fs::write(&registry_file, &bytes)?;
            tracing::info!("catalog restored from object storage");
        }
    }
    let registry = Arc::new(Registry::open(engine.as_ref(), &registry_file).await?);
    {
        // Periodic catalog backup (debounced by content hash).
        let registry = registry.clone();
        let store = store.clone();
        let scratch = data_dir.join("scratch");
        tokio::spawn(async move {
            let mut last_hash: u64 = 0;
            loop {
                tokio::time::sleep(Duration::from_secs(2)).await;
                let Ok(bytes) = registry.backup_bytes(&scratch).await else {
                    continue;
                };
                let hash = {
                    use std::hash::{Hash, Hasher};
                    let mut h = std::collections::hash_map::DefaultHasher::new();
                    bytes.hash(&mut h);
                    h.finish()
                };
                if hash != last_hash
                    && store
                        .put(&catalog_key, object_store::PutPayload::from(bytes))
                        .await
                        .is_ok()
                {
                    last_hash = hash;
                }
            }
        });
    }
    let replicator = Arc::new(Replicator::new(store.clone(), "v1"));
    let mesh = Arc::new(memoturn_api::mesh::Mesh::new(reqwest::Client::new()));
    let shipper = Arc::new(Shipper::new(
        replicator.clone(),
        node.clone(),
        Some(mesh.clone()),
    ));
    // Standard-durability shipping loop (~sub-second RPO) + burner-branch GC.
    shipper.clone().spawn(Duration::from_millis(500));

    // Writer leases: etcd when configured, in-process otherwise (single node).
    let advertise =
        std::env::var("MEMOTURN_ADVERTISE").unwrap_or_else(|_| format!("http://{listen}"));
    let node_id = std::env::var("MEMOTURN_NODE_ID")
        .unwrap_or_else(|_| format!("node-{}", std::process::id()));

    // Per-namespace audit stream (ADR-0010 phase 2): JSONL objects in object
    // storage, flushed by a background task. Always constructed; emission is
    // gated per namespace by the `audit.enabled` policy.
    let audit_flush_ms: u64 = std::env::var("MEMOTURN_AUDIT_FLUSH_MS")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(2000);
    let audit =
        memoturn_api::audit::AuditSink::spawn(store.clone(), "v1", &node_id, audit_flush_ms);
    let control: Arc<dyn LeaseManager> = match std::env::var("MEMOTURN_ETCD") {
        Ok(endpoints) => {
            let endpoints: Vec<String> = endpoints.split(',').map(str::to_string).collect();
            Arc::new(
                EtcdLeases::connect(
                    &endpoints,
                    NodeIdentity {
                        node_id,
                        addr: advertise,
                    },
                    10,
                )
                .await?,
            )
        }
        Err(_) => {
            // The in-process lease table cannot coordinate across nodes: every
            // node would believe it owns every database, breaking the
            // single-writer invariant (split-brain double writers). It is only
            // safe for a genuinely single-node process. Require an explicit
            // opt-in, and refuse it outright for any deployment that looks
            // multi-node (auth on, or a non-loopback advertised address other
            // peers could forward to).
            let single_node = std::env::var("MEMOTURN_SINGLE_NODE").as_deref() == Ok("1");
            let looks_clustered = std::env::var("MEMOTURN_AUTH").as_deref() == Ok("on")
                || advertised_for_peers(&advertise);
            if !single_node && looks_clustered {
                anyhow::bail!(
                    "no MEMOTURN_ETCD configured but this looks like a multi-node deployment \
                     (MEMOTURN_AUTH=on or a non-loopback MEMOTURN_ADVERTISE). The in-process \
                     lease table cannot enforce single-writer across nodes. Set MEMOTURN_ETCD, \
                     or MEMOTURN_SINGLE_NODE=1 if this really is a single node."
                );
            }
            if !single_node {
                tracing::warn!(
                    "using in-process writer leases (no MEMOTURN_ETCD) — safe for a single node \
                     only. Set MEMOTURN_ETCD before adding nodes."
                );
            }
            Arc::new(MemLeases::standalone(&advertise))
        }
    };

    // Auth: MEMOTURN_AUTH=on enables per-database JWTs (Ed25519 key), a platform
    // key for control-plane ops, and a cluster key for node-internal hops.
    // Default is OFF for local development — loudly. Production posture is
    // fail-closed: the operator must supply the platform key and a key source.
    let auth = match std::env::var("MEMOTURN_AUTH").as_deref() {
        Ok("on") => {
            // Fail closed: an auto-generated platform key would be unknowable to
            // operators and divergent across replicas. Require it explicitly.
            let platform_key = match std::env::var("MEMOTURN_PLATFORM_KEY") {
                Ok(k) if !k.trim().is_empty() => k,
                _ => anyhow::bail!(
                    "MEMOTURN_AUTH=on requires MEMOTURN_PLATFORM_KEY to be set \
                     (the control-plane credential). Refusing to start."
                ),
            };
            // Signing-key precedence: env (production: mounted from a K8s
            // Secret) → local file → object storage (opt-in; survives disposable
            // pods but persists the key unencrypted — see MEMOTURN_PERSIST_AUTH_KEY)
            // → generate. A generated key only persists to local disk by default,
            // so a multi-replica fleet MUST supply MEMOTURN_AUTH_KEY or a shared
            // secret; divergent per-node keys would reject each other's tokens.
            let persist_to_store = std::env::var("MEMOTURN_PERSIST_AUTH_KEY").as_deref() == Ok("1");
            let key_file = data_dir.join("auth.pkcs8");
            let auth_key_obj = object_store::path::Path::from("v1/_node/auth.pkcs8");
            let der: Vec<u8> = if let Ok(b64) = std::env::var("MEMOTURN_AUTH_KEY") {
                use base64::Engine as _;
                base64::engine::general_purpose::STANDARD
                    .decode(b64.trim())
                    .map_err(|e| anyhow::anyhow!("MEMOTURN_AUTH_KEY: {e}"))?
            } else if key_file.exists() {
                std::fs::read(&key_file)?
            } else if persist_to_store {
                if let Ok(obj) = store.get(&auth_key_obj).await {
                    let bytes = obj.bytes().await?.to_vec();
                    std::fs::write(&key_file, &bytes)?;
                    tracing::info!("signing key restored from object storage");
                    bytes
                } else {
                    let (_, der) =
                        memoturn_api::auth::AuthKeys::generate(String::new(), String::new())
                            .map_err(|e| anyhow::anyhow!(e))?;
                    std::fs::write(&key_file, &der)?;
                    let _ = store
                        .put(&auth_key_obj, object_store::PutPayload::from(der.clone()))
                        .await;
                    tracing::warn!(
                        "generated Ed25519 signing key and persisted it UNENCRYPTED to object \
                         storage (MEMOTURN_PERSIST_AUTH_KEY=1). Prefer MEMOTURN_AUTH_KEY from a \
                         KMS/sealed secret in production."
                    );
                    der
                }
            } else {
                let (_, der) = memoturn_api::auth::AuthKeys::generate(String::new(), String::new())
                    .map_err(|e| anyhow::anyhow!(e))?;
                std::fs::write(&key_file, &der)?;
                tracing::info!(
                    "generated Ed25519 signing key (local disk only). For a multi-replica fleet, \
                     set MEMOTURN_AUTH_KEY from a shared secret so tokens validate across nodes."
                );
                der
            };
            // Cluster key: explicit env wins (and must differ from the platform
            // key — collapsing them means a leaked control-plane key also forges
            // node-internal hops). Otherwise derive a stable key from the signing
            // material: it is already fleet-shared, so the derived cluster key is
            // identical on every node and distinct from the platform key, with no
            // extra secret to manage.
            let cluster_key = match std::env::var("MEMOTURN_CLUSTER_KEY") {
                Ok(k) if !k.trim().is_empty() => {
                    if memoturn_api::auth::ct_eq(&k, &platform_key) {
                        anyhow::bail!(
                            "MEMOTURN_CLUSTER_KEY must differ from MEMOTURN_PLATFORM_KEY \
                             (separate trust boundaries). Refusing to start."
                        );
                    }
                    k
                }
                _ => memoturn_api::auth::derive_cluster_key(&der),
            };
            let keys = memoturn_api::auth::AuthKeys::from_pkcs8(&der, platform_key, cluster_key)
                .map_err(|e| anyhow::anyhow!(e))?;
            memoturn_api::auth::Auth::Enabled(Arc::new(keys))
        }
        _ => {
            tracing::warn!(
                "AUTH IS DISABLED (dev mode) — set MEMOTURN_AUTH=on for any shared deployment"
            );
            memoturn_api::auth::Auth::Disabled
        }
    };

    // Server-side memory extraction (control-plane LLM service; ADR-0009).
    // Unconfigured = the /extract endpoint 503s and extraction stays BYO.
    let extractor: Option<Arc<dyn memoturn_api::extract::Extractor>> =
        match std::env::var("MEMOTURN_EXTRACT_API_KEY") {
            Ok(key) if !key.trim().is_empty() => {
                let model = std::env::var("MEMOTURN_EXTRACT_MODEL").ok();
                tracing::info!(
                    model = model.as_deref().unwrap_or("claude-opus-4-8"),
                    "memory extraction enabled"
                );
                Some(Arc::new(memoturn_api::extract::ClaudeExtractor::new(
                    reqwest::Client::new(),
                    key,
                    model,
                )))
            }
            _ => None,
        };

    // Recall answer synthesis (control-plane LLM; docs/architecture/06).
    // MEMOTURN_ASSISTANT_API_KEY enables it; falls back to the extraction key
    // so a node with extraction configured answers /ask for free. Unconfigured
    // = the /ask endpoint 503s and synthesis stays BYO.
    let answerer: Option<Arc<dyn memoturn_api::answer::Answerer>> =
        std::env::var("MEMOTURN_ASSISTANT_API_KEY")
            .ok()
            .filter(|k| !k.trim().is_empty())
            .or_else(|| {
                std::env::var("MEMOTURN_EXTRACT_API_KEY")
                    .ok()
                    .filter(|k| !k.trim().is_empty())
            })
            .map(|key| {
                let model = std::env::var("MEMOTURN_ASSISTANT_MODEL").ok();
                tracing::info!(
                    model = model.as_deref().unwrap_or("claude-opus-4-8"),
                    "recall answer synthesis enabled"
                );
                Arc::new(memoturn_api::answer::ClaudeAnswerer::new(
                    reqwest::Client::new(),
                    key,
                    model,
                )) as Arc<dyn memoturn_api::answer::Answerer>
            });

    // Server-side auto-embedding (MEMOTURN_EMBED_PROVIDER: voyage | openai;
    // openai + MEMOTURN_EMBED_BASE_URL also covers OpenAI-compatible local
    // servers). Unconfigured = vectors stay BYO; ingest/recall silently skip
    // the vector channel for text-only requests.
    let embedder =
        memoturn_api::embed::from_env(reqwest::Client::new()).map_err(|e| anyhow::anyhow!(e))?;
    if let Some(model) = memoturn_api::embed::configured_model() {
        tracing::info!(%model, "auto-embedding enabled");
    }
    let embed_provenance = memoturn_api::embed::provenance_from_env();
    if let Some(p) = &embed_provenance {
        tracing::info!(
            host = %p.endpoint_host,
            self_hosted = p.self_hosted,
            "embedder egress provenance"
        );
    }

    // Per-namespace data-governance policies (ADR-0010): authoritative in
    // object storage, read through a per-node cache — policy changes converge
    // on every node within the cache TTL without a restart.
    let policy_cache_secs: u64 = std::env::var("MEMOTURN_POLICY_CACHE_SECS")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(30);
    let governance = Arc::new(memoturn_governance::PolicyStore::new(
        store.clone(),
        "v1",
        Duration::from_secs(policy_cache_secs),
    ));
    // Erasure coupons (ADR-0010 phase 3) — durable in object storage, outside
    // any database prefix so the trail survives deletion.
    let erasures = Arc::new(memoturn_governance::ErasureLedger::new(store.clone(), "v1"));

    // The strata engine behind a flag (ADR-0011): memory profiles in the
    // listed namespaces (`*` = all) serve their typed surfaces from the
    // object-native engine instead of libSQL. Same object store, disjoint
    // root — the two engines never read each other's manifests.
    let strata =
        memoturn_api::strata_backend::StrataHost::from_env(store.clone(), data_dir.join("strata"));
    if let Some(_h) = &strata {
        tracing::info!(
            namespaces = %std::env::var("MEMOTURN_STRATA_NAMESPACES").unwrap_or_default(),
            "strata engine enabled for selected namespaces"
        );
    }

    let state = AppState {
        node,
        registry,
        replicator,
        shipper,
        control,
        mesh,
        auth,
        http: reqwest::Client::new(),
        extractor,
        embedder,
        answerer,
        governance,
        embed_provenance,
        audit: audit.clone(),
        erasures,
        strata,
    };
    // Re-arm token revocation across restarts: the registry's durable
    // tombstones re-seed the (possibly fresh) control-plane revocation list.
    let n = memoturn_api::seed_tombstones(&state).await;
    if n > 0 {
        tracing::info!(tombstones = n, "revocation list re-seeded from catalog");
    }
    {
        let state = state.clone();
        tokio::spawn(async move {
            let mut tick: u64 = 0;
            loop {
                tokio::time::sleep(Duration::from_secs(30)).await;
                tick += 1;
                let n = memoturn_api::gc_burner_branches(&state).await;
                if n > 0 {
                    tracing::info!(incinerated = n, "burner branch GC");
                }
                let n = memoturn_api::sweep_expired(&state).await;
                if n > 0 {
                    tracing::info!(swept = n, "expired memory/KV sweep");
                }
                // PITR retention + object refcount GC are heavier (they list
                // object storage); run them roughly every 10 minutes rather
                // than every tick. Retention first: it dereferences expired
                // history that a later GC pass then reclaims.
                if tick.is_multiple_of(20) {
                    // Erasures first: they dereference history that the same
                    // pass's GC then physically reclaims, and the verifier
                    // (which counts raw keys) runs after GC.
                    let n = memoturn_api::process_erasures(&state).await;
                    if n > 0 {
                        tracing::info!(pruned = n, "erasure history rewrite");
                    }
                    let n = memoturn_api::enforce_retention(&state).await;
                    if n > 0 {
                        tracing::info!(pruned = n, "PITR retention");
                    }
                    let n = memoturn_api::gc_objects(&state).await;
                    if n > 0 {
                        tracing::info!(reclaimed = n, "object refcount GC");
                    }
                    let n = memoturn_api::finalize_erasures(&state).await;
                    if n > 0 {
                        tracing::info!(completed = n, "erasures verified and receipted");
                    }
                    let n = memoturn_api::sweep_audit_retention(&state).await;
                    if n > 0 {
                        tracing::info!(deleted = n, "audit retention");
                    }
                }
            }
        });
    }

    let app = memoturn_api::router(state);
    let listener = tokio::net::TcpListener::bind(&listen).await?;
    tracing::info!(%listen, data_dir = %data_dir.display(), object_store = %store_url, "memoturnd listening");
    axum::serve(listener, app)
        .with_graceful_shutdown(async move {
            let _ = tokio::signal::ctrl_c().await;
            // Drain the audit buffer before the pod goes away — the crash-loss
            // window applies to crashes, not orderly shutdowns.
            audit.flush_now().await;
        })
        .await?;
    Ok(())
}
