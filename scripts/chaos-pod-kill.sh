#!/usr/bin/env bash
# Disposable-node proof on Kubernetes: write agent state, sync, kill the
# data-plane pod, and verify the replacement pod serves the same state from
# object storage — catalog, auth signing key, and data all survive without
# any PersistentVolume.
#
# Usage: scripts/chaos-pod-kill.sh [base-url] [platform-key]
set -euo pipefail
BASE="${1:-http://127.0.0.1:8080}"
PK="${2:-kind-platform-key}"
say() { printf "\n\033[1m== %s\033[0m\n" "$*"; }

say "1. Provision + write agent state"
curl -fsS -X POST "$BASE/v1/databases" -H "authorization: Bearer $PK" \
  -H 'content-type: application/json' -d '{"name":"chaos-agent"}' >/dev/null || true
TOKEN=$(curl -fsS -X POST "$BASE/v1/databases/chaos-agent/tokens" \
  -H "authorization: Bearer $PK" -H 'content-type: application/json' \
  -d '{"scope":"admin"}' | python3 -c 'import json,sys;print(json.load(sys.stdin)["token"])')
curl -fsS -X PUT "$BASE/v1/db/chaos-agent/kv/s/memory" \
  -H "authorization: Bearer $TOKEN" -d 'survives pod death' >/dev/null
curl -fsS -X POST "$BASE/v1/db/chaos-agent/docs/memories/insert" \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"docs":[{"kind":"fact","text":"durable"}]}' >/dev/null

say "1b. Alice's memories (namespace token, typed memory + supersession)"
NSTOKEN=$(curl -fsS -X POST "$BASE/v1/namespaces/chaos/tokens" \
  -H "authorization: Bearer $PK" -H 'content-type: application/json' \
  -d '{"scope":"admin"}' | python3 -c 'import json,sys;print(json.load(sys.stdin)["token"])')
curl -fsS -X POST "$BASE/v1/memory/chaos/alice/memories" \
  -H "authorization: Bearer $NSTOKEN" -H 'content-type: application/json' \
  -d '{"memories":[{"type":"fact","topic_key":"user.seat","summary":"prefers aisle seats",
       "content":{"seat":"aisle"},"keywords":"seat preference"}]}' >/dev/null
say "2. Ship to object storage"
curl -fsS -X POST "$BASE/v1/db/chaos-agent/sync" -H "authorization: Bearer $TOKEN" >/dev/null
curl -fsS -X POST "$BASE/v1/db/chaos--alice/sync" -H "authorization: Bearer $NSTOKEN" >/dev/null
sleep 3  # catalog backup loop interval

say "3. Kill the data-plane pod"
POD=$(kubectl get pods -l app.kubernetes.io/component=dataplane -o name | head -1)
kubectl delete "$POD" --wait=false
START=$(date +%s)
kubectl wait --for=condition=ready pod -l app.kubernetes.io/component=dataplane --timeout=180s >/dev/null
sleep 2  # port-forward re-establish window

say "4. Same token, same data, fresh pod"
for i in $(seq 1 30); do
  VALUE=$(curl -fsS "$BASE/v1/db/chaos-agent/kv/s/memory" -H "authorization: Bearer $TOKEN" 2>/dev/null) && break
  sleep 2
done
RECOVERY=$(( $(date +%s) - START ))
echo "kv after pod death: '$VALUE'  (recovered in ~${RECOVERY}s incl. pod start)"
[ "$VALUE" = "survives pod death" ] || { echo "FAIL: data lost"; exit 1; }
DOCS=$(curl -fsS -X POST "$BASE/v1/db/chaos-agent/docs/memories/find" \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{"filter":{}}')
echo "docs after pod death: $DOCS"
echo "$DOCS" | grep -q '"durable"' || { echo "FAIL: docs lost"; exit 1; }
RECALL=$(curl -fsS -X POST "$BASE/v1/memory/chaos/alice/recall" \
  -H "authorization: Bearer $NSTOKEN" -H 'content-type: application/json' \
  -d '{"topic_key":"user.seat"}')
echo "alice's memories after pod death: $RECALL"
echo "$RECALL" | grep -q 'prefers aisle seats' || { echo "FAIL: memories lost"; exit 1; }

say "PASS — disposable node verified: no PV, state (incl. Alice's memories) restored from object storage"
