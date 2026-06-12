//! MLOG1: one framed record per group-commit round. The same bytes serve as
//! the local-log entry and the WAL-chunk payload — the commit log *is* the
//! replication stream (docs/architecture/09 § write path).
//!
//! ```text
//! record := len u32 LE            (of everything after this field)
//!           crc32 u32 LE          (of everything after this field)
//!           format u8 = 1
//!           flags u8              bit0: fence (empty round written at takeover)
//!           epoch u64 LE
//!           txid u64 LE
//!           n_requests u16 LE
//!           requests[]:           per-request boundaries preserved
//!             n_ops u16 LE
//!             ops[]: op u8 (0=Put 1=Del) · key_len u16 · key · [val_len u32 · val]
//! ```

use crate::{Op, Result, StrataError, Txid};

pub const FLAG_FENCE: u8 = 0b0000_0001;

#[derive(Debug, Clone, PartialEq)]
pub struct LogRecord {
    pub flags: u8,
    pub epoch: u64,
    pub txid: Txid,
    /// Per-request op vectors — a request's ops enter together or not at all.
    pub requests: Vec<Vec<Op>>,
}

impl LogRecord {
    pub fn fence(epoch: u64, txid: Txid) -> Self {
        Self {
            flags: FLAG_FENCE,
            epoch,
            txid,
            requests: Vec::new(),
        }
    }
}

pub fn encode(rec: &LogRecord) -> Vec<u8> {
    let mut body = Vec::with_capacity(64);
    body.push(1u8); // format
    body.push(rec.flags);
    body.extend_from_slice(&rec.epoch.to_le_bytes());
    body.extend_from_slice(&rec.txid.to_le_bytes());
    body.extend_from_slice(&(rec.requests.len() as u16).to_le_bytes());
    for req in &rec.requests {
        body.extend_from_slice(&(req.len() as u16).to_le_bytes());
        for op in req {
            match op {
                Op::Put { key, value } => {
                    body.push(0u8);
                    body.extend_from_slice(&(key.len() as u16).to_le_bytes());
                    body.extend_from_slice(key);
                    body.extend_from_slice(&(value.len() as u32).to_le_bytes());
                    body.extend_from_slice(value);
                }
                Op::Del { key } => {
                    body.push(1u8);
                    body.extend_from_slice(&(key.len() as u16).to_le_bytes());
                    body.extend_from_slice(key);
                }
            }
        }
    }
    let crc = crc32fast::hash(&body);
    let mut out = Vec::with_capacity(body.len() + 8);
    out.extend_from_slice(&(body.len() as u32).to_le_bytes());
    out.extend_from_slice(&crc.to_le_bytes());
    out.extend_from_slice(&body);
    out
}

struct Cursor<'a> {
    buf: &'a [u8],
    at: usize,
}

impl<'a> Cursor<'a> {
    fn take(&mut self, n: usize) -> Result<&'a [u8]> {
        let end = self
            .at
            .checked_add(n)
            .filter(|&e| e <= self.buf.len())
            .ok_or_else(|| StrataError::Corrupt("log record truncated".into()))?;
        let s = &self.buf[self.at..end];
        self.at = end;
        Ok(s)
    }
    fn u8(&mut self) -> Result<u8> {
        Ok(self.take(1)?[0])
    }
    fn u16(&mut self) -> Result<u16> {
        Ok(u16::from_le_bytes(self.take(2)?.try_into().unwrap()))
    }
    fn u32(&mut self) -> Result<u32> {
        Ok(u32::from_le_bytes(self.take(4)?.try_into().unwrap()))
    }
    fn u64(&mut self) -> Result<u64> {
        Ok(u64::from_le_bytes(self.take(8)?.try_into().unwrap()))
    }
}

fn decode_body(body: &[u8]) -> Result<LogRecord> {
    let mut c = Cursor { buf: body, at: 0 };
    let format = c.u8()?;
    if format != 1 {
        return Err(StrataError::Corrupt(format!(
            "unknown log record format {format}"
        )));
    }
    let flags = c.u8()?;
    let epoch = c.u64()?;
    let txid = c.u64()?;
    let n_req = c.u16()? as usize;
    let mut requests = Vec::with_capacity(n_req);
    for _ in 0..n_req {
        let n_ops = c.u16()? as usize;
        let mut ops = Vec::with_capacity(n_ops);
        for _ in 0..n_ops {
            let kind = c.u8()?;
            let key_len = c.u16()? as usize;
            let key = c.take(key_len)?.to_vec();
            match kind {
                0 => {
                    let val_len = c.u32()? as usize;
                    let value = c.take(val_len)?.to_vec();
                    ops.push(Op::Put { key, value });
                }
                1 => ops.push(Op::Del { key }),
                other => {
                    return Err(StrataError::Corrupt(format!("unknown op kind {other}")));
                }
            }
        }
        requests.push(ops);
    }
    Ok(LogRecord {
        flags,
        epoch,
        txid,
        requests,
    })
}

/// Decode every complete record in `buf`, in order. A truncated or
/// CRC-corrupt tail (torn local-log write) ends the stream without error —
/// the records before it are intact; corruption *mid-stream* is an error.
pub fn decode_stream(buf: &[u8]) -> Result<Vec<LogRecord>> {
    let mut out = Vec::new();
    let mut at = 0usize;
    while at < buf.len() {
        if at + 8 > buf.len() {
            break; // torn frame header at tail
        }
        let len = u32::from_le_bytes(buf[at..at + 4].try_into().unwrap()) as usize;
        let crc = u32::from_le_bytes(buf[at + 4..at + 8].try_into().unwrap());
        let Some(end) = (at + 8).checked_add(len).filter(|&e| e <= buf.len()) else {
            break; // torn body at tail
        };
        let body = &buf[at + 8..end];
        if crc32fast::hash(body) != crc {
            if end == buf.len() {
                break; // torn final record
            }
            return Err(StrataError::Corrupt("log record crc mismatch".into()));
        }
        out.push(decode_body(body)?);
        at = end;
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(txid: u64) -> LogRecord {
        LogRecord {
            flags: 0,
            epoch: 3,
            txid,
            requests: vec![
                vec![
                    Op::Put {
                        key: b"a".to_vec(),
                        value: b"1".to_vec(),
                    },
                    Op::Del { key: b"b".to_vec() },
                ],
                vec![Op::Put {
                    key: b"c".to_vec(),
                    value: vec![],
                }],
            ],
        }
    }

    #[test]
    fn round_trips_a_stream() {
        let mut buf = encode(&sample(1));
        buf.extend(encode(&sample(2)));
        buf.extend(encode(&LogRecord::fence(4, 3)));
        let recs = decode_stream(&buf).unwrap();
        assert_eq!(recs.len(), 3);
        assert_eq!(recs[0], sample(1));
        assert_eq!(recs[2].flags & FLAG_FENCE, FLAG_FENCE);
        assert!(recs[2].requests.is_empty());
    }

    #[test]
    fn torn_tail_is_dropped_not_an_error() {
        let mut buf = encode(&sample(1));
        let whole = encode(&sample(2));
        buf.extend_from_slice(&whole[..whole.len() - 3]);
        let recs = decode_stream(&buf).unwrap();
        assert_eq!(recs.len(), 1);
        assert_eq!(recs[0].txid, 1);
    }

    #[test]
    fn midstream_corruption_is_an_error() {
        let mut buf = encode(&sample(1));
        let flip = buf.len() - 2; // inside record 1's body
        buf[flip] ^= 0xFF;
        buf.extend(encode(&sample(2)));
        assert!(decode_stream(&buf).is_err());
    }
}
