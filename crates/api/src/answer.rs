//! Recall answer synthesis (docs/architecture/06, ADR-0009 deferred item):
//! turn the memories hybrid recall surfaces into a grounded prose answer.
//!
//! Control-plane posture like extraction: the LLM call happens on its own
//! read-only endpoint, never in the write path. The synthesizer sees only the
//! memories recall already returned to the caller's scope — it grants no new
//! data access. Unconfigured nodes 503 the endpoint (synthesis stays BYO).

use async_trait::async_trait;
use serde::Deserialize;
use serde_json::{json, Value as Json};

/// A synthesized answer plus the ids of the memories that support it.
#[derive(Debug, Clone, Deserialize)]
pub struct SynthesizedAnswer {
    pub answer: String,
    /// Ids (mem_…) of the recalled memories the answer rests on. Empty when
    /// the memories did not contain an answer.
    pub sources: Vec<String>,
}

#[async_trait]
pub trait Answerer: Send + Sync {
    async fn answer(&self, question: &str, memories: &[Json]) -> Result<SynthesizedAnswer, String>;
}

const SYSTEM_PROMPT: &str = "You answer questions about an agent's stored memories. You are \
given the memories a recall query surfaced (newest knowledge wins: a memory listed as \
superseded is outdated) and a question.\n\
\n\
Answer in 1-3 sentences of plain prose, using ONLY the provided memories. Cite the id of \
every memory your answer rests on in `sources`. If the memories do not contain the answer, \
say so plainly and return an empty `sources` list — never guess or pad.";

fn answer_schema() -> Json {
    json!({
        "type": "object",
        "properties": {
            "answer": {"type": "string"},
            "sources": {"type": "array", "items": {"type": "string"}}
        },
        "required": ["answer", "sources"],
        "additionalProperties": false
    })
}

/// Calls the Claude Messages API over raw HTTP (no official Rust SDK).
/// Structured outputs (`output_config.format`) guarantee the response text is
/// valid JSON matching the answer schema.
pub struct ClaudeAnswerer {
    http: reqwest::Client,
    api_key: String,
    model: String,
    base_url: String,
}

impl ClaudeAnswerer {
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
impl Answerer for ClaudeAnswerer {
    async fn answer(&self, question: &str, memories: &[Json]) -> Result<SynthesizedAnswer, String> {
        // Compact context: the fields that matter for grounding, one memory
        // per line, recall order preserved (highest-ranked first).
        let context = memories
            .iter()
            .map(|m| {
                json!({
                    "id": m["id"],
                    "type": m["type"],
                    "topic_key": m["topic_key"],
                    "summary": m["summary"],
                    "content": m["content"],
                    "source": m["source"],
                    "created_at": m["created_at"],
                    "superseded": !m["superseded_by"].is_null(),
                })
                .to_string()
            })
            .collect::<Vec<_>>()
            .join("\n");
        let body = json!({
            "model": self.model,
            "max_tokens": 2000,
            "system": SYSTEM_PROMPT,
            "messages": [{
                "role": "user",
                "content": format!("Memories (recall-ranked):\n{context}\n\nQuestion: {question}"),
            }],
            "output_config": {"format": {"type": "json_schema", "schema": answer_schema()}},
        });
        let resp = self
            .http
            .post(format!("{}/v1/messages", self.base_url))
            .header("x-api-key", &self.api_key)
            .header("anthropic-version", "2023-06-01")
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("answer request failed: {e}"))?;
        let status = resp.status();
        let payload: Json = resp
            .json()
            .await
            .map_err(|e| format!("answer response unreadable: {e}"))?;
        if !status.is_success() {
            let msg = payload["error"]["message"]
                .as_str()
                .unwrap_or("unknown error");
            return Err(format!("answer model error ({status}): {msg}"));
        }
        match payload["stop_reason"].as_str() {
            Some("refusal") => return Err("answer refused by the model".into()),
            Some("max_tokens") => return Err("answer output truncated".into()),
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
            .ok_or("answer response had no text block")?;
        serde_json::from_str::<SynthesizedAnswer>(text)
            .map_err(|e| format!("answer JSON invalid: {e}"))
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
        check(&answer_schema());
    }

    #[tokio::test]
    async fn claude_answerer_parses_structured_response() {
        // Stand-in for the Messages API: one structured-output text block.
        let app = axum::Router::new().route(
            "/v1/messages",
            axum::routing::post(|| async {
                axum::Json(json!({
                    "stop_reason": "end_turn",
                    "content": [{"type": "text", "text": json!({
                        "answer": "The user is vegetarian.",
                        "sources": ["mem_1"]
                    }).to_string()}]
                }))
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

        let a = ClaudeAnswerer::new(reqwest::Client::new(), "test-key".into(), None)
            .with_base_url(base);
        let memories = vec![json!({
            "id": "mem_1", "type": "fact", "topic_key": "user.diet",
            "summary": "vegetarian since 2024", "content": {"text": "…"},
            "created_at": 1, "superseded_by": null
        })];
        let out = a
            .answer("what does the user eat?", &memories)
            .await
            .unwrap();
        assert_eq!(out.answer, "The user is vegetarian.");
        assert_eq!(out.sources, vec!["mem_1"]);
    }
}
