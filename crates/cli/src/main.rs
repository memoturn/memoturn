//! `memoturn` — CLI for the Memoturn data plane.
//!
//! Targets MEMOTURN_URL (default http://127.0.0.1:8080). `memoturn dev`
//! guidance: run `cargo run -p memoturnd` (or the Docker image) and point
//! the CLI at it.

use anyhow::{bail, Context};
use clap::{Parser, Subcommand};
use serde_json::{json, Value};

#[derive(Parser)]
#[command(
    name = "memoturn",
    about = "Memoturn — the agent-memory database",
    version
)]
struct Cli {
    /// Base URL of a memoturnd node / gateway.
    #[arg(long, env = "MEMOTURN_URL", default_value = "http://127.0.0.1:8080")]
    url: String,
    /// Per-database JWT for data-plane commands.
    #[arg(long, env = "MEMOTURN_TOKEN", global = true)]
    token: Option<String>,
    /// Platform key for control-plane commands (db, token).
    #[arg(long, env = "MEMOTURN_PLATFORM_KEY", global = true)]
    platform_key: Option<String>,
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// Manage databases.
    Db {
        #[command(subcommand)]
        cmd: DbCmd,
    },
    /// Manage branches of a database.
    Branch {
        #[command(subcommand)]
        cmd: BranchCmd,
    },
    /// Run SQL against a database (spec: `name` or `name@branch`).
    Sql {
        spec: String,
        /// SQL text; reads stdin when omitted.
        query: Option<String>,
    },
    /// KV operations.
    Kv {
        #[command(subcommand)]
        cmd: KvCmd,
    },
    /// Typed agent memory: ingest, recall, forget (docs/architecture/07).
    Memory {
        #[command(subcommand)]
        cmd: MemoryCmd,
    },
    /// Ship a database's state to object storage now.
    Sync { spec: String },
    /// Mint per-database tokens (platform key required).
    Token {
        #[command(subcommand)]
        cmd: TokenCmd,
    },
    /// Data-governance policies (ADR-0010): retention/TTL caps and AI egress
    /// rules per namespace, with tighten-only per-profile overrides.
    Policy {
        #[command(subcommand)]
        cmd: PolicyCmd,
    },
    /// Per-namespace audit stream (requires `audit.enabled` in the policy).
    Audit {
        #[command(subcommand)]
        cmd: AuditCmd,
    },
    /// Ask a question answered from a profile's memories (server-side
    /// recall + answer synthesis; needs MEMOTURN_ASSISTANT_API_KEY on the node).
    Ask {
        ns: String,
        profile: String,
        question: Vec<String>,
        /// Memories to recall as context.
        #[arg(long, default_value_t = 8)]
        k: u32,
        #[arg(long)]
        session: Option<String>,
        /// Only consider memories ingested by this agent (e.g. claude-code).
        #[arg(long)]
        source: Option<String>,
        /// Print the full JSON response (answer, sources, memories).
        #[arg(long)]
        json: bool,
    },
}

#[derive(Subcommand)]
enum DbCmd {
    Create { name: String },
    List,
    Delete { name: String },
}

#[derive(Subcommand)]
enum BranchCmd {
    /// Fork a branch (copy-on-write). `--ttl` makes it a burner branch.
    Create {
        db: String,
        name: String,
        #[arg(long)]
        from: Option<String>,
        #[arg(long)]
        ttl: Option<u64>,
    },
    List {
        db: String,
    },
    Delete {
        db: String,
        name: String,
    },
    /// Tag the current state with a checkpoint name.
    Checkpoint {
        db: String,
        branch: String,
        name: String,
    },
    /// Rewind a branch to a checkpoint name or txid.
    Rewind {
        db: String,
        branch: String,
        to: String,
    },
}

#[derive(Subcommand)]
enum TokenCmd {
    Create {
        db: String,
        /// read | write | admin
        #[arg(long, default_value = "write")]
        scope: String,
        /// Seconds until expiry.
        #[arg(long, default_value_t = 3600)]
        ttl: u64,
    },
    /// Mint a namespace token covering every memory profile under it.
    CreateNs {
        ns: String,
        /// read | write | admin
        #[arg(long, default_value = "write")]
        scope: String,
        /// Seconds until expiry.
        #[arg(long, default_value_t = 3600)]
        ttl: u64,
    },
}

#[derive(Subcommand)]
enum PolicyCmd {
    /// Show the namespace policy (platform key), or a profile's override plus
    /// the effective policy actually enforced (read token).
    Get {
        ns: String,
        #[arg(long)]
        profile: Option<String>,
    },
    /// Set the namespace policy (platform key) or a tighten-only profile
    /// override (admin token). Policy JSON from --file or stdin.
    Set {
        ns: String,
        #[arg(long)]
        profile: Option<String>,
        /// Read the policy JSON from this file instead of stdin.
        #[arg(long)]
        file: Option<std::path::PathBuf>,
    },
    /// Clear a profile's override (the namespace policy applies unmodified).
    Clear {
        ns: String,
        #[arg(long)]
        profile: String,
    },
}

#[derive(Subcommand)]
enum AuditCmd {
    /// Export audit events as JSONL to stdout, oldest first, paginating
    /// through the whole range. Uses the platform key, or a namespace admin
    /// token via --token.
    Export {
        ns: String,
        /// Range start: unix ms, or relative like 24h / 7d (ago). Default 24h.
        #[arg(long, default_value = "24h")]
        from: String,
        /// Range end: unix ms, or relative like 1h (ago). Default now.
        #[arg(long)]
        to: Option<String>,
        /// Exact action, or a dot-terminated prefix (e.g. `ai.`).
        #[arg(long)]
        action: Option<String>,
        #[arg(long)]
        profile: Option<String>,
        /// ok | denied | error
        #[arg(long)]
        outcome: Option<String>,
    },
}

/// Unix ms, or a duration-ago like `24h`, `7d`, `30m`.
fn parse_time(s: &str, now_ms: i64) -> anyhow::Result<i64> {
    if let Ok(ms) = s.parse::<i64>() {
        return Ok(ms);
    }
    let (num, unit) = s.split_at(s.len().saturating_sub(1));
    let n: i64 = num
        .parse()
        .context("time must be unix ms or e.g. 24h/7d/30m")?;
    let secs = match unit {
        "m" => n * 60,
        "h" => n * 3600,
        "d" => n * 86_400,
        _ => bail!("time must be unix ms or e.g. 24h/7d/30m"),
    };
    Ok(now_ms - secs * 1000)
}

#[derive(Subcommand)]
enum MemoryCmd {
    /// Store one typed memory (profile auto-creates on first ingest).
    Ingest {
        ns: String,
        profile: String,
        /// fact | event | instruction | task
        #[arg(long, default_value = "fact")]
        r#type: String,
        /// One-line gist (keyword-searchable).
        #[arg(long)]
        summary: String,
        /// Supersession key for fact/instruction (e.g. user.theme).
        #[arg(long)]
        topic: Option<String>,
        /// JSON payload (defaults to {"summary": <summary>}).
        #[arg(long)]
        content: Option<String>,
        /// Extra space-separated search terms.
        #[arg(long)]
        keywords: Option<String>,
        #[arg(long)]
        session: Option<String>,
        /// Originating agent for provenance (e.g. claude-code).
        #[arg(long)]
        source: Option<String>,
        /// Task lifetime in seconds.
        #[arg(long)]
        ttl: Option<u64>,
    },
    /// Hybrid recall (keyword + topic channels; embeddings via the API/SDK).
    Recall {
        ns: String,
        profile: String,
        /// Free-text query.
        query: Option<String>,
        #[arg(long)]
        topic: Option<String>,
        #[arg(long, default_value_t = 8)]
        k: u32,
        /// fact | event | instruction | task (repeatable).
        #[arg(long = "type")]
        types: Vec<String>,
        /// Only memories ingested by this agent (e.g. claude-code).
        #[arg(long)]
        source: Option<String>,
        #[arg(long)]
        include_superseded: bool,
    },
    /// Distill raw turns (JSON array on stdin) into typed memories via the
    /// node's server-side extractor, then ingest them.
    Extract {
        ns: String,
        profile: String,
        #[arg(long)]
        session: Option<String>,
        /// Originating agent for provenance (e.g. claude-code).
        #[arg(long)]
        source: Option<String>,
        /// Propose without ingesting.
        #[arg(long)]
        dry_run: bool,
    },
    /// Fetch one memory with its supersession chain.
    Get {
        ns: String,
        profile: String,
        id: String,
    },
    /// Permanently delete one memory.
    Forget {
        ns: String,
        profile: String,
        id: String,
    },
    /// Verifiably erase: hard-forget now (secure_delete), then a bounded-time
    /// history rewrite with a signed receipt (ADR-0010 phase 3).
    Erase {
        ns: String,
        profile: String,
        /// Erase one memory by id.
        #[arg(long)]
        memory: Option<String>,
        /// Erase a topic's whole supersession chain (requires --type).
        #[arg(long)]
        topic: Option<String>,
        /// fact | instruction (with --topic).
        #[arg(long = "type")]
        mtype: Option<String>,
        /// Erase a session's task memories.
        #[arg(long)]
        session: Option<String>,
        /// With --session: also drop the verbatim transcript.
        #[arg(long)]
        turns: bool,
    },
    /// List erasure coupons, or show one (including its signed receipt).
    Erasures {
        ns: String,
        profile: String,
        id: Option<String>,
    },
    /// List a profile's sessions.
    Sessions { ns: String, profile: String },
    /// List profiles under a namespace (namespace token required).
    Profiles { ns: String },
}

#[derive(Subcommand)]
enum KvCmd {
    Get {
        spec: String,
        ns: String,
        key: String,
    },
    Put {
        spec: String,
        ns: String,
        key: String,
        value: String,
        #[arg(long)]
        ttl: Option<u64>,
    },
    Delete {
        spec: String,
        ns: String,
        key: String,
    },
    List {
        spec: String,
        ns: String,
        #[arg(long, default_value = "")]
        prefix: String,
    },
}

async fn show(resp: reqwest::Response) -> anyhow::Result<()> {
    let status = resp.status();
    let txid = resp
        .headers()
        .get("Memoturn-Txid")
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);
    let text = resp.text().await?;
    if !status.is_success() {
        bail!("{status}: {text}");
    }
    match serde_json::from_str::<Value>(&text) {
        Ok(v) => println!("{}", serde_json::to_string_pretty(&v)?),
        Err(_) => println!("{text}"),
    }
    if let Some(t) = txid {
        eprintln!("txid: {t}");
    }
    Ok(())
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let cli = Cli::parse();
    // Control-plane commands authenticate with the platform key; data-plane
    // commands with the per-database token. Either falls back to the other.
    // Namespace-level policy is control-plane; profile-level rides the token.
    let is_platform = match &cli.cmd {
        Cmd::Db { .. } | Cmd::Token { .. } | Cmd::Audit { .. } => true,
        Cmd::Policy { cmd } => match cmd {
            PolicyCmd::Get { profile, .. } | PolicyCmd::Set { profile, .. } => profile.is_none(),
            PolicyCmd::Clear { .. } => false,
        },
        _ => false,
    };
    let cred = if is_platform {
        cli.platform_key.clone().or_else(|| cli.token.clone())
    } else {
        cli.token.clone().or_else(|| cli.platform_key.clone())
    };
    let mut headers = reqwest::header::HeaderMap::new();
    if let Some(t) = cred {
        headers.insert(
            reqwest::header::AUTHORIZATION,
            format!("Bearer {t}")
                .parse()
                .context("invalid credential")?,
        );
    }
    let c = reqwest::Client::builder()
        .default_headers(headers)
        .build()?;
    let base = cli.url.trim_end_matches('/');

    match cli.cmd {
        Cmd::Db { cmd } => match cmd {
            DbCmd::Create { name } => {
                show(
                    c.post(format!("{base}/v1/databases"))
                        .json(&json!({"name": name}))
                        .send()
                        .await?,
                )
                .await
            }
            DbCmd::List => show(c.get(format!("{base}/v1/databases")).send().await?).await,
            DbCmd::Delete { name } => {
                show(
                    c.delete(format!("{base}/v1/databases/{name}"))
                        .send()
                        .await?,
                )
                .await
            }
        },
        Cmd::Branch { cmd } => match cmd {
            BranchCmd::Create {
                db,
                name,
                from,
                ttl,
            } => {
                let mut body = json!({"name": name});
                if let Some(f) = from {
                    body["from"] = json!(f);
                }
                if let Some(t) = ttl {
                    body["ttl"] = json!(t);
                }
                show(
                    c.post(format!("{base}/v1/db/{db}/branches"))
                        .json(&body)
                        .send()
                        .await?,
                )
                .await
            }
            BranchCmd::List { db } => {
                show(c.get(format!("{base}/v1/db/{db}/branches")).send().await?).await
            }
            BranchCmd::Delete { db, name } => {
                show(
                    c.delete(format!("{base}/v1/db/{db}/branches/{name}"))
                        .send()
                        .await?,
                )
                .await
            }
            BranchCmd::Checkpoint { db, branch, name } => {
                show(
                    c.post(format!("{base}/v1/db/{db}/branches/{branch}/checkpoint"))
                        .json(&json!({"name": name}))
                        .send()
                        .await?,
                )
                .await
            }
            BranchCmd::Rewind { db, branch, to } => {
                show(
                    c.post(format!("{base}/v1/db/{db}/branches/{branch}/rewind"))
                        .json(&json!({"to": to}))
                        .send()
                        .await?,
                )
                .await
            }
        },
        Cmd::Sql { spec, query } => {
            let q = match query {
                Some(q) => q,
                None => std::io::read_to_string(std::io::stdin()).context("reading stdin")?,
            };
            let stmts: Vec<Value> = q
                .split(';')
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(|s| json!({"q": s}))
                .collect();
            show(
                c.post(format!("{base}/v1/db/{spec}/sql"))
                    .json(&json!({ "stmts": stmts }))
                    .send()
                    .await?,
            )
            .await
        }
        Cmd::Kv { cmd } => match cmd {
            KvCmd::Get { spec, ns, key } => {
                show(
                    c.get(format!("{base}/v1/db/{spec}/kv/{ns}/{key}"))
                        .send()
                        .await?,
                )
                .await
            }
            KvCmd::Put {
                spec,
                ns,
                key,
                value,
                ttl,
            } => {
                let qs = ttl.map(|t| format!("?ttl={t}")).unwrap_or_default();
                show(
                    c.put(format!("{base}/v1/db/{spec}/kv/{ns}/{key}{qs}"))
                        .body(value)
                        .send()
                        .await?,
                )
                .await
            }
            KvCmd::Delete { spec, ns, key } => {
                show(
                    c.delete(format!("{base}/v1/db/{spec}/kv/{ns}/{key}"))
                        .send()
                        .await?,
                )
                .await
            }
            KvCmd::List { spec, ns, prefix } => {
                show(
                    c.get(format!("{base}/v1/db/{spec}/kv/{ns}?prefix={prefix}"))
                        .send()
                        .await?,
                )
                .await
            }
        },
        Cmd::Policy { cmd } => match cmd {
            PolicyCmd::Get { ns, profile } => {
                let url = match profile {
                    Some(p) => format!("{base}/v1/memory/{ns}/{p}/policy"),
                    None => format!("{base}/v1/namespaces/{ns}/policy"),
                };
                show(c.get(url).send().await?).await
            }
            PolicyCmd::Set { ns, profile, file } => {
                let text = match file {
                    Some(f) => std::fs::read_to_string(&f)
                        .with_context(|| format!("reading {}", f.display()))?,
                    None => std::io::read_to_string(std::io::stdin()).context("reading stdin")?,
                };
                let policy: Value =
                    serde_json::from_str(&text).context("policy must be a JSON object")?;
                let url = match profile {
                    Some(p) => format!("{base}/v1/memory/{ns}/{p}/policy"),
                    None => format!("{base}/v1/namespaces/{ns}/policy"),
                };
                show(c.put(url).json(&json!({ "policy": policy })).send().await?).await
            }
            PolicyCmd::Clear { ns, profile } => {
                show(
                    c.put(format!("{base}/v1/memory/{ns}/{profile}/policy"))
                        .json(&json!({ "policy": null }))
                        .send()
                        .await?,
                )
                .await
            }
        },
        Cmd::Audit { cmd } => match cmd {
            AuditCmd::Export {
                ns,
                from,
                to,
                action,
                profile,
                outcome,
            } => {
                let now = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_millis() as i64)
                    .unwrap_or(0);
                let from = parse_time(&from, now)?;
                let to = to.as_deref().map(|t| parse_time(t, now)).transpose()?;
                let mut cursor: Option<String> = None;
                let mut total = 0u64;
                loop {
                    let mut url = format!("{base}/v1/namespaces/{ns}/audit?from={from}&limit=500");
                    if let Some(t) = to {
                        url.push_str(&format!("&to={t}"));
                    }
                    for (k, v) in [
                        ("action", &action),
                        ("profile", &profile),
                        ("outcome", &outcome),
                    ] {
                        if let Some(v) = v {
                            url.push_str(&format!("&{k}={v}"));
                        }
                    }
                    if let Some(c) = &cursor {
                        url.push_str(&format!("&cursor={c}"));
                    }
                    let resp = c.get(&url).send().await?;
                    let status = resp.status();
                    let body: Value = resp.json().await?;
                    if !status.is_success() {
                        bail!("{status}: {body}");
                    }
                    for evt in body["events"].as_array().into_iter().flatten() {
                        println!("{evt}");
                        total += 1;
                    }
                    if body["complete"].as_bool().unwrap_or(true) {
                        break;
                    }
                    cursor = body["next_cursor"].as_str().map(str::to_string);
                    if cursor.is_none() {
                        break;
                    }
                }
                eprintln!("{total} events");
                Ok(())
            }
        },
        Cmd::Memory { cmd } => match cmd {
            MemoryCmd::Ingest {
                ns,
                profile,
                r#type,
                summary,
                topic,
                content,
                keywords,
                session,
                source,
                ttl,
            } => {
                let content: Value = match content {
                    Some(c) => serde_json::from_str(&c).context("--content must be JSON")?,
                    None => json!({"summary": summary}),
                };
                let mut m = json!({"type": r#type, "summary": summary, "content": content});
                if let Some(t) = topic {
                    m["topic_key"] = json!(t);
                }
                if let Some(k) = keywords {
                    m["keywords"] = json!(k);
                }
                if let Some(s) = session {
                    m["session_id"] = json!(s);
                }
                if let Some(s) = source {
                    m["source"] = json!(s);
                }
                if let Some(t) = ttl {
                    m["ttl"] = json!(t);
                }
                show(
                    c.post(format!("{base}/v1/memory/{ns}/{profile}/memories"))
                        .json(&json!({"memories": [m]}))
                        .send()
                        .await?,
                )
                .await
            }
            MemoryCmd::Recall {
                ns,
                profile,
                query,
                topic,
                k,
                types,
                source,
                include_superseded,
            } => {
                let mut body = json!({"k": k, "include_superseded": include_superseded});
                if let Some(q) = query {
                    body["query"] = json!(q);
                }
                if let Some(t) = topic {
                    body["topic_key"] = json!(t);
                }
                if !types.is_empty() {
                    body["types"] = json!(types);
                }
                if let Some(s) = source {
                    body["source"] = json!(s);
                }
                show(
                    c.post(format!("{base}/v1/memory/{ns}/{profile}/recall"))
                        .json(&body)
                        .send()
                        .await?,
                )
                .await
            }
            MemoryCmd::Extract {
                ns,
                profile,
                session,
                source,
                dry_run,
            } => {
                let stdin = std::io::read_to_string(std::io::stdin()).context("reading stdin")?;
                let turns: Value =
                    serde_json::from_str(&stdin).context("stdin must be a JSON array of turns")?;
                let mut body = json!({"turns": turns, "dry_run": dry_run});
                if let Some(s) = session {
                    body["session_id"] = json!(s);
                }
                if let Some(s) = source {
                    body["source"] = json!(s);
                }
                show(
                    c.post(format!("{base}/v1/memory/{ns}/{profile}/extract"))
                        .json(&body)
                        .send()
                        .await?,
                )
                .await
            }
            MemoryCmd::Get { ns, profile, id } => {
                show(
                    c.get(format!("{base}/v1/memory/{ns}/{profile}/memories/{id}"))
                        .send()
                        .await?,
                )
                .await
            }
            MemoryCmd::Forget { ns, profile, id } => {
                show(
                    c.delete(format!("{base}/v1/memory/{ns}/{profile}/memories/{id}"))
                        .send()
                        .await?,
                )
                .await
            }
            MemoryCmd::Erase {
                ns,
                profile,
                memory,
                topic,
                mtype,
                session,
                turns,
            } => {
                let mut body = serde_json::Map::new();
                if let Some(m) = memory {
                    body.insert("memory_id".into(), json!(m));
                }
                if let Some(t) = topic {
                    body.insert("topic_key".into(), json!(t));
                }
                if let Some(t) = mtype {
                    body.insert("type".into(), json!(t));
                }
                if let Some(s) = session {
                    body.insert("session_id".into(), json!(s));
                }
                if turns {
                    body.insert("turns".into(), json!(true));
                }
                show(
                    c.post(format!("{base}/v1/memory/{ns}/{profile}/erasures"))
                        .json(&Value::Object(body))
                        .send()
                        .await?,
                )
                .await
            }
            MemoryCmd::Erasures { ns, profile, id } => {
                let url = match id {
                    Some(id) => format!("{base}/v1/memory/{ns}/{profile}/erasures/{id}"),
                    None => format!("{base}/v1/memory/{ns}/{profile}/erasures"),
                };
                show(c.get(url).send().await?).await
            }
            MemoryCmd::Sessions { ns, profile } => {
                show(
                    c.get(format!("{base}/v1/memory/{ns}/{profile}/sessions"))
                        .send()
                        .await?,
                )
                .await
            }
            MemoryCmd::Profiles { ns } => {
                show(c.get(format!("{base}/v1/memory/{ns}")).send().await?).await
            }
        },
        Cmd::Sync { spec } => show(c.post(format!("{base}/v1/db/{spec}/sync")).send().await?).await,
        Cmd::Token { cmd } => match cmd {
            TokenCmd::Create { db, scope, ttl } => {
                show(
                    c.post(format!("{base}/v1/databases/{db}/tokens"))
                        .json(&json!({"scope": scope, "expires_in": ttl}))
                        .send()
                        .await?,
                )
                .await
            }
            TokenCmd::CreateNs { ns, scope, ttl } => {
                show(
                    c.post(format!("{base}/v1/namespaces/{ns}/tokens"))
                        .json(&json!({"scope": scope, "expires_in": ttl}))
                        .send()
                        .await?,
                )
                .await
            }
        },
        Cmd::Ask {
            ns,
            profile,
            question,
            k,
            session,
            source,
            json: raw,
        } => {
            let question = question.join(" ");
            if question.trim().is_empty() {
                bail!("usage: memoturn ask <ns> <profile> <question…>");
            }
            let mut body = json!({"question": question, "k": k});
            if let Some(s) = session {
                body["session_id"] = json!(s);
            }
            if let Some(s) = source {
                body["source"] = json!(s);
            }
            let resp = c
                .post(format!("{base}/v1/memory/{ns}/{profile}/ask"))
                .json(&body)
                .send()
                .await?;
            if raw {
                return show(resp).await;
            }
            let status = resp.status();
            let text = resp.text().await?;
            if !status.is_success() {
                bail!("{status}: {text}");
            }
            let v: Value = serde_json::from_str(&text).context("response was not JSON")?;
            match v["answer"].as_str() {
                Some(answer) => {
                    println!("{answer}");
                    if let Some(sources) = v["sources"].as_array() {
                        if !sources.is_empty() {
                            let ids: Vec<&str> =
                                sources.iter().filter_map(|s| s.as_str()).collect();
                            eprintln!("sources: {}", ids.join(", "));
                        }
                    }
                }
                None => println!("(no matching memories)"),
            }
            Ok(())
        }
    }
}
