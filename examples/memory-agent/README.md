# memory-agent

A chat agent whose memory lives in Memoturn — the full product loop in one file:
recall before answering, extract after each exchange, transcript persisted verbatim,
and a mind you can checkpoint and rewind.

```
you> I'm vegetarian, and I hate window seats
agent> Noted! ...
  (2 new memories stored)

^C  — restart the script —

you> book me a flight and dinner
agent> I'll look for an aisle seat, and make the dinner vegetarian...
```

## Run

```bash
cargo run -p memoturnd                 # terminal 1: a node (auth off for demo)
cd examples/memory-agent               # terminal 2:
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
ANTHROPIC_API_KEY=sk-... .venv/bin/python agent.py demo alice
```

Things to try:

- Tell it a preference, `/quit`, restart — it remembers (recall is profile-wide,
  not session-wide).
- Change your mind ("actually I eat fish now") — the old fact is **superseded**,
  not duplicated; `/memories` shows only the current truth.
- `/checkpoint sane`, teach it something wrong, `/rewind sane` — the whole mind
  snaps back (profile = one database).
- Run a second copy as a different agent against the same profile — they share
  the memories instantly.
- `/ask what do I eat?` — query the memory directly: server-side recall +
  answer synthesis with cited memory ids (needs `MEMOTURN_ASSISTANT_API_KEY`
  on the node).

Extraction runs server-side when the node has `MEMOTURN_EXTRACT_API_KEY`
(the agent calls `POST .../extract`); otherwise the agent falls back to the same
structured-outputs extraction client-side. With `MEMOTURN_EMBED_API_KEY` on the
node, recall adds the vector channel automatically — no embeddings in this file.
