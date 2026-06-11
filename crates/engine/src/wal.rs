//! SQLite WAL frame capture — the page-delta source for segment replication.
//!
//! We read committed frames directly from the `-wal` file (the proven
//! sidecar-replication approach): the engine disables auto-checkpointing, so
//! the WAL only resets when we checkpoint it ourselves. A cursor tracks the
//! consumed offset and the WAL salts; if the salts ever change underneath us
//! (an unexpected reset), capture reports `CursorLost` and the shipper falls
//! back to a full snapshot — correctness never depends on the cursor.
//!
//! Frame checksums are not verified (we are the only writer and read behind
//! the committed boundary); salts + commit-frame detection bound torn tails.

use std::collections::BTreeMap;
use std::path::Path;

const WAL_HEADER: usize = 32;
const FRAME_HEADER: usize = 24;

#[derive(Debug, Clone)]
pub struct WalCursor {
    offset: usize,
    salt1: u32,
    salt2: u32,
    pub page_size: u32,
}

/// Committed page images since the last capture, deduplicated to the latest
/// version of each page.
#[derive(Debug, Default)]
pub struct WalCapture {
    pub pages: BTreeMap<u32, Vec<u8>>,
    /// Database size in pages at the last commit frame.
    pub db_size_pages: u32,
    pub page_size: u32,
}

pub enum CaptureOutcome {
    /// New committed frames (possibly none) since the cursor.
    Captured(WalCapture),
    /// WAL was reset/restarted underneath the cursor — caller must fall back
    /// to a full snapshot and reset the cursor.
    CursorLost,
}

fn be32(b: &[u8], at: usize) -> u32 {
    u32::from_be_bytes([b[at], b[at + 1], b[at + 2], b[at + 3]])
}

fn read_wal(path: &Path) -> std::io::Result<Option<Vec<u8>>> {
    match std::fs::read(path) {
        Ok(b) if b.len() >= WAL_HEADER => Ok(Some(b)),
        Ok(_) => Ok(None), // empty or truncated header: nothing committed
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e),
    }
}

/// Walk frames from `start`, collecting only pages sealed by a commit frame.
/// Returns (capture, offset just past the last commit frame).
fn walk(
    bytes: &[u8],
    start: usize,
    salt1: u32,
    salt2: u32,
    page_size: usize,
) -> (WalCapture, usize) {
    let mut capture = WalCapture {
        page_size: page_size as u32,
        ..Default::default()
    };
    let mut pending: Vec<(u32, Vec<u8>)> = Vec::new();
    let mut offset = start;
    let mut consumed = start;
    let frame = FRAME_HEADER + page_size;
    while bytes.len() >= offset + frame {
        let pgno = be32(bytes, offset);
        let db_size = be32(bytes, offset + 4);
        let fsalt1 = be32(bytes, offset + 8);
        let fsalt2 = be32(bytes, offset + 12);
        if fsalt1 != salt1 || fsalt2 != salt2 || pgno == 0 {
            break; // stale frames from a previous WAL generation
        }
        let img = bytes[offset + FRAME_HEADER..offset + frame].to_vec();
        pending.push((pgno, img));
        offset += frame;
        if db_size != 0 {
            // Commit frame: everything pending is durable.
            for (p, img) in pending.drain(..) {
                capture.pages.insert(p, img);
            }
            capture.db_size_pages = db_size;
            consumed = offset;
        }
    }
    (capture, consumed)
}

impl WalCursor {
    /// Capture committed frames past the cursor, advancing it. A `None`
    /// cursor initializes from the current WAL header.
    pub fn capture(
        cursor: &mut Option<WalCursor>,
        wal_path: &Path,
    ) -> std::io::Result<CaptureOutcome> {
        let Some(bytes) = read_wal(wal_path)? else {
            // No WAL content. A positioned cursor stays valid (nothing new);
            // an uninitialized one stays uninitialized.
            return Ok(CaptureOutcome::Captured(WalCapture::default()));
        };
        let salt1 = be32(&bytes, 16);
        let salt2 = be32(&bytes, 20);
        let page_size = be32(&bytes, 8);
        match cursor {
            Some(c) if c.salt1 != salt1 || c.salt2 != salt2 => Ok(CaptureOutcome::CursorLost),
            Some(c) => {
                let (capture, consumed) =
                    walk(&bytes, c.offset, salt1, salt2, c.page_size as usize);
                c.offset = consumed;
                Ok(CaptureOutcome::Captured(capture))
            }
            None => {
                let (capture, consumed) =
                    walk(&bytes, WAL_HEADER, salt1, salt2, page_size as usize);
                *cursor = Some(WalCursor {
                    offset: consumed,
                    salt1,
                    salt2,
                    page_size,
                });
                Ok(CaptureOutcome::Captured(capture))
            }
        }
    }

    /// Position the cursor at the current committed end of the WAL without
    /// keeping pages — used right after a full snapshot so the next segment
    /// only carries frames newer than the snapshot.
    pub fn skip_to_end(cursor: &mut Option<WalCursor>, wal_path: &Path) -> std::io::Result<()> {
        let Some(bytes) = read_wal(wal_path)? else {
            *cursor = None;
            return Ok(());
        };
        let salt1 = be32(&bytes, 16);
        let salt2 = be32(&bytes, 20);
        let page_size = be32(&bytes, 8);
        let start = match cursor {
            Some(c) if c.salt1 == salt1 && c.salt2 == salt2 => c.offset,
            _ => WAL_HEADER,
        };
        let (_, consumed) = walk(&bytes, start, salt1, salt2, page_size as usize);
        *cursor = Some(WalCursor {
            offset: consumed,
            salt1,
            salt2,
            page_size,
        });
        Ok(())
    }
}
