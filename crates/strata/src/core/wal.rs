//! WAL chunks (`.mwal`) and the local recovery log.
//!
//! A chunk is one or more MLOG1 records for one branch, PUT with
//! create-if-absent at a sequence-deterministic key — the conditional create
//! is the durable-mode fence (docs/architecture/09 § fencing). The local log
//! is the same record stream on local disk: the Standard-mode commit point,
//! replayed on same-node restart, truncated at flush. Object storage always
//! wins a conflict — the local log is never authoritative.

use crate::core::logrec::{self, LogRecord};
use crate::core::manifest::{parse_wal_key, wal_chunk_key};
use crate::{Result, StrataError, Txid};
use bytes::Bytes;
use futures::TryStreamExt;
use object_store::path::Path as ObjPath;
use object_store::{ObjectStore, PutPayload};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

const MAGIC: &[u8; 5] = b"MWAL1";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ChunkHeader {
    pub format: u32,
    pub branch: String,
    pub epoch: u64,
    pub seq: u64,
    pub first_txid: Txid,
    pub last_txid: Txid,
}

pub fn encode_chunk(header: &ChunkHeader, records: &[LogRecord]) -> Vec<u8> {
    let header_bytes = postcard::to_allocvec(header).expect("chunk header encode");
    let mut body = Vec::new();
    for r in records {
        body.extend(logrec::encode(r));
    }
    let mut out = Vec::with_capacity(body.len() + header_bytes.len() + 32);
    out.extend_from_slice(MAGIC);
    out.extend_from_slice(&(header_bytes.len() as u32).to_le_bytes());
    out.extend_from_slice(&header_bytes);
    out.extend_from_slice(&crc32fast::hash(&body).to_le_bytes());
    out.extend_from_slice(&(body.len() as u64).to_le_bytes());
    out.extend_from_slice(&body);
    out
}

pub fn decode_chunk(bytes: &[u8]) -> Result<(ChunkHeader, Vec<LogRecord>)> {
    let corrupt = |m: &str| StrataError::Corrupt(format!("wal chunk: {m}"));
    if bytes.len() < 9 || &bytes[..5] != MAGIC {
        return Err(corrupt("bad magic"));
    }
    let hlen = u32::from_le_bytes(bytes[5..9].try_into().unwrap()) as usize;
    let header: ChunkHeader = postcard::from_bytes(
        bytes
            .get(9..9 + hlen)
            .ok_or_else(|| corrupt("header truncated"))?,
    )
    .map_err(|e| corrupt(&format!("header decode: {e}")))?;
    let at = 9 + hlen;
    let crc = u32::from_le_bytes(
        bytes
            .get(at..at + 4)
            .ok_or_else(|| corrupt("crc truncated"))?
            .try_into()
            .unwrap(),
    );
    let body_len = u64::from_le_bytes(
        bytes
            .get(at + 4..at + 12)
            .ok_or_else(|| corrupt("len truncated"))?
            .try_into()
            .unwrap(),
    ) as usize;
    let body = bytes
        .get(at + 12..at + 12 + body_len)
        .ok_or_else(|| corrupt("body truncated"))?;
    if crc32fast::hash(body) != crc {
        return Err(corrupt("body crc mismatch"));
    }
    let records = logrec::decode_stream(body)?;
    Ok((header, records))
}

/// PUT a chunk with create-if-absent at its sequence key. `AlreadyExists`
/// means another writer owns (or owned) that sequence — the caller is fenced
/// or must replay the occupant.
pub async fn put_chunk(
    store: &Arc<dyn ObjectStore>,
    root: &str,
    uuid: &str,
    header: &ChunkHeader,
    records: &[LogRecord],
) -> Result<bool> {
    let key = wal_chunk_key(root, uuid, &header.branch, header.seq, header.first_txid);
    let bytes = encode_chunk(header, records);
    let opts = object_store::PutOptions {
        mode: object_store::PutMode::Create,
        ..Default::default()
    };
    match store
        .put_opts(
            &ObjPath::from(key),
            PutPayload::from(Bytes::from(bytes)),
            opts,
        )
        .await
    {
        Ok(_) => Ok(true),
        Err(object_store::Error::AlreadyExists { .. })
        | Err(object_store::Error::Precondition { .. }) => Ok(false),
        // Local filesystems without conditional-put support fall back to a
        // freshness check: lose the race detection, keep the prototype usable.
        Err(object_store::Error::NotSupported { .. })
        | Err(object_store::Error::NotImplemented) => {
            let key = wal_chunk_key(root, uuid, &header.branch, header.seq, header.first_txid);
            let path = ObjPath::from(key);
            if store.head(&path).await.is_ok() {
                return Ok(false);
            }
            store
                .put(
                    &path,
                    PutPayload::from(Bytes::from(encode_chunk(header, records))),
                )
                .await?;
            Ok(true)
        }
        Err(e) => Err(e.into()),
    }
}

/// List a branch's wal chunks as `(seq, first_txid, object key)`, seq-ascending.
pub async fn list_chunks(
    store: &Arc<dyn ObjectStore>,
    root: &str,
    uuid: &str,
    branch: &str,
) -> Result<Vec<(u64, Txid, String)>> {
    let prefix = ObjPath::from(format!("{root}/{uuid}/wal/{branch}"));
    let keys: Vec<ObjPath> = store
        .list(Some(&prefix))
        .map_ok(|m| m.location)
        .try_collect()
        .await?;
    let mut out: Vec<(u64, Txid, String)> = keys
        .into_iter()
        .filter_map(|k| {
            let key = k.to_string();
            parse_wal_key(&key).map(|(seq, txid)| (seq, txid, key))
        })
        .collect();
    out.sort();
    Ok(out)
}

pub async fn get_chunk(
    store: &Arc<dyn ObjectStore>,
    key: &str,
) -> Result<(ChunkHeader, Vec<LogRecord>)> {
    let bytes = store
        .get(&ObjPath::from(key.to_string()))
        .await?
        .bytes()
        .await?;
    decode_chunk(&bytes)
}

// ---- local recovery log ----

/// Append-only local record log for one open branch. Synchronous I/O behind
/// the writer's round lock — the file is small (truncated at every flush) and
/// the fsync is the Standard-mode commit point.
pub struct LocalLog {
    path: std::path::PathBuf,
    file: std::fs::File,
}

impl LocalLog {
    pub fn open(path: std::path::PathBuf) -> Result<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)?;
        Ok(Self { path, file })
    }

    /// Records currently in the log (replayed on open; torn tails dropped).
    pub fn replay(path: &std::path::Path) -> Result<Vec<LogRecord>> {
        match std::fs::read(path) {
            Ok(bytes) => logrec::decode_stream(&bytes),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
            Err(e) => Err(e.into()),
        }
    }

    pub fn append_fsync(&mut self, record: &LogRecord) -> Result<()> {
        use std::io::Write;
        self.file.write_all(&logrec::encode(record))?;
        self.file.sync_data()?;
        Ok(())
    }

    /// Truncate after a flush — everything in the log is now in a segment.
    pub fn truncate(&mut self) -> Result<()> {
        self.file = std::fs::OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .open(&self.path)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Op;

    fn rec(txid: u64) -> LogRecord {
        LogRecord {
            flags: 0,
            epoch: 1,
            txid,
            requests: vec![vec![Op::Put {
                key: vec![0x40, txid as u8],
                value: b"v".to_vec(),
            }]],
        }
    }

    #[test]
    fn chunk_round_trips() {
        let header = ChunkHeader {
            format: 1,
            branch: "main".into(),
            epoch: 2,
            seq: 4,
            first_txid: 10,
            last_txid: 11,
        };
        let bytes = encode_chunk(&header, &[rec(10), rec(11)]);
        let (h, records) = decode_chunk(&bytes).unwrap();
        assert_eq!(h, header);
        assert_eq!(records.len(), 2);
        assert_eq!(records[1].txid, 11);
    }

    #[test]
    fn local_log_replays_and_truncates() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("branch.log");
        let mut log = LocalLog::open(path.clone()).unwrap();
        log.append_fsync(&rec(1)).unwrap();
        log.append_fsync(&rec(2)).unwrap();
        let replayed = LocalLog::replay(&path).unwrap();
        assert_eq!(replayed.len(), 2);
        log.truncate().unwrap();
        assert!(LocalLog::replay(&path).unwrap().is_empty());
    }
}
