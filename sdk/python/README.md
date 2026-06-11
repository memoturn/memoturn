# memoturn (Python SDK)

Python client for Memoturn — memory for AI agents. One dependency (`httpx`).

```python
from memoturn import Memoturn

mt = Memoturn("https://...", token=token)

# One profile per user/team/persona; every agent serving them shares it.
alice = mt.memory("acme", "alice")

alice.ingest([
    {"type": "fact", "topic_key": "user.diet", "summary": "vegetarian since 2024",
     "content": {"diet": "vegetarian"}},          # embeddings BYO or node auto-embeds
])

hits = alice.recall(query="what can this user eat?")
# hybrid keyword + topic + vector recall; superseded facts hidden; empty ≠ error

# Memory you can operate on (profile = one database):
alice.checkpoint("before-autonomous-run")
alice.rewind("before-autonomous-run")
burner = alice.fork("experiment", ttl=3600)

# Server-side extraction (when the node opts in):
alice.extract([{"role": "user", "content": "I'm vegan now"}], dry_run=True)

# Transcript layer + multi-model substrate:
alice.session("s-1").append_turn("user", {"text": "hello"})
db = mt.db("acme--alice")                          # docs/kv/vectors/sql/branches
```

Tokens: `mt.create_namespace_token("acme", "write")` (orchestrator — all `acme` profiles) or
`mt.create_token("acme--alice", "write")` (agent — one profile). Both need the platform key.

Install: `pip install -e .` — E2E (needs a running node): `python tests/e2e.py`.
Full spec: [docs/architecture/07-agent-memory.md](../../docs/architecture/07-agent-memory.md).
