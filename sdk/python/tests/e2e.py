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
    assert e.code == "unconfigured", f"503 must carry the unconfigured code, got: {e.code}"
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

# governance: policy roundtrip, tighten-only override, audit stream
if platform_key:
    mt.set_policy(ns, {"memory": {"task_ttl_max_secs": 600}, "audit": {"enabled": True}})
    doc = mt.get_policy(ns)
    assert doc["policy"]["memory"]["task_ttl_max_secs"] == 600, doc
    prof = mt.get_policy(ns, profile="alice")
    assert prof["effective"]["task_ttl_max_secs"] == 600, prof
    try:
        mt.set_policy(ns, {"memory": {"task_ttl_max_secs": 9999}}, profile="alice")
        raise AssertionError("loosening override must be rejected")
    except MemoturnError as e:
        assert e.status == 409, e
    alice.ingest([{"type": "event", "summary": "audited write", "content": {"n": 1}}])
    time.sleep(2.6)  # wait out the audit flush interval
    events = list(mt.audit_events(ns, action="memory."))
    assert any(e["action"] == "memory.ingest" and e.get("profile") == "alice" for e in events), events
    assert all("summary" not in e and "content" not in e for e in events), "metadata only"

# error codes: stable machine-readable branch points
try:
    mt.db(f"{ns}--alice@ghost").sql("SELECT 1")
    raise AssertionError("missing branch must 404")
except MemoturnError as e:
    assert e.status == 404 and e.code == "branch_not_found", (e.status, e.code)

# context manager closes only owned clients
with Memoturn(url, token=token, platform_key=platform_key) as ctx_mt:
    assert ctx_mt.db(f"{ns}--alice").kv.get("scratch", "plan") == "step 1"


# ---- async twin: same flow, AsyncMemoturn ----
async def async_flow() -> None:
    from memoturn import AsyncMemoturn

    async with AsyncMemoturn(url, token=token, platform_key=platform_key) as amt:
        bob = amt.memory(ns, "bob")
        r = await bob.ingest(
            [
                {
                    "type": "fact",
                    "topic_key": "user.lang",
                    "summary": "prefers rust",
                    "content": {"lang": "rust"},
                    "keywords": "language preference",
                    "embedding": [1, 0],
                }
            ]
        )
        assert r["results"][0]["status"] == "created", r
        rust_id = r["results"][0]["id"]

        r = await bob.ingest(
            [
                {
                    "type": "fact",
                    "topic_key": "user.lang",
                    "summary": "prefers zig now",
                    "content": {"lang": "zig"},
                    "keywords": "language preference",
                    "embedding": [0.9, 0.1],
                }
            ]
        )
        assert r["results"][0]["superseded"] == [rust_id], r

        hits = (await bob.recall(query="language preference"))["memories"]
        assert hits[0]["summary"] == "prefers zig now", hits
        got = await bob.get(rust_id)
        assert got is not None and got["superseded_by"] == r["results"][0]["id"]
        assert await bob.get("mem_does_not_exist") is None

        t = bob.session("as-1")
        await t.append_turn("user", {"text": "zig it is"}, embedding=[0.9, 0.1])
        assert len(await t.get_window(last=5)) == 1
        await bob.end_session("as-1", turns=True)

        await bob.checkpoint("sane")
        await bob.ingest([{"type": "fact", "topic_key": "user.lang", "summary": "brainfuck", "content": {}}])
        await bob.rewind("sane")
        after = (await bob.recall(topic_key="user.lang"))["memories"]
        assert after[0]["summary"] == "prefers zig now", after

        adb = amt.db(f"{ns}--bob")
        await adb.kv.put("scratch", "plan", "async step")
        assert await adb.kv.get("scratch", "plan") == "async step"
        assert await adb.kv.get("scratch", "missing") is None

        try:
            await amt.db(f"{ns}--bob@ghost").sql("SELECT 1")
            raise AssertionError("missing branch must 404")
        except MemoturnError as e:
            assert e.status == 404 and e.code == "branch_not_found", (e.status, e.code)


import asyncio  # noqa: E402

asyncio.run(async_flow())
print("python sdk async e2e: ok")

print("python sdk e2e: ok")
