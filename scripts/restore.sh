#!/usr/bin/env bash
set -euo pipefail

# memoturn restore — the counterpart of scripts/backup.sh, run on the docker-compose host.
#
#   bash scripts/restore.sh <timestamp>            # e.g. 20260905-020000 (from the backup file names)
#   bash scripts/restore.sh <timestamp> --no-replay   # skip the telemetry rebuild
#
# Order (each step is idempotent; re-run the script if one fails):
#   1. Stop the api + worker so nothing writes during the restore.
#   2. Postgres: drop + recreate the database from pg-<ts>.dump (pg_restore --clean).
#   3. Redis: replace the RDB (queues + DLQ) and restart Valkey.
#   4. Blob: mirror blob-<ts>/ back into the bucket.
#   5. Telemetry: start the worker and replay every raw batch from blob through the ingest
#      queue (`bun run replay -- --all`) — this is how Doris / the Postgres tier is rebuilt;
#      neither is snapshotted (LWW makes it safe to replay on top of surviving rows).
#   6. Start the api.
#
# Env: COMPOSE_FILE, ENV_FILE, BACKUP_DIR — same defaults as backup.sh.
# Expect the replay to take roughly the original ingest volume ÷ worker throughput; watch
# `bun run dlq` for batches that fail to re-apply.

TS="${1:?usage: restore.sh <timestamp> [--no-replay]}"
REPLAY=1; [ "${2:-}" = "--no-replay" ] && REPLAY=0
COMPOSE_FILE="${COMPOSE_FILE:-infra/docker-compose.prod.yml}"
ENV_FILE="${ENV_FILE:-.env}"
BACKUP_DIR="${BACKUP_DIR:-./backups}"

# shellcheck disable=SC1090
set -a; . "$ENV_FILE"; set +a
compose() { docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" "$@"; }

PG_IN="$BACKUP_DIR/pg-$TS.dump"
REDIS_IN="$BACKUP_DIR/redis-$TS.rdb"
BLOB_IN="$(cd "$BACKUP_DIR/blob-$TS" && pwd)"
[ -s "$PG_IN" ] || { echo "error: $PG_IN not found" >&2; exit 1; }
[ -d "$BLOB_IN" ] || { echo "error: $BLOB_IN not found" >&2; exit 1; }

echo "[restore] stopping api + worker"
compose stop api worker

echo "[restore] postgres ← $PG_IN"
compose exec -T postgres psql -U memoturn -d postgres -v ON_ERROR_STOP=1 -c \
  "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = 'memoturn' AND pid <> pg_backend_pid();" > /dev/null
compose exec -T postgres pg_restore -U memoturn -d memoturn --clean --if-exists --no-owner --exit-on-error < "$PG_IN"
echo "[restore] postgres restored"

if [ -s "$REDIS_IN" ]; then
  echo "[restore] redis ← $REDIS_IN"
  compose stop redis
  # Valkey loads /data/dump.rdb on start; the RDB replaces whatever was there (docker cp
  # works on a stopped container).
  compose cp "$REDIS_IN" redis:/data/dump.rdb
  compose start redis
  echo "[restore] redis restored"
else
  echo "[restore] no redis snapshot for $TS — skipping (queues start empty)"
fi

BUCKET="${BLOB_BUCKET:-memoturn}"
echo "[restore] blob '$BUCKET' ← $BLOB_IN"
compose run --rm --no-deps \
  -v "$BLOB_IN:/backup:ro" \
  --entrypoint /bin/sh minio-setup -c "
    mc alias set local http://minio:9000 '${BLOB_ACCESS_KEY_ID:-memoturn}' '${BLOB_SECRET_ACCESS_KEY:?}' >/dev/null &&
    mc mb --ignore-existing local/$BUCKET >/dev/null &&
    mc mirror --overwrite /backup local/$BUCKET
  "
echo "[restore] blob restored"

echo "[restore] starting worker"
compose start worker
if [ "$REPLAY" = "1" ]; then
  echo "[restore] replaying raw batches from blob → telemetry store (this rebuilds Doris / the Postgres tier)"
  compose exec -T api bun scripts/replay-blob.ts --all
fi

echo "[restore] starting api"
compose start api
echo "[restore] done — verify: open the console, check \`bun run dlq\` for failed replays."
