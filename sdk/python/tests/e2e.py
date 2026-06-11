# SDK e2e against a live memoturnd (mirror of sdk/typescript/test/e2e.mjs).
# Env: MEMOTURN_URL (default http://127.0.0.1:8080), MEMOTURN_PLATFORM_KEY
# (auth on) — or a node with auth disabled.
# Run: python tests/e2e.py   (from sdk/python, with a node up)
import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from memoturn import Memoturn, MemoturnError  # noqa: E402

url = os.environ.get("MEMOTURN_URL", "http://127.0.0.1:8080")
platform_key = os.environ.get("MEMOTURN_PLATFORM_KEY")
ns = f"pysdk{int(time.time()) % 100000}"

platform = Memoturn(url, platform_key=platform_key)
token = platform.create_namespace_token(ns, "admin") if platform_key else None
mt = Memoturn(url, token=token, platform_key=platform_key)
alice = mt.memory(ns, "alice")

# ingest: created → duplicate → supersession
r = alice.ingest(
    [
        {
            "type": "fact",
            "topic_key": "user.diet",
            "summary": "vegetarian since 2024",
            "content": {"diet": "vegetarian"},
            "keywords": "food preference",
            "embedding": [1, 0],
        },
        {"type": "event", "summary": "ordered a salad", "content": {"order": 17}, "embedding": [0, 1]},
        {"type": "task", "summary": "confirm allergy info", "content": {}, "session_id": "s-1"},
    ]
)
assert len(r["results"]) == 3 and all(x["status"] == "created" for x in r["results"]), r
diet_id = r["results"][0]["id"]

r = alice.ingest(
    [
        {
            "type": "fact",
            "topic_key": "user.diet",
            "summary": "vegetarian since 2024",
            "content": {"diet": "vegetarian"},
            "embedding": [1, 0],
        }
    ]
)
assert r["results"][0]["status"] == "duplicate", r

r = alice.ingest(
    [
        {
            "type": "fact",
            "topic_key": "user.diet",
            "summary": "vegan since 2026",
            "content": {"diet": "vegan"},
            "keywords": "food preference",
            "embedding": [0.9, 0.1],
        }
    ]
)
assert r["results"][0]["superseded"] == [diet_id], r
vegan_id = r["results"][0]["id"]

# recall: keyword channel hides superseded; chain visible via get()
hits = alice.recall(query="what food preference?")["memories"]
assert hits[0]["summary"] == "vegan since 2026" and "keyword" in hits[0]["channels"], hits
assert all(m["id"] != diet_id for m in hits)
assert alice.get(diet_id)["superseded_by"] == vegan_id

# vector channel + raw-turn channel
by_vec = alice.recall(embedding=[0.1, 0.9], k=1)["memories"]
assert by_vec[0]["summary"] == "ordered a salad", by_vec
t = alice.session("s-1")
t.append_turn("user", {"text": "I'm vegan now"}, embedding=[0.9, 0.1])
out = alice.recall(embedding=[0.9, 0.1], include_turns=True, k=2)
assert len(out["turns"]) == 1, out

# ask: answer synthesis when the node has an assistant; clean 503 otherwise
try:
    asked = alice.ask("what is the user's food preference?")
    assert isinstance(asked["answer"], str) and isinstance(asked["sources"], list), asked
    assert any(m["summary"] == "vegan since 2026" for m in asked["memories"]), asked
    print("ask: assistant answered")
except MemoturnError as e:
    assert e.status == 503, f"ask must 503 cleanly when unconfigured, got: {e}"
    print("ask: node has no assistant (503) — skipped")

# sessions lifecycle
assert [s["id"] for s in alice.sessions()] == ["s-1"]
assert len(t.get_window(last=5)) == 1
alice.end_session("s-1", turns=True)
assert alice.sessions() == []

# checkpoint → learn garbage → rewind the mind (admin)
alice.checkpoint("sane")
alice.ingest(
    [{"type": "fact", "topic_key": "user.diet", "summary": "eats only concrete", "content": {}}]
)
alice.rewind("sane")
after = alice.recall(topic_key="user.diet")["memories"]
assert after[0]["summary"] == "vegan since 2026", after

# burner fork is isolated from main
burner = alice.fork("exp", ttl=3600)
burner.ingest([{"type": "event", "summary": "risky experiment ran", "content": {}}])
assert alice.recall(query="risky experiment")["memories"] == []

# source provenance: client-level default, explicit override, recall filter
coder = Memoturn(url, token=token, platform_key=platform_key, source="claude-code").memory(ns, "alice")
r = coder.ingest(
    [
        {"type": "event", "summary": "refactored the auth module", "content": {"pr": 41}},
        {"type": "event", "summary": "reviewed the auth module", "content": {"pr": 42}, "source": "cursor"},
    ]
)
assert all(x["status"] == "created" for x in r["results"]), r
by_src = {m["source"] for m in alice.recall(query="auth module")["memories"]}
assert by_src == {"claude-code", "cursor"}, by_src
only_cursor = alice.recall(query="auth module", source="cursor")["memories"]
assert [m["source"] for m in only_cursor] == ["cursor"], only_cursor
assert alice.get(r["results"][0]["id"])["source"] == "claude-code"

# forget is the only hard delete
assert alice.forget(vegan_id) is True
assert alice.forget(vegan_id) is False

# namespace listing (ns token) + substrate smoke
if token:
    assert [p["profile"] for p in mt.profiles(ns)] == ["alice"]
db = mt.db(f"{ns}--alice")
db.kv.put("scratch", "plan", "step 1")
assert db.kv.get("scratch", "plan") == "step 1"
assert db.sql("SELECT 1")["results"][0]["rows"][0][0] == 1

print("python sdk e2e: ok")
