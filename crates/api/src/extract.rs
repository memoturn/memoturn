//! Server-side memory extraction (docs/architecture/07, ADR-0009 fast-follow):
//! distill raw conversation turns into typed memories with an LLM, then feed
//! them through the ordinary idempotent ingest path.
//!
//! Control-plane posture: the LLM call happens on its own endpoint *before*
//! any database write — credentials, cost, and latency never enter the write
//! path. Unconfigured nodes simply 503 the endpoint (extraction stays BYO).

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value as Json};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Turn {
    pub role: String,
    pub content: Json,
}

/// What the extractor proposes; the handler turns these into ingest items.
#[derive(Debug, Clone, Deserialize)]
pub struct ExtractedMemory {
    #[serde(rename = "type")]
    pub mtype: String,
    pub topic_key: Option<String>,
    pub summary: String,
    /// Full prose of the memory; stored as `content: {"text": …}`.
    pub details: String,
    pub keywords: String,
}

#[async_trait]
pub trait Extractor: Send + Sync {
    async fn extract(&self, turns: &[Turn]) -> Result<Vec<ExtractedMemory>, String>;
}

const SYSTEM_PROMPT: &str = "You distill conversation transcripts into typed agent memories \
for a memory database. Extract only durable, memorable information.\n\
\n\
Memory types:\n\
- fact: stable knowledge about a person, project, or tool (preferences, identities, \
relationships, goals). Give each fact a stable dot-namespaced topic_key \
(e.g. user.dietary-preference, project.deploy-target) so newer facts supersede older \
ones on the same topic.\n\
- instruction: a reusable procedure or standing directive. Also carries a topic_key.\n\
- event: a completed action anchored to a point in time (decisions, milestones, \
incidents). topic_key must be null.\n\
- task: a short-lived follow-up or open item from this conversation. topic_key must be null.\n\
\n\
For every memory provide: a one-line summary (keyword-searchable), details (the full \
memory as 1-3 sentences of standalone prose), and keywords (space-separated search terms).\n\
\n\
Be selective: small talk, pleasantries, and transient context are not memories. \
An empty list is a correct answer for an unmemorable transcript.";

fn extraction_schema() -> Json {
    json!({
        "type": "object",
        "properties": {
            "memories": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "type": {"type": "string", "enum": ["fact", "event", "instruction", "task"]},
                        "topic_key": {"type": ["string", "null"]},
                        "summary": {"type": "string"},
                        "details": {"type": "string"},
                        "keywords": {"type": "string"}
                    },
                    "required": ["type", "topic_key", "summary", "details", "keywords"],
                    "additionalProperties": false
                }
            }
        },
        "required": ["memories"],
        "additionalProperties": false
    })
}

/// Calls the Claude Messages API over raw HTTP (no official Rust SDK).
/// Structured outputs (`output_config.format`) guarantee the response text is
/// valid JSON matching the extraction schema.
pub struct ClaudeExtractor {
    http: reqwest::Client,
    api_key: String,
    model: String,
    base_url: String,
}

impl ClaudeExtractor {
    pub fn new(http: reqwest::Client, api_key: String, model: Option<String>) -> Self {
        Self {
            http,
            api_key,
            model: model.unwrap_or_else(|| "claude-opus-4-8".to_string()),
            base_url: "https://api.anthropic.com".to_string(),
        }
    }

    #[cfg(test)]
    fn with_base_url(mut self, base_url: String) -> Self {
        self.base_url = base_url;
        self
    }
}

#[async_trait]
impl Extractor for ClaudeExtractor {
    async fn extract(&self, turns: &[Turn]) -> Result<Vec<ExtractedMemory>, String> {
        let transcript = turns
            .iter()
            .map(|t| format!("{}: {}", t.role, t.content))
            .collect::<Vec<_>>()
            .join("\n");
        let body = json!({
            "model": self.model,
            "max_tokens": 16000,
            "thinking": {"type": "adaptive"},
            "system": SYSTEM_PROMPT,
            "messages": [{
                "role": "user",
                "content": format!("Extract memories from this transcript:\n\n{transcript}"),
            }],
            "output_config": {"format": {"type": "json_schema", "schema": extraction_schema()}},
        });
        let resp = self
            .http
            .post(format!("{}/v1/messages", self.base_url))
            .header("x-api-key", &self.api_key)
            .header("anthropic-version", "2023-06-01")
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("extraction request failed: {e}"))?;
        let status = resp.status();
        let payload: Json = resp
            .json()
            .await
            .map_err(|e| format!("extraction response unreadable: {e}"))?;
        if !status.is_success() {
            let msg = payload["error"]["message"]
                .as_str()
                .unwrap_or("unknown error");
            return Err(format!("extraction model error ({status}): {msg}"));
        }
        match payload["stop_reason"].as_str() {
            Some("refusal") => return Err("extraction refused by the model".into()),
            Some("max_tokens") => return Err("extraction output truncated".into()),
            _ => {}
        }
        // With output_config.format the first text block is valid JSON.
        let text = payload["content"]
            .as_array()
            .and_then(|blocks| {
                blocks
                    .iter()
                    .find(|b| b["type"] == "text")
                    .and_then(|b| b["text"].as_str())
            })
            .ok_or("extraction response had no text block")?;
        let parsed: Json =
            serde_json::from_str(text).map_err(|e| format!("extraction JSON invalid: {e}"))?;
        serde_json::from_value::<Vec<ExtractedMemory>>(parsed["memories"].clone())
            .map_err(|e| format!("extraction memories invalid: {e}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn schema_is_strict_everywhere() {
        // Structured outputs require additionalProperties:false on every object.
        fn check(v: &Json) {
            if v["type"] == "object" {
                assert_eq!(v["additionalProperties"], json!(false), "{v}");
            }
            if let Some(props) = v["properties"].as_object() {
                props.values().for_each(check);
            }
            if v["items"].is_object() {
                check(&v["items"]);
            }
        }
        check(&extraction_schema());
    }

    #[tokio::test]
    async fn claude_extractor_parses_structured_response() {
        // Stand-in for the Messages API: one structured-output text block.
        let app = axum::Router::new().route(
            "/v1/messages",
            axum::routing::post(|| async {
                axum::Json(json!({
                    "stop_reason": "end_turn",
                    "content": [{"type": "text", "text": json!({
                        "memories": [{
                            "type": "fact",
                            "topic_key": "user.diet",
                            "summary": "vegetarian since 2024",
                            "details": "The user has been vegetarian since 2024.",
                            "keywords": "diet food preference"
                        }]
                    }).to_string()}]
                }))
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

        let ex = ClaudeExtractor::new(reqwest::Client::new(), "test-key".into(), None)
            .with_base_url(base);
        let turns = vec![Turn {
            role: "user".into(),
            content: json!("I'm vegetarian"),
        }];
        let memories = ex.extract(&turns).await.unwrap();
        assert_eq!(memories.len(), 1);
        assert_eq!(memories[0].mtype, "fact");
        assert_eq!(memories[0].topic_key.as_deref(), Some("user.diet"));
    }
}
