"""Data governance (ADR-0010): policy, audit stream, verifiable erasure.

The compliance story end to end: set a namespace policy (audit on, TTL caps,
erasure grace), watch the tighten-only rule reject a loosening profile
override, ingest a sensitive fact, erase it — gone from recall immediately,
with a coupon promising a bounded-time history rewrite proven by a signed
receipt — and export the audit stream, which records all of it as metadata
only, never memory content.

Run against any node:  MEMOTURN_URL=... python3 demo.py
(With auth on, export MEMOTURN_PLATFORM_KEY; auth-off dev nodes need nothing,
but their receipts are explicitly unsigned — alg "none".)
"""

from __future__ import annotations

import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from common import MemoturnError, check, client, finish, note, say, unique_ns  # noqa: E402

mt = client(source="governance-demo")
ns = unique_ns("gov")
erin = mt.memory(ns, "erin")
print(f"governance demo · namespace {ns} · profile erin")

say("Set the namespace policy: audit on, erasure grace, task TTL cap")
doc = mt.set_policy(
    ns,
    {
        "audit": {"enabled": True},
        # 60s is the enforced minimum grace window — the demo uses the floor.
        "erasure": {"grace_secs": 60},
        "memory": {"task_ttl_max_secs": 600},
    },
)
check("policy stored with a revision", doc.get("revision", 0) >= 1, doc)

say("Read it back, including the effective policy a profile actually gets")
roundtrip = mt.get_policy(ns)
check(
    "namespace policy roundtrips",
    roundtrip is not None and roundtrip["policy"]["memory"]["task_ttl_max_secs"] == 600,
    roundtrip,
)
prof = mt.get_policy(ns, profile="erin")
check("effective TTL cap reaches the profile", prof["effective"]["task_ttl_max_secs"] == 600, prof)
check("effective erasure grace is the floor", prof["effective"]["erasure_grace_secs"] == 60, prof)

say("Profile overrides are tighten-only: loosening is rejected")
try:
    mt.set_policy(ns, {"memory": {"task_ttl_max_secs": 9999}}, profile="erin")
    check("loosening override rejected", False, "the PUT was accepted")
except MemoturnError as e:
    check("loosening override rejected with 409", e.status == 409, e)

say("Ingest a sensitive fact next to an ordinary one")
r = erin.ingest(
    [
        {
            "type": "fact",
            "topic_key": "user.gov_id",
            "summary": "holds passport number (redacted)",
            "content": {"doc": "passport"},
            "keywords": "passport identity document number",
        },
        {
            "type": "fact",
            "topic_key": "user.team",
            "summary": "works on the platform team",
            "content": {},
            "keywords": "team platform org",
        },
    ]
)
check("both facts created", all(x["status"] == "created" for x in r["results"]), r)
sensitive_id = r["results"][0]["id"]

say("Erase the sensitive topic: hard-forget now, history rewrite promised")
coupon = erin.erase(topic_key="user.gov_id", type="fact")
check("erasure accepted with a coupon id", bool(coupon.get("erasure_id")), coupon)
erasure_id = coupon["erasure_id"]
gone = erin.recall(query="passport identity document")["memories"]
check("the sensitive fact is gone from recall", all(m["id"] != sensitive_id for m in gone), gone)
check("the sensitive fact is gone from get()", erin.get(sensitive_id) is None)
ordinary = erin.recall(topic_key="user.team")["memories"]
check("the ordinary fact is untouched", bool(ordinary), ordinary)

say("The coupon records exactly what was erased and by when")
ledger = erin.erasures()
check("one coupon on the ledger", len(ledger) == 1, ledger)
c = ledger[0]
check("status is pending (grace window open)", c["status"] == "pending", c)
check("it names the erased memory", c.get("memory_ids") == [sensitive_id], c)
check("it names the target topic", c["target"].get("topic_key") == "user.gov_id", c)
check(
    "grace_until is requested_at + 60s",
    abs(c["grace_until"] - c["requested_at"] - 60_000) < 2_000,
    c,
)

say("Export the audit stream — every step above, metadata only")
time.sleep(2.6)  # wait out the audit flush window
events = list(mt.audit_events(ns))
actions = [e["action"] for e in events]
check("policy.update audited", "policy.update" in actions, actions)
check("memory.ingest audited for erin", any(e["action"] == "memory.ingest" and e.get("profile") == "erin" for e in events), actions)
check("erasure.requested audited", "erasure.requested" in actions, actions)
check(
    "events carry metadata only, never content",
    all("summary" not in e and "content" not in e for e in events),
    events,
)

say("Poll for the receipt (best-effort: the rewrite runs on a maintenance tick)")
final = None
for _ in range(3):
    final = erin.erasure(erasure_id)
    if final and final["status"] == "completed":
        break
    time.sleep(1)
check("coupon status is a valid lifecycle state", final is not None and final["status"] in ("pending", "blocked", "completed"), final)
if final and final["status"] == "completed":
    receipt = final.get("receipt") or {}
    check("completed coupon carries a receipt", "payload" in receipt and "alg" in receipt, final)
    note(f"receipt alg: {receipt.get('alg')}  key_id: {receipt.get('key_id')}")
    note("(auth-off dev nodes sign with alg 'none' — stated, not implied; verification needs the operator-held cluster public key)")
else:
    note("still pending — the history rewrite runs on the node's ~10-minute maintenance tick,")
    note("after the 60s grace window. Re-run against a long-lived node to see 'completed' + receipt.")

finish("governance demo")
