//! Per-namespace data-governance policies (ADR-0010).
//!
//! A policy never grants anything — it only tightens what the node would
//! otherwise allow, so absent or unknown fields are always safe to ignore.
//! Policies live in object storage (`{root}/_policy/{ns}.json`), the same
//! source of truth as the data they govern, and are read through a small
//! per-node cache.

pub mod policy;
pub mod store;

pub use policy::{
    AiEgressPolicy, AuditPolicy, Effective, EgressRule, ErasurePolicy, MemoryPolicy, Policy,
    PolicyDoc, RetentionPolicy, SCHEMA_VERSION,
};
pub use store::PolicyStore;

#[derive(Debug, thiserror::Error)]
pub enum GovernanceError {
    #[error("invalid policy: {0}")]
    Invalid(String),
    #[error("override loosens namespace policy: {0}")]
    Loosens(String),
    #[error("policy store conflict")]
    CasConflict,
    #[error("policy unavailable: {0}")]
    Unavailable(String),
    #[error("corrupt policy document: {0}")]
    Corrupt(String),
    #[error(transparent)]
    Store(#[from] object_store::Error),
}

pub type Result<T> = std::result::Result<T, GovernanceError>;
