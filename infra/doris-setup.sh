#!/bin/sh
# One-shot Doris root-password bootstrap (the image boots with root/empty).
# Idempotent: if the target password already authenticates, exits 0 untouched.
# Runs via the FE HTTP query API so a plain curl image suffices (no mysql client).
# NOTE: DORIS_PASSWORD must not contain single quotes or backslashes.
set -eu

FE_QUERY_URL="http://doris-fe:8030/api/query/default_cluster/information_schema"

if curl -sf -u "root:${DORIS_PASSWORD}" -H 'Content-Type: application/json' \
    -d '{"stmt":"SELECT 1"}' "$FE_QUERY_URL" >/dev/null 2>&1; then
  echo "doris root password already set"
  exit 0
fi

response=$(curl -sf -u root: -H 'Content-Type: application/json' \
  -d "{\"stmt\":\"SET PASSWORD FOR 'root' = PASSWORD('${DORIS_PASSWORD}')\"}" "$FE_QUERY_URL")

case "$response" in
  *'"code": 0'*|*'"code":0'*)
    echo "doris root password set"
    ;;
  *)
    echo "failed to set doris root password: $response" >&2
    exit 1
    ;;
esac
