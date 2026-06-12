//! The closed typed-operation set and its staging dispatch. Every write
//! surface compiles to one `WriteRequest`; staging expands it against the
//! current view (committed state + the round overlay) into low-level ops.
//! Expansion replaces SQL triggers, constraints, and savepoints: a request
//! that fails staging is discarded whole, before anything applies.

use crate::core::view::View;
use crate::surface::{docs, kv, memory, transcript};
use crate::{Op, Result};
use serde_json::Value as Json;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Durability {
    #[default]
    Standard,
    /// Escalation only (a request can never lower the node default): ack
    /// after the round's WAL chunk is object-storage-visible.
    Durable,
}

#[derive(Debug, Clone)]
pub enum WriteRequest {
    MemIngest(Vec<memory::MemoryInput>),
    MemForget {
        id: String,
    },
    MemForgetTopic {
        mtype: memory::MemoryType,
        topic: String,
    },
    MemEndSession {
        session: String,
        drop_turns: bool,
    },
    MemSweepExpired,
    MemEnforcePolicy(memory::MemoryRules),
    KvPut {
        ns: String,
        key: String,
        value: Vec<u8>,
        ttl_secs: Option<u64>,
    },
    KvDelete {
        ns: String,
        key: String,
    },
    KvSweep,
    DocInsert {
        collection: String,
        docs: Vec<Json>,
    },
    DocUpdate {
        collection: String,
        filter: Json,
        update: Json,
        multi: bool,
    },
    DocDelete {
        collection: String,
        filter: Json,
        multi: bool,
    },
    DocCreateIndex {
        collection: String,
        path: String,
    },
    TurnAppend {
        session: String,
        role: String,
        content: Json,
        embedding: Option<Vec<f32>>,
    },
}

#[derive(Debug, Clone, PartialEq)]
pub enum WriteOutput {
    MemIngest(Vec<memory::IngestOutcome>),
    /// Ids removed (forget_topic) or created (doc insert).
    Ids(Vec<String>),
    /// Rows affected (forget, sweeps, doc update/delete, end_session).
    Count(u64),
    /// Assigned sequence (turn append).
    Seq(u64),
    None,
}

/// Stage one request against the view. Pure: no state is mutated; the
/// returned ops either enter the round's commit record whole or are dropped
/// with the request's error.
pub fn stage(view: &View<'_>, req: &WriteRequest) -> Result<(Vec<Op>, WriteOutput)> {
    match req {
        WriteRequest::MemIngest(items) => {
            let (ops, outcomes) = memory::stage_ingest(view, items)?;
            Ok((ops, WriteOutput::MemIngest(outcomes)))
        }
        WriteRequest::MemForget { id } => {
            let (ops, n) = memory::stage_forget(view, id)?;
            Ok((ops, WriteOutput::Count(n)))
        }
        WriteRequest::MemForgetTopic { mtype, topic } => {
            let (ops, ids) = memory::stage_forget_topic(view, *mtype, topic)?;
            Ok((ops, WriteOutput::Ids(ids)))
        }
        WriteRequest::MemEndSession {
            session,
            drop_turns,
        } => {
            let (ops, n) = memory::stage_end_session(view, session, *drop_turns)?;
            Ok((ops, WriteOutput::Count(n)))
        }
        WriteRequest::MemSweepExpired => {
            let (ops, n) = memory::stage_sweep_expired(view)?;
            Ok((ops, WriteOutput::Count(n)))
        }
        WriteRequest::MemEnforcePolicy(rules) => {
            let (ops, n) = memory::stage_enforce_policy(view, rules)?;
            Ok((ops, WriteOutput::Count(n)))
        }
        WriteRequest::KvPut {
            ns,
            key,
            value,
            ttl_secs,
        } => Ok((
            kv::stage_put(ns, key, value.clone(), *ttl_secs),
            WriteOutput::None,
        )),
        WriteRequest::KvDelete { ns, key } => Ok((kv::stage_delete(ns, key), WriteOutput::None)),
        WriteRequest::KvSweep => {
            let (ops, n) = kv::stage_sweep(view)?;
            Ok((ops, WriteOutput::Count(n)))
        }
        WriteRequest::DocInsert { collection, docs } => {
            let (ops, ids) = docs::stage_insert(view, collection, docs.clone())?;
            Ok((ops, WriteOutput::Ids(ids)))
        }
        WriteRequest::DocUpdate {
            collection,
            filter,
            update,
            multi,
        } => {
            let (ops, n) = docs::stage_update(view, collection, filter, update, *multi)?;
            Ok((ops, WriteOutput::Count(n)))
        }
        WriteRequest::DocDelete {
            collection,
            filter,
            multi,
        } => {
            let (ops, n) = docs::stage_delete(view, collection, filter, *multi)?;
            Ok((ops, WriteOutput::Count(n)))
        }
        WriteRequest::DocCreateIndex { collection, path } => {
            let ops = docs::stage_create_index(view, collection, path)?;
            Ok((ops, WriteOutput::None))
        }
        WriteRequest::TurnAppend {
            session,
            role,
            content,
            embedding,
        } => {
            let (ops, seq) =
                transcript::stage_append(view, session, role, content, embedding.clone())?;
            Ok((ops, WriteOutput::Seq(seq)))
        }
    }
}
