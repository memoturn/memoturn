//! Per-namespace audit logging (ADR-0010 phase 2, docs/architecture/08).
//!
//! Events are buffered through a non-blocking channel and flushed by a
//! background task as **immutable JSONL objects** in object storage:
//!
//! ```text
//! {root}/_audit/{ns}/{yyyy}/{mm}/{dd}/{flush_ts_ms}-{node_id}-{seq}.jsonl
//! ```
//!
//! One object per flush — object stores cannot append — date-partitioned so
//! range reads and retention deletes are prefix operations, and
//! `{node_id}-{seq}` makes concurrent multi-node writers collision-free with
//! zero coordination. The stream lives *outside* PITR/branching on purpose: a
//! branch rewind must never erase the audit trail. Records carry metadata
//! only — never memory content, never transcript payloads, never tokens.
//!
//! Hot-path budget: one struct build and one `try_send` per audited request.
//! A full channel drops the event and counts it (never blocks a write); a
//! crash loses at most one flush window (`MEMOTURN_AUDIT_FLUSH_MS`).

use object_store::path::Path as ObjPath;
use object_store::{ObjectStore, PutPayload};
use serde::Serialize;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tokio::sync::{mpsc, oneshot};

/// Flush a namespace buffer at this many events even between ticks.
const FLUSH_AT_EVENTS: usize = 512;
/// Bounded emit channel; overflow drops (and counts) rather than blocking.
const CHANNEL_CAP: usize = 8192;

const DAY_MS: i64 = 86_400_000;

/// Who performed an audited action. Built by the auth middleware; never
/// contains the raw bearer token (only a domain-separated hash prefix).
#[derive(Debug, Clone, Serialize)]
pub struct Actor {
    pub kind: ActorKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub token_hash: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scope: Option<crate::auth::Scope>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub claim_db: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub claim_ns: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub iat: Option<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ActorKind {
    /// A verified data-plane JWT.
    Token,
    /// The platform key (control-plane operations).
    Platform,
    /// A node-internal hop (forwarded write) — the edge node already
    /// authenticated and audited the client; memory events are suppressed.
    Internal,
    /// Auth disabled (dev mode).
    Anonymous,
}

impl Actor {
    pub fn internal() -> Self {
        Self {
            kind: ActorKind::Internal,
            token_hash: None,
            scope: None,
            claim_db: None,
            claim_ns: None,
            iat: None,
        }
    }

    pub fn platform() -> Self {
        Self {
            kind: ActorKind::Platform,
            token_hash: None,
            scope: None,
            claim_db: None,
            claim_ns: None,
            iat: None,
        }
    }

    pub fn is_internal(&self) -> bool {
        self.kind == ActorKind::Internal
    }
}

/// What an AI egress event sent where — metadata only, never payload content.
#[derive(Debug, Clone, Serialize)]
pub struct EgressMeta {
    pub provider: String,
    pub model: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub endpoint_host: Option<String>,
    pub self_hosted: bool,
    /// Turns / memories / texts sent.
    pub input_items: usize,
    /// Serialized request-content bytes (a cheap proxy for tokens).
    pub input_bytes: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_items: Option<usize>,
    pub duration_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct AuditEvent {
    pub v: u32,
    /// Time-sortable per node: `evt_{ts_ms}-{seq}`; cross-node merges sort
    /// by `ts` then `id`.
    pub id: String,
    pub ts: i64,
    pub node: String,
    pub ns: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub profile: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    /// `memory.ingest`, `memory.forget`, `ai.extract`, `token.mint`,
    /// `policy.update`, `db.delete`, …
    pub action: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resource: Option<String>,
    /// `ok` | `denied` | `error`.
    pub outcome: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub txid: Option<u64>,
    /// Items affected (ingested / recalled / deleted).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub count: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub actor: Option<Actor>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub egress: Option<EgressMeta>,
    /// Provider/handler error text — never payload content.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

static EVENT_SEQ: AtomicU64 = AtomicU64::new(0);

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

impl AuditEvent {
    pub fn new(action: &str, ns: &str) -> Self {
        let ts = now_ms();
        let seq = EVENT_SEQ.fetch_add(1, Ordering::Relaxed);
        Self {
            v: 1,
            id: format!("evt_{ts:013}-{seq:08x}"),
            ts,
            node: String::new(), // filled by the sink at emit
            ns: ns.to_string(),
            profile: None,
            branch: None,
            action: action.to_string(),
            resource: None,
            outcome: "ok",
            txid: None,
            count: None,
            actor: None,
            egress: None,
            error: None,
        }
    }

    pub fn profile(mut self, profile: &str) -> Self {
        self.profile = Some(profile.to_string());
        self
    }
    pub fn branch(mut self, branch: &str) -> Self {
        self.branch = Some(branch.to_string());
        self
    }
    pub fn resource(mut self, r: impl Into<String>) -> Self {
        self.resource = Some(r.into());
        self
    }
    pub fn outcome(mut self, o: &'static str) -> Self {
        self.outcome = o;
        self
    }
    pub fn txid(mut self, txid: u64) -> Self {
        self.txid = Some(txid);
        self
    }
    pub fn count(mut self, n: u64) -> Self {
        self.count = Some(n);
        self
    }
    pub fn actor(mut self, a: Option<&Actor>) -> Self {
        self.actor = a.cloned();
        self
    }
    pub fn egress(mut self, e: EgressMeta) -> Self {
        self.egress = Some(e);
        self
    }
    pub fn error(mut self, e: impl Into<String>) -> Self {
        self.outcome = "error";
        self.error = Some(e.into());
        self
    }
}

enum Msg {
    Event(AuditEvent),
    /// Flush every buffer now and ack — graceful shutdown and tests.
    Flush(oneshot::Sender<()>),
}

/// The audit sink: non-blocking emit into a background flusher, plus the
/// read/retention side over the same key layout.
pub struct AuditSink {
    tx: Option<mpsc::Sender<Msg>>,
    store: Arc<dyn ObjectStore>,
    root: String,
    node_id: String,
    dropped: AtomicU64,
}

impl AuditSink {
    /// Inert sink over a private in-memory store — tests and tools. Emits
    /// are dropped; reads see an empty stream.
    pub fn noop() -> Arc<Self> {
        Arc::new(Self {
            tx: None,
            store: Arc::new(object_store::memory::InMemory::new()),
            root: "v1".into(),
            node_id: "noop".into(),
            dropped: AtomicU64::new(0),
        })
    }

    /// Spawn the background flusher and return the sink.
    pub fn spawn(
        store: Arc<dyn ObjectStore>,
        root: &str,
        node_id: &str,
        flush_ms: u64,
    ) -> Arc<Self> {
        let (tx, rx) = mpsc::channel(CHANNEL_CAP);
        let sink = Arc::new(Self {
            tx: Some(tx),
            store: store.clone(),
            root: root.trim_matches('/').to_string(),
            node_id: node_id.to_string(),
            dropped: AtomicU64::new(0),
        });
        tokio::spawn(flusher(
            rx,
            store,
            sink.root.clone(),
            node_id.to_string(),
            flush_ms,
        ));
        sink
    }

    /// Non-blocking; a full channel drops the event and counts it. Callers
    /// gate on the namespace policy (`audit.enabled`) before building events.
    pub fn emit(&self, mut evt: AuditEvent) {
        let Some(tx) = &self.tx else { return };
        evt.node = self.node_id.clone();
        if tx.try_send(Msg::Event(evt)).is_err() {
            let n = self.dropped.fetch_add(1, Ordering::Relaxed) + 1;
            if n.is_power_of_two() {
                tracing::warn!(dropped = n, "audit channel full; events dropped");
            }
        }
    }

    pub fn dropped(&self) -> u64 {
        self.dropped.load(Ordering::Relaxed)
    }

    /// Flush all buffered events and wait for the objects to land — graceful
    /// shutdown and tests.
    pub async fn flush_now(&self) {
        let Some(tx) = &self.tx else { return };
        let (ack, done) = oneshot::channel();
        if tx.send(Msg::Flush(ack)).await.is_ok() {
            let _ = done.await;
        }
    }

    /// Page through a namespace's audit stream, oldest first. One LIST of the
    /// namespace prefix yields the keys (date-partitioned paths sort
    /// chronologically); the day filter prunes objects outside the range
    /// before any GET. The cursor is opaque and stable (objects are
    /// immutable). Flush objects are partitioned by their first event's day,
    /// so the day filter keeps one day of slack on each side and the per-event
    /// `ts` filter does the exact cut.
    pub async fn read_range(&self, ns: &str, q: &AuditQuery) -> Result<AuditPage, String> {
        let cursor = q
            .cursor
            .as_deref()
            .map(Cursor::decode)
            .transpose()?
            .unwrap_or_default();
        let from_day = q.from_ms.div_euclid(DAY_MS) - 1;
        let to_day = q.to_ms.div_euclid(DAY_MS) + 1;
        let prefix = ObjPath::from(format!("{}/_audit/{ns}", self.root));
        let mut keys: Vec<ObjPath> = {
            use futures::TryStreamExt;
            self.store
                .list(Some(&prefix))
                .map_ok(|meta| meta.location)
                .try_collect()
                .await
                .map_err(|e| e.to_string())?
        };
        keys.sort();
        let mut events = Vec::new();
        for key in keys {
            match day_of_key(key.as_ref(), &self.root, ns) {
                Some(day) if day >= from_day && day <= to_day => {}
                _ => continue,
            }
            if key.as_ref() < cursor.key.as_str() {
                continue;
            }
            let resumed_here = key.as_ref() == cursor.key;
            let bytes = match self.store.get(&key).await {
                Ok(r) => r.bytes().await.map_err(|e| e.to_string())?,
                Err(object_store::Error::NotFound { .. }) => continue,
                Err(e) => return Err(e.to_string()),
            };
            for (idx, line) in String::from_utf8_lossy(&bytes).lines().enumerate() {
                // `cursor.line` is the next line to read in `cursor.key`.
                if resumed_here && idx < cursor.line {
                    continue;
                }
                let Ok(evt) = serde_json::from_str::<serde_json::Value>(line) else {
                    continue;
                };
                if !matches(&evt, q) {
                    continue;
                }
                if events.len() >= q.limit {
                    return Ok(AuditPage {
                        events,
                        next_cursor: Some(
                            Cursor {
                                key: key.as_ref().to_string(),
                                line: idx, // this line was not returned — resume at it
                            }
                            .encode(),
                        ),
                        complete: false,
                    });
                }
                events.push(evt);
            }
        }
        Ok(AuditPage {
            events,
            next_cursor: None,
            complete: true,
        })
    }

    /// Delete day prefixes older than the namespace's audit retention.
    /// Day granularity: a whole day is deleted only once every event in it
    /// is past the cutoff.
    pub async fn sweep_retention(&self, ns: &str, retention_secs: u64) -> usize {
        let cutoff_day = (now_ms() - (retention_secs as i64) * 1000).div_euclid(DAY_MS);
        let prefix = ObjPath::from(format!("{}/_audit/{ns}", self.root));
        let keys: Vec<ObjPath> = {
            use futures::TryStreamExt;
            match self
                .store
                .list(Some(&prefix))
                .map_ok(|meta| meta.location)
                .try_collect()
                .await
            {
                Ok(k) => k,
                Err(e) => {
                    tracing::warn!(ns, error = %e, "audit retention list failed");
                    return 0;
                }
            }
        };
        let mut deleted = 0;
        for key in keys {
            let Some(day) = day_of_key(key.as_ref(), &self.root, ns) else {
                continue;
            };
            if day < cutoff_day {
                match self.store.delete(&key).await {
                    Ok(()) => deleted += 1,
                    Err(object_store::Error::NotFound { .. }) => {}
                    Err(e) => tracing::warn!(ns, error = %e, "audit retention delete failed"),
                }
            }
        }
        deleted
    }
}

pub struct AuditQuery {
    pub from_ms: i64,
    pub to_ms: i64,
    /// Exact action or prefix (`ai.` matches every egress event).
    pub action: Option<String>,
    pub profile: Option<String>,
    pub outcome: Option<String>,
    pub limit: usize,
    pub cursor: Option<String>,
}

pub struct AuditPage {
    pub events: Vec<serde_json::Value>,
    pub next_cursor: Option<String>,
    pub complete: bool,
}

fn matches(evt: &serde_json::Value, q: &AuditQuery) -> bool {
    let ts = evt["ts"].as_i64().unwrap_or(0);
    if ts < q.from_ms || ts > q.to_ms {
        return false;
    }
    if let Some(a) = &q.action {
        let Some(action) = evt["action"].as_str() else {
            return false;
        };
        if !(action == a || (a.ends_with('.') && action.starts_with(a.as_str()))) {
            return false;
        }
    }
    if let Some(p) = &q.profile {
        if evt["profile"].as_str() != Some(p.as_str()) {
            return false;
        }
    }
    if let Some(o) = &q.outcome {
        if evt["outcome"].as_str() != Some(o.as_str()) {
            return false;
        }
    }
    true
}

#[derive(Default)]
struct Cursor {
    key: String,
    line: usize,
}

impl Cursor {
    fn encode(&self) -> String {
        use base64::Engine as _;
        base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode(format!("{}\n{}", self.key, self.line))
    }

    fn decode(s: &str) -> Result<Self, String> {
        use base64::Engine as _;
        let raw = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .decode(s)
            .map_err(|_| "invalid cursor".to_string())?;
        let raw = String::from_utf8(raw).map_err(|_| "invalid cursor".to_string())?;
        let (key, line) = raw.rsplit_once('\n').ok_or("invalid cursor")?;
        Ok(Self {
            key: key.to_string(),
            line: line.parse().map_err(|_| "invalid cursor".to_string())?,
        })
    }
}

/// `{root}/_audit/{ns}/{yyyy}/{mm}/{dd}/...` → days-since-epoch, or None for
/// keys that don't fit the layout.
fn day_of_key(key: &str, root: &str, ns: &str) -> Option<i64> {
    let rest = key.strip_prefix(&format!("{root}/_audit/{ns}/"))?;
    let mut parts = rest.split('/');
    let y: i64 = parts.next()?.parse().ok()?;
    let m: i64 = parts.next()?.parse().ok()?;
    let d: i64 = parts.next()?.parse().ok()?;
    Some(days_from_civil(y, m, d))
}

/// Civil-date conversions (Howard Hinnant's algorithms) — no chrono dep for
/// two functions.
fn ymd_from_unix_ms(ms: i64) -> (i64, i64, i64) {
    let z = ms.div_euclid(DAY_MS) + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m, d)
}

fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

async fn flusher(
    mut rx: mpsc::Receiver<Msg>,
    store: Arc<dyn ObjectStore>,
    root: String,
    node_id: String,
    flush_ms: u64,
) {
    let mut buffers: HashMap<String, Vec<AuditEvent>> = HashMap::new();
    let mut seq: u64 = 0;
    let mut tick = tokio::time::interval(std::time::Duration::from_millis(flush_ms.max(100)));
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        tokio::select! {
            msg = rx.recv() => match msg {
                Some(Msg::Event(evt)) => {
                    let buf = buffers.entry(evt.ns.clone()).or_default();
                    buf.push(evt);
                    if buf.len() >= FLUSH_AT_EVENTS {
                        let ns = buffers.iter().find(|(_, b)| b.len() >= FLUSH_AT_EVENTS)
                            .map(|(ns, _)| ns.clone());
                        if let Some(ns) = ns {
                            if let Some(events) = buffers.remove(&ns) {
                                flush_ns(&store, &root, &node_id, &mut seq, &ns, events).await;
                            }
                        }
                    }
                }
                Some(Msg::Flush(ack)) => {
                    flush_all(&store, &root, &node_id, &mut seq, &mut buffers).await;
                    let _ = ack.send(());
                }
                // All senders gone: final flush, then exit.
                None => {
                    flush_all(&store, &root, &node_id, &mut seq, &mut buffers).await;
                    return;
                }
            },
            _ = tick.tick() => flush_all(&store, &root, &node_id, &mut seq, &mut buffers).await,
        }
    }
}

async fn flush_all(
    store: &Arc<dyn ObjectStore>,
    root: &str,
    node_id: &str,
    seq: &mut u64,
    buffers: &mut HashMap<String, Vec<AuditEvent>>,
) {
    let namespaces: Vec<String> = buffers.keys().cloned().collect();
    for ns in namespaces {
        if let Some(events) = buffers.remove(&ns) {
            flush_ns(store, root, node_id, seq, &ns, events).await;
        }
    }
}

async fn flush_ns(
    store: &Arc<dyn ObjectStore>,
    root: &str,
    node_id: &str,
    seq: &mut u64,
    ns: &str,
    events: Vec<AuditEvent>,
) {
    if events.is_empty() {
        return;
    }
    let ts = now_ms();
    // Partition by the first event's day — events near midnight may land in
    // the previous day's prefix, which reads tolerate via the ts filter.
    let (y, m, d) = ymd_from_unix_ms(events[0].ts);
    let key = ObjPath::from(format!(
        "{root}/_audit/{ns}/{y:04}/{m:02}/{d:02}/{ts:013}-{node_id}-{seq:06}.jsonl"
    ));
    *seq += 1;
    let mut body = String::with_capacity(events.len() * 256);
    for evt in &events {
        match serde_json::to_string(evt) {
            Ok(line) => {
                body.push_str(&line);
                body.push('\n');
            }
            Err(e) => tracing::warn!(error = %e, "unserializable audit event skipped"),
        }
    }
    if let Err(e) = store
        .put(&key, PutPayload::from(bytes::Bytes::from(body)))
        .await
    {
        tracing::warn!(ns, error = %e, n = events.len(), "audit flush failed; events lost");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sink() -> Arc<AuditSink> {
        AuditSink::spawn(
            Arc::new(object_store::memory::InMemory::new()),
            "v1",
            "node-test",
            60_000, // ticks irrelevant; tests use flush_now
        )
    }

    fn query() -> AuditQuery {
        AuditQuery {
            from_ms: 0,
            to_ms: i64::MAX,
            action: None,
            profile: None,
            outcome: None,
            limit: 100,
            cursor: None,
        }
    }

    #[tokio::test]
    async fn emit_flush_read_roundtrip() {
        let s = sink();
        s.emit(
            AuditEvent::new("memory.ingest", "acme")
                .profile("alice")
                .txid(7)
                .count(2),
        );
        s.emit(
            AuditEvent::new("memory.forget", "acme")
                .profile("alice")
                .resource("mem_x"),
        );
        s.emit(AuditEvent::new("memory.ingest", "globex").profile("bob"));
        s.flush_now().await;

        let page = s.read_range("acme", &query()).await.unwrap();
        assert!(page.complete);
        assert_eq!(page.events.len(), 2);
        assert_eq!(page.events[0]["action"], "memory.ingest");
        assert_eq!(page.events[0]["txid"], 7);
        assert_eq!(page.events[0]["node"], "node-test");
        assert_eq!(page.events[1]["action"], "memory.forget");
        // Streams are per-namespace.
        let other = s.read_range("globex", &query()).await.unwrap();
        assert_eq!(other.events.len(), 1);
    }

    #[tokio::test]
    async fn filters_and_pagination() {
        let s = sink();
        // Flush per event: six single-line objects, so pagination crosses
        // object boundaries (including a page break at line 0 of an object).
        for i in 0..5 {
            s.emit(
                AuditEvent::new("memory.ingest", "acme").profile(if i % 2 == 0 {
                    "alice"
                } else {
                    "bob"
                }),
            );
            s.flush_now().await;
        }
        s.emit(
            AuditEvent::new("ai.extract", "acme")
                .profile("alice")
                .outcome("denied"),
        );
        s.flush_now().await;

        let page = s
            .read_range(
                "acme",
                &AuditQuery {
                    profile: Some("alice".into()),
                    ..query()
                },
            )
            .await
            .unwrap();
        assert_eq!(page.events.len(), 4); // 3 ingests + 1 denied extract

        // Prefix action filter + outcome filter.
        let page = s
            .read_range(
                "acme",
                &AuditQuery {
                    action: Some("ai.".into()),
                    outcome: Some("denied".into()),
                    ..query()
                },
            )
            .await
            .unwrap();
        assert_eq!(page.events.len(), 1);

        // Cursor pagination walks the whole stream without dups or gaps.
        let mut seen = Vec::new();
        let mut cursor = None;
        loop {
            let page = s
                .read_range(
                    "acme",
                    &AuditQuery {
                        limit: 2,
                        cursor: cursor.clone(),
                        ..query()
                    },
                )
                .await
                .unwrap();
            seen.extend(
                page.events
                    .iter()
                    .map(|e| e["id"].as_str().unwrap().to_string()),
            );
            if page.complete {
                break;
            }
            cursor = page.next_cursor;
        }
        assert_eq!(seen.len(), 6);
        let dedup: std::collections::HashSet<_> = seen.iter().collect();
        assert_eq!(dedup.len(), 6, "no duplicates across pages");
    }

    #[tokio::test]
    async fn retention_sweeps_old_days() {
        let s = sink();
        // Fabricate an old object directly in the layout.
        let old = ObjPath::from("v1/_audit/acme/2020/01/05/0000000000000-node-000000.jsonl");
        s.store
            .put(&old, PutPayload::from(bytes::Bytes::from("{}\n")))
            .await
            .unwrap();
        s.emit(AuditEvent::new("memory.ingest", "acme"));
        s.flush_now().await;

        let deleted = s.sweep_retention("acme", 86_400).await;
        assert_eq!(deleted, 1, "only the pre-cutoff day goes");
        let page = s.read_range("acme", &query()).await.unwrap();
        assert_eq!(page.events.len(), 1, "today's events survive");
    }

    #[tokio::test]
    async fn noop_sink_is_inert() {
        let s = AuditSink::noop();
        s.emit(AuditEvent::new("memory.ingest", "acme"));
        s.flush_now().await;
        assert!(s
            .read_range("acme", &query())
            .await
            .unwrap()
            .events
            .is_empty());
    }

    #[test]
    fn civil_date_math() {
        assert_eq!(ymd_from_unix_ms(0), (1970, 1, 1));
        assert_eq!(ymd_from_unix_ms(1_781_207_753_657), (2026, 6, 11));
        for (y, m, d) in [(1970, 1, 1), (2000, 2, 29), (2026, 6, 11), (2100, 12, 31)] {
            let days = days_from_civil(y, m, d);
            assert_eq!(ymd_from_unix_ms(days * DAY_MS), (y, m, d));
        }
        assert_eq!(
            day_of_key(
                "v1/_audit/acme/2026/06/11/0000000000000-n-000000.jsonl",
                "v1",
                "acme"
            ),
            Some(days_from_civil(2026, 6, 11))
        );
    }

    #[test]
    fn events_never_serialize_payload_fields() {
        let evt = AuditEvent::new("memory.ingest", "acme").profile("alice");
        let json = serde_json::to_value(&evt).unwrap();
        for k in ["content", "summary", "turns", "memories", "question"] {
            assert!(
                json.get(k).is_none(),
                "{k} must never exist on audit events"
            );
        }
    }
}
