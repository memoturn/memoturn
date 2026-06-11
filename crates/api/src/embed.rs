//! Server-side auto-embedding (docs/architecture/07, ADR-0009 fast-follow):
//! embed memory summaries at ingest and query strings at recall when the
//! client didn't bring vectors — completing hybrid recall for bare-text
//! clients (CLI, MCP, extraction output).
//!
//! Same control-plane posture as extraction: configured per node via env,
//! the embedding call runs before the database write, and unconfigured nodes
//! simply skip it (vectors stay bring-your-own).
//!
//! Provider is `MEMOTURN_EMBED_PROVIDER` (`voyage` default | `openai`), keyed
//! by `MEMOTURN_EMBED_API_KEY`, with `MEMOTURN_EMBED_MODEL` and
//! `MEMOTURN_EMBED_BASE_URL` overrides. The OpenAI impl speaks the
//! `/v1/embeddings` wire shape, so a `base_url` pointing at any
//! OpenAI-compatible server (Ollama, vLLM, LM Studio, …) gives a fully
//! self-hosted embedder with no external egress.

use async_trait::async_trait;
use serde_json::{json, Value as Json};
use std::sync::Arc;

/// Documents and queries embed differently in retrieval-tuned models.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EmbedKind {
    Document,
    Query,
}

#[async_trait]
pub trait Embedder: Send + Sync {
    async fn embed(&self, texts: &[String], kind: EmbedKind) -> Result<Vec<Vec<f32>>, String>;
}

/// Construct the configured embedder, or `None` when unconfigured (vectors stay
/// bring-your-own). Errors only on an unknown provider name — a typo there
/// should fail loudly at startup, not silently disable embeddings.
pub fn from_env(http: reqwest::Client) -> Result<Option<Arc<dyn Embedder>>, String> {
    let Some(key) = std::env::var("MEMOTURN_EMBED_API_KEY")
        .ok()
        .filter(|k| !k.trim().is_empty())
    else {
        return Ok(None);
    };
    let model = std::env::var("MEMOTURN_EMBED_MODEL").ok();
    let base_url = std::env::var("MEMOTURN_EMBED_BASE_URL").ok();
    let provider = std::env::var("MEMOTURN_EMBED_PROVIDER").unwrap_or_else(|_| "voyage".into());
    let embedder: Arc<dyn Embedder> = match provider.as_str() {
        "voyage" => Arc::new(VoyageEmbedder::new(http, key, model, base_url)),
        "openai" => Arc::new(OpenAiEmbedder::new(http, key, model, base_url)),
        other => {
            return Err(format!(
                "unknown MEMOTURN_EMBED_PROVIDER '{other}' (expected voyage|openai)"
            ))
        }
    };
    Ok(Some(embedder))
}

/// Where embeddings go when this node embeds: provider, model, and whether
/// the endpoint is self-hosted (no external egress). Computed once at startup
/// from env — no DNS, no per-request cost — and consumed by the `ai_egress`
/// policy (`embed: self_hosted_only`, ADR-0010).
#[derive(Debug, Clone)]
pub struct EmbedProvenance {
    pub provider: String,
    pub model: String,
    pub endpoint_host: String,
    pub self_hosted: bool,
}

/// Provenance of the configured embedder, or `None` when unconfigured.
pub fn provenance_from_env() -> Option<EmbedProvenance> {
    std::env::var("MEMOTURN_EMBED_API_KEY")
        .ok()
        .filter(|k| !k.trim().is_empty())?;
    let provider = std::env::var("MEMOTURN_EMBED_PROVIDER").unwrap_or_else(|_| "voyage".into());
    let model = std::env::var("MEMOTURN_EMBED_MODEL").unwrap_or_else(|_| {
        match provider.as_str() {
            "openai" => "text-embedding-3-small",
            _ => "voyage-3.5",
        }
        .into()
    });
    let base_url = std::env::var("MEMOTURN_EMBED_BASE_URL")
        .ok()
        .filter(|u| !u.trim().is_empty());
    let endpoint_host = match &base_url {
        Some(u) => url_host(u),
        None => match provider.as_str() {
            "openai" => "api.openai.com".into(),
            _ => "api.voyageai.com".into(),
        },
    };
    let allowlist: Vec<String> = std::env::var("MEMOTURN_EMBED_SELF_HOSTED_HOSTS")
        .map(|s| s.split(',').map(|h| h.trim().to_string()).collect())
        .unwrap_or_default();
    // The default provider endpoints are never self-hosted; only an explicit
    // base URL pointing somewhere private qualifies. This is an honest,
    // syntactic check — it trusts the operator's network config; the policy
    // governs the product's egress features, not the host.
    let self_hosted = base_url.is_some() && host_is_self_hosted(&endpoint_host, &allowlist);
    Some(EmbedProvenance {
        provider,
        model,
        endpoint_host,
        self_hosted,
    })
}

/// Host part of a URL: scheme stripped, path/port dropped, IPv6 brackets kept.
fn url_host(url: &str) -> String {
    let rest = url
        .strip_prefix("https://")
        .or_else(|| url.strip_prefix("http://"))
        .unwrap_or(url);
    let rest = rest.split('/').next().unwrap_or(rest);
    if let Some(end) = rest.strip_prefix('[').and_then(|r| r.find(']')) {
        return rest[..end + 2].to_string(); // "[::1]" with brackets
    }
    rest.split(':').next().unwrap_or(rest).to_string()
}

/// Is `host` a self-hosted endpoint? Loopback, RFC1918/link-local addresses,
/// cluster-internal suffixes, dot-less service names (unroutable on the public
/// internet), or the operator allowlist (covers a self-hosted server behind a
/// public-DNS internal load balancer).
pub fn host_is_self_hosted(host: &str, allowlist: &[String]) -> bool {
    if allowlist.iter().any(|a| a == host) {
        return true;
    }
    let bare = host.trim_start_matches('[').trim_end_matches(']');
    if bare == "localhost" {
        return true;
    }
    if let Ok(ip) = bare.parse::<std::net::IpAddr>() {
        return match ip {
            std::net::IpAddr::V4(v4) => v4.is_loopback() || v4.is_private() || v4.is_link_local(),
            std::net::IpAddr::V6(v6) => v6.is_loopback(),
        };
    }
    host.ends_with(".svc.cluster.local") || host.ends_with(".internal") || !host.contains('.')
}

/// The model id a configured embedder reports, for the startup log line.
pub fn configured_model() -> Option<String> {
    std::env::var("MEMOTURN_EMBED_API_KEY")
        .ok()
        .filter(|k| !k.trim().is_empty())?;
    let provider = std::env::var("MEMOTURN_EMBED_PROVIDER").unwrap_or_else(|_| "voyage".into());
    let default = match provider.as_str() {
        "openai" => "text-embedding-3-small",
        _ => "voyage-3.5",
    };
    Some(format!(
        "{provider}/{}",
        std::env::var("MEMOTURN_EMBED_MODEL").unwrap_or_else(|_| default.into())
    ))
}

/// POST an `/v1/embeddings` request (Voyage and OpenAI share this surface:
/// `Bearer` auth, `{data: [{embedding, index}]}` response) and return the
/// vectors ordered by `index`.
async fn post_embeddings(
    http: &reqwest::Client,
    base_url: &str,
    api_key: &str,
    body: Json,
    n: usize,
) -> Result<Vec<Vec<f32>>, String> {
    let resp = http
        .post(format!("{base_url}/v1/embeddings"))
        .header("authorization", format!("Bearer {api_key}"))
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("embedding request failed: {e}"))?;
    let status = resp.status();
    let payload: Json = resp
        .json()
        .await
        .map_err(|e| format!("embedding response unreadable: {e}"))?;
    if !status.is_success() {
        // Voyage reports `detail`; OpenAI reports `error.message`.
        let msg = payload["error"]["message"]
            .as_str()
            .or(payload["detail"].as_str())
            .unwrap_or("unknown error");
        return Err(format!("embedding model error ({status}): {msg}"));
    }
    let data = payload["data"]
        .as_array()
        .ok_or("embedding response had no data array")?;
    if data.len() != n {
        return Err(format!(
            "embedding count mismatch: {n} texts, {} vectors",
            data.len()
        ));
    }
    // Both providers echo a per-entry `index`; sort by it rather than trust
    // array order.
    let mut indexed: Vec<(usize, Vec<f32>)> = data
        .iter()
        .enumerate()
        .map(|(i, d)| {
            let idx = d["index"].as_u64().map(|x| x as usize).unwrap_or(i);
            let v = d["embedding"]
                .as_array()
                .map(|v| {
                    v.iter()
                        .filter_map(|x| x.as_f64().map(|f| f as f32))
                        .collect()
                })
                .ok_or_else(|| "embedding entry missing vector".to_string())?;
            Ok((idx, v))
        })
        .collect::<Result<_, String>>()?;
    indexed.sort_by_key(|(i, _)| *i);
    Ok(indexed.into_iter().map(|(_, v)| v).collect())
}

/// Voyage AI embeddings — retrieval-tuned, with asymmetric document/query
/// `input_type`.
pub struct VoyageEmbedder {
    http: reqwest::Client,
    api_key: String,
    model: String,
    base_url: String,
}

impl VoyageEmbedder {
    pub fn new(
        http: reqwest::Client,
        api_key: String,
        model: Option<String>,
        base_url: Option<String>,
    ) -> Self {
        Self {
            http,
            api_key,
            model: model.unwrap_or_else(|| "voyage-3.5".to_string()),
            base_url: base_url.unwrap_or_else(|| "https://api.voyageai.com".to_string()),
        }
    }
}

#[async_trait]
impl Embedder for VoyageEmbedder {
    async fn embed(&self, texts: &[String], kind: EmbedKind) -> Result<Vec<Vec<f32>>, String> {
        if texts.is_empty() {
            return Ok(Vec::new());
        }
        let body = json!({
            "model": self.model,
            "input": texts,
            "input_type": match kind {
                EmbedKind::Document => "document",
                EmbedKind::Query => "query",
            },
        });
        post_embeddings(&self.http, &self.base_url, &self.api_key, body, texts.len()).await
    }
}

/// OpenAI embeddings (and any OpenAI-compatible server via `base_url`). The
/// embeddings are symmetric — there is no document/query distinction — so the
/// `EmbedKind` is ignored.
pub struct OpenAiEmbedder {
    http: reqwest::Client,
    api_key: String,
    model: String,
    base_url: String,
}

impl OpenAiEmbedder {
    pub fn new(
        http: reqwest::Client,
        api_key: String,
        model: Option<String>,
        base_url: Option<String>,
    ) -> Self {
        Self {
            http,
            api_key,
            model: model.unwrap_or_else(|| "text-embedding-3-small".to_string()),
            base_url: base_url.unwrap_or_else(|| "https://api.openai.com".to_string()),
        }
    }
}

#[async_trait]
impl Embedder for OpenAiEmbedder {
    async fn embed(&self, texts: &[String], _kind: EmbedKind) -> Result<Vec<Vec<f32>>, String> {
        if texts.is_empty() {
            return Ok(Vec::new());
        }
        let body = json!({ "model": self.model, "input": texts });
        post_embeddings(&self.http, &self.base_url, &self.api_key, body, texts.len()).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn self_hosted_classifier() {
        let none: &[String] = &[];
        // Loopback / private / link-local / cluster-internal / bare names.
        assert!(host_is_self_hosted("localhost", none));
        assert!(host_is_self_hosted("127.0.0.1", none));
        assert!(host_is_self_hosted("[::1]", none));
        assert!(host_is_self_hosted("10.1.2.3", none));
        assert!(host_is_self_hosted("172.16.0.9", none));
        assert!(host_is_self_hosted("192.168.1.4", none));
        assert!(host_is_self_hosted("embed.ml.svc.cluster.local", none));
        assert!(host_is_self_hosted("vllm.internal", none));
        assert!(host_is_self_hosted("ollama", none)); // dot-less service name
                                                      // Public endpoints are not.
        assert!(!host_is_self_hosted("api.openai.com", none));
        assert!(!host_is_self_hosted("api.voyageai.com", none));
        assert!(!host_is_self_hosted("8.8.8.8", none));
        // The allowlist covers internal LBs with public DNS names.
        let allow = vec!["embed.corp.example.com".to_string()];
        assert!(host_is_self_hosted("embed.corp.example.com", &allow));
        assert!(!host_is_self_hosted("other.example.com", &allow));
    }

    #[test]
    fn url_host_extraction() {
        assert_eq!(url_host("http://localhost:11434/v1"), "localhost");
        assert_eq!(url_host("https://api.openai.com"), "api.openai.com");
        assert_eq!(url_host("http://[::1]:8000"), "[::1]");
        assert_eq!(url_host("http://10.0.0.5:8000/path"), "10.0.0.5");
    }

    /// A minimal `/v1/embeddings` stub returning deterministic vectors; the
    /// `check` closure asserts on the request body shape per provider.
    async fn stub_server(check: impl Fn(&Json) + Clone + Send + Sync + 'static) -> String {
        let app = axum::Router::new().route(
            "/v1/embeddings",
            axum::routing::post(move |axum::Json(body): axum::Json<Json>| {
                let check = check.clone();
                async move {
                    check(&body);
                    let n = body["input"].as_array().unwrap().len();
                    // Return out of order to prove index-sorting.
                    let data: Vec<Json> = (0..n)
                        .rev()
                        .map(|i| json!({"embedding": [i as f64, 1.0], "index": i}))
                        .collect();
                    axum::Json(json!({"data": data, "model": body["model"]}))
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        base
    }

    #[tokio::test]
    async fn voyage_sends_input_type_and_orders_by_index() {
        let base = stub_server(|body| assert_eq!(body["input_type"], json!("query"))).await;
        let em = VoyageEmbedder::new(reqwest::Client::new(), "k".into(), None, Some(base));
        let out = em
            .embed(&["a".into(), "b".into()], EmbedKind::Query)
            .await
            .unwrap();
        assert_eq!(out, vec![vec![0.0, 1.0], vec![1.0, 1.0]]);
        assert!(em.embed(&[], EmbedKind::Document).await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn openai_omits_input_type_and_orders_by_index() {
        let base = stub_server(|body| {
            assert!(body.get("input_type").is_none(), "openai has no input_type");
            assert_eq!(body["model"], json!("text-embedding-3-small"));
        })
        .await;
        let em = OpenAiEmbedder::new(reqwest::Client::new(), "k".into(), None, Some(base));
        let out = em
            .embed(&["a".into(), "b".into(), "c".into()], EmbedKind::Document)
            .await
            .unwrap();
        assert_eq!(out, vec![vec![0.0, 1.0], vec![1.0, 1.0], vec![2.0, 1.0]]);
    }
}
