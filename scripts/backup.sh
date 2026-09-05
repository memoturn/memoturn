#!/usr/bin/env bash
set -euo pipefail

# memoturn backup — run on the docker-compose host (dev or prod stack).
#
#   bun run prod:backup            # or: bash scripts/backup.sh
#
# What it backs up, in priority order (see docs/deployment.md):
#   1. The blob bucket (MinIO) — the replayable raw event log, the source of truth:
#      Doris telemetry can be rebuilt from it (`bun run replay`).
#   2. Postgres — orgs, users, API keys, prompts, datasets, evaluators, config.
#   3. Redis/Valkey — the queues, including the ingest dead-letter queue (which batches
#      failed and need replaying) and per-project rate-limit/lock state.
#   Doris itself is NOT snapshotted here; recovery is blob replay (or add Doris
#   `BACKUP SNAPSHOT` to an S3 repository if you need faster restores).
#
# Output: $BACKUP_DIR/pg-<UTC>.dump (pg_dump custom format — verifiable + selective
# restore), $BACKUP_DIR/redis-<UTC>.rdb, and $BACKUP_DIR/blob-<UTC>/ — the newest
# $BACKUP_KEEP of each are kept, older ones pruned. Every artifact is verified before the
# script exits 0 (dump readable by pg_restore --list, RDB non-empty, blob object count
# matches). Ship $BACKUP_DIR somewhere off-host (rsync/rclone/object storage) — a backup on
# the same disk is not a backup.
#
# RPO = the interval you run this at (cron it hourly for a busy install; the blob mirror is
# incremental). For point-in-time recovery of Postgres, add WAL archiving (pgBackRest or
# wal-g against the pgdata volume) — out of scope here.
#
# Env (defaults suit the prod stack):
#   COMPOSE_FILE  compose file to exec into        (default infra/docker-compose.prod.yml)
#   ENV_FILE      env file with the blob creds     (default .env)
#   BACKUP_DIR    where backups land               (default ./backups)
#   BACKUP_KEEP   how many of each kind to keep    (default 7)
#
# Restore: scripts/restore.sh <timestamp> (see its header) — Postgres from the dump, blob
# from the mirror, Redis from the RDB, then `bun run replay` to rebuild the telemetry store.

COMPOSE_FILE="${COMPOSE_FILE:-infra/docker-compose.prod.yml}"
ENV_FILE="${ENV_FILE:-.env}"
BACKUP_DIR="${BACKUP_DIR:-./backups}"
KEEP="${BACKUP_KEEP:-7}"
STAMP="$(date -u +%Y%m%d-%H%M%S)"

if [ ! -f "$ENV_FILE" ]; then
  echo "error: env file '$ENV_FILE' not found (need the blob credentials)" >&2
  exit 1
fi
# shellcheck disable=SC1090
set -a; . "$ENV_FILE"; set +a

mkdir -p "$BACKUP_DIR"
ABS_BACKUP_DIR="$(cd "$BACKUP_DIR" && pwd)"

compose() { docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" "$@"; }

# ── 1. Postgres (custom format: compressed, verifiable, restorable table-by-table) ────
PG_OUT="$BACKUP_DIR/pg-$STAMP.dump"
echo "[backup] postgres → $PG_OUT"
compose exec -T postgres pg_dump -U memoturn -Fc --no-owner memoturn > "$PG_OUT"
# Verify: the archive must be readable and non-trivial. A truncated dump from a mid-stream
# failure would otherwise be silently kept and pruned into as the "newest good" backup.
if [ ! -s "$PG_OUT" ] || [ "$(stat -f %z "$PG_OUT" 2>/dev/null || stat -c %s "$PG_OUT")" -lt 1024 ]; then
  echo "error: postgres dump is empty or suspiciously small" >&2; exit 1
fi
if ! compose exec -T postgres pg_restore --list < "$PG_OUT" > /dev/null; then
  echo "error: postgres dump failed pg_restore --list verification" >&2; exit 1
fi
PG_TABLES="$(compose exec -T postgres pg_restore --list < "$PG_OUT" | grep -c 'TABLE DATA' || true)"
echo "[backup] postgres dump verified ($PG_TABLES tables with data)"

# ── 2. Redis/Valkey (RDB snapshot — carries the DLQ) ──────────────────────────────
REDIS_OUT="$BACKUP_DIR/redis-$STAMP.rdb"
echo "[backup] redis → $REDIS_OUT"
compose exec -T redis sh -c 'redis-cli BGSAVE >/dev/null; while [ "$(redis-cli LASTSAVE)" = "$(redis-cli LASTSAVE)" ] && redis-cli INFO persistence | grep -q rdb_bgsave_in_progress:1; do sleep 1; done; cat /data/dump.rdb' > "$REDIS_OUT"
if [ ! -s "$REDIS_OUT" ] || ! head -c 5 "$REDIS_OUT" | grep -q '^REDIS'; then
  echo "error: redis RDB snapshot is empty or not an RDB file" >&2; exit 1
fi
echo "[backup] redis snapshot verified ($(du -h "$REDIS_OUT" | cut -f1))"

# ── 3. Blob bucket (the raw event log — the source of truth) ──────────────────────
BUCKET="${BLOB_BUCKET:-memoturn}"
echo "[backup] blob bucket '$BUCKET' → $BACKUP_DIR/blob-$STAMP/"
mkdir -p "$ABS_BACKUP_DIR/blob-$STAMP"
compose run --rm --no-deps \
  -v "$ABS_BACKUP_DIR/blob-$STAMP:/backup" \
  --entrypoint /bin/sh minio-setup -c "
    mc alias set local http://minio:9000 '${BLOB_ACCESS_KEY_ID:-memoturn}' '${BLOB_SECRET_ACCESS_KEY:?BLOB_SECRET_ACCESS_KEY must be set}' >/dev/null &&
    mc mirror --overwrite local/$BUCKET /backup &&
    src=\$(mc ls --recursive local/$BUCKET | wc -l) && dst=\$(find /backup -type f | wc -l) &&
    echo \"[backup] blob objects: bucket=\$src mirror=\$dst\" &&
    [ \"\$src\" -eq \"\$dst\" ] || { echo 'error: blob mirror object count mismatch' >&2; exit 1; }
  "

echo "[backup] pruning to the newest $KEEP of each kind"
ls -1t "$BACKUP_DIR"/pg-*.dump 2>/dev/null | tail -n +"$((KEEP + 1))" | xargs -r rm -f --
ls -1t "$BACKUP_DIR"/pg-*.sql.gz 2>/dev/null | tail -n +"$((KEEP + 1))" | xargs -r rm -f --
ls -1t "$BACKUP_DIR"/redis-*.rdb 2>/dev/null | tail -n +"$((KEEP + 1))" | xargs -r rm -f --
ls -1dt "$BACKUP_DIR"/blob-* 2>/dev/null | tail -n +"$((KEEP + 1))" | xargs -r rm -rf --

echo "[backup] done:"
ls -lht "$BACKUP_DIR" | head -n $((2 * KEEP + 2))
