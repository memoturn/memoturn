#!/usr/bin/env bash
set -euo pipefail

# memoturn backup — run on the docker-compose host (dev or prod stack).
#
#   bun run prod:backup            # or: bash scripts/backup.sh
#
# What it backs up, in priority order (see docs/deployment.md):
#   1. The blob bucket (MinIO) — the replayable raw event log, the source of truth:
#      Doris telemetry can be rebuilt from it.
#   2. Postgres — orgs, users, API keys, prompts, datasets, evaluators, config.
#   Doris itself is NOT snapshotted here; recovery is blob replay (or add Doris
#   `BACKUP SNAPSHOT` to an S3 repository if you need faster restores).
#
# Output: $BACKUP_DIR/pg-<UTC>.sql.gz and $BACKUP_DIR/blob-<UTC>/ — the newest
# $BACKUP_KEEP of each are kept, older ones pruned. Ship $BACKUP_DIR somewhere
# off-host (rsync/rclone/object storage) — a backup on the same disk is not a backup.
#
# Env (defaults suit the prod stack):
#   COMPOSE_FILE  compose file to exec into        (default infra/docker-compose.prod.yml)
#   ENV_FILE      env file with the blob creds     (default .env)
#   BACKUP_DIR    where backups land               (default ./backups)
#   BACKUP_KEEP   how many of each kind to keep    (default 7)
#
# Restore:
#   Postgres:  gunzip -c backups/pg-<ts>.sql.gz | docker compose -f $COMPOSE_FILE exec -T postgres psql -U memoturn memoturn
#   Blob:      mc mirror backups/blob-<ts>/ local/<bucket>  (then replay batches through the ingest queue)

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

echo "[backup] postgres → $BACKUP_DIR/pg-$STAMP.sql.gz"
compose exec -T postgres pg_dump -U memoturn memoturn | gzip > "$BACKUP_DIR/pg-$STAMP.sql.gz"

BUCKET="${BLOB_BUCKET:-memoturn}"
echo "[backup] blob bucket '$BUCKET' → $BACKUP_DIR/blob-$STAMP/"
mkdir -p "$ABS_BACKUP_DIR/blob-$STAMP"
compose run --rm --no-deps \
  -v "$ABS_BACKUP_DIR/blob-$STAMP:/backup" \
  --entrypoint /bin/sh minio-setup -c "
    mc alias set local http://minio:9000 '${BLOB_ACCESS_KEY_ID:-memoturn}' '${BLOB_SECRET_ACCESS_KEY:?BLOB_SECRET_ACCESS_KEY must be set}' >/dev/null &&
    mc mirror --overwrite local/$BUCKET /backup
  "

echo "[backup] pruning to the newest $KEEP of each kind"
ls -1t "$BACKUP_DIR"/pg-*.sql.gz 2>/dev/null | tail -n +"$((KEEP + 1))" | xargs -r rm -f --
ls -1dt "$BACKUP_DIR"/blob-* 2>/dev/null | tail -n +"$((KEEP + 1))" | xargs -r rm -rf --

echo "[backup] done:"
ls -lht "$BACKUP_DIR" | head -n $((2 * KEEP + 2))
