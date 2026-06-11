#!/usr/bin/env bash
# The Memoturn pitch demo: memory for agents. One profile per user that every
# agent shares — typed memories with supersession, hybrid recall, and a mind
# you can checkpoint and rewind. The multi-model substrate (transcript, docs,
# KV, burner branches) rides underneath.
#
# Usage: scripts/demo.sh [base-url]   (default http://127.0.0.1:8080, auth off)
set -euo pipefail
BASE="${1:-http://127.0.0.1:8080}"
P="$BASE/v1/memory/acme/alice"
DB="$BASE/v1/db/acme--alice"
say() { printf "\n\033[1m== %s\033[0m\n" "$*"; }
req() { curl -fsS "$@"; echo; }

say "1. Ingest typed memories — the profile auto-creates ({ns}--{profile} = one database)"
req -X POST "$P/memories" -H 'content-type: application/json' -d '{"memories":[
  {"type":"fact","topic_key":"user.seat","summary":"prefers aisle seats",
   "content":{"seat":"aisle"},"keywords":"seat travel preference","embedding":[1,0,0]},
  {"type":"event","summary":"booked flight BA117 to JFK",
   "content":{"flight":"BA117"},"keywords":"flight booking","embedding":[0,1,0]},
  {"type":"task","summary":"check in 24h before departure","content":{},"session_id":"s-1"}
]}'

say "2. Idempotent: the same memory again is a duplicate, not a copy"
req -X POST "$P/memories" -H 'content-type: application/json' -d '{"memories":[
  {"type":"fact","topic_key":"user.seat","summary":"prefers aisle seats",
   "content":{"seat":"aisle"},"keywords":"seat travel preference","embedding":[1,0,0]}]}'

say "3. The user changes their mind — supersession by topic, history preserved"
req -X POST "$P/memories" -H 'content-type: application/json' -d '{"memories":[
  {"type":"fact","topic_key":"user.seat","summary":"prefers window seats now",
   "content":{"seat":"window"},"keywords":"seat travel preference","embedding":[0.9,0.1,0]}]}'

say "4. Hybrid recall (keyword + topic + vector, rank-fused; superseded hidden)"
req -X POST "$P/recall" -H 'content-type: application/json' \
  -d '{"query":"what seat does the user like?","embedding":[1,0,0],"k":3}'

say "5. Checkpoint the agent's mind, learn something wrong, rewind"
req -X POST "$DB/branches/main/checkpoint" -H 'content-type: application/json' -d '{"name":"sane"}'
req -X POST "$P/memories" -H 'content-type: application/json' -d '{"memories":[
  {"type":"fact","topic_key":"user.seat","summary":"sits only on the wing",
   "content":{"seat":"wing"},"keywords":"seat"}]}'
req -X POST "$DB/branches/main/rewind" -H 'content-type: application/json' -d '{"to":"sane"}'
echo "after rewind:" && req -X POST "$P/recall" -H 'content-type: application/json' \
  -d '{"topic_key":"user.seat"}'

say "6. The substrate underneath: verbatim transcript + scratch KV in the same database"
req -X POST "$DB/memory/s-1/turns" -H 'content-type: application/json' \
  -d '{"role":"user","content":{"text":"window seat please"},"embedding":[0.9,0.1,0]}'
curl -fsS -X PUT "$DB/kv/scratch/plan?ttl=3600" -d 'rebook BA117 with window seat'; echo
req "$DB/kv/scratch/plan"

say "7. Raw-turn recall channel: the verbatim moment alongside typed memories"
req -X POST "$P/recall" -H 'content-type: application/json' \
  -d '{"embedding":[0.9,0.1,0],"include_turns":true,"k":2}'

say "8. Burner branch: an experiment ingests freely, main never sees it"
req -X POST "$DB/branches" -H 'content-type: application/json' -d '{"name":"burner","ttl":3600}'
req -X POST "$P/memories?branch=burner" -H 'content-type: application/json' -d '{"memories":[
  {"type":"fact","topic_key":"experiment.x","summary":"risky hypothesis","content":{}}]}'
echo "main is untouched:" && req -X POST "$P/recall" -H 'content-type: application/json' \
  -d '{"topic_key":"experiment.x"}'

say "9. Durability: ship the profile to object storage"
req -X POST "$DB/sync"

say "Demo complete — one tiny database holds Alice's whole mind: memories, transcript, KV."
req -X POST "$P/recall" -H 'content-type: application/json' -d '{"query":"seat flight check"}'
