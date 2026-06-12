---
title: Ask & answer synthesis
description: The /ask endpoint — hybrid recall plus server-side answer synthesis with cited memory ids, and the fallback pattern when a node hasn't opted in.
---

`/ask` turns a natural-language question into a grounded answer: the node runs
[hybrid recall](/recall/) over the profile's memories, then its built-in assistant synthesizes
a prose answer citing the memory ids it rests on.

```bash
memoturn ask acme alice "what can this user eat?"
# vegan — switched from vegetarian in 2026
# sources: mem_9f2c…
```

```python
asked = alice.ask("what can this user eat?")
# {"answer": "...", "sources": ["mem_9f2c…"], "memories": [...]}
```

`answer` is `null` when nothing relevant was recalled — the assistant never invents an answer
from an empty result. The recalled memories ride along in `memories` for attribution or
display, and the same filters as recall apply (`types`, `session_id`, `source`, `k`,
`include_superseded`).

## Opting a node in

Answer synthesis is a **per-node opt-in** and stays off the write path:

| env var | role |
| --- | --- |
| `MEMOTURN_ASSISTANT_API_KEY` | enables `/ask`; falls back to `MEMOTURN_EXTRACT_API_KEY` if unset |
| `MEMOTURN_ASSISTANT_MODEL` | optional model override |

A node without a key keeps every other endpoint working; `/ask` returns 503 with code
`unconfigured`.

## The fallback pattern

Because the 503 is machine-readable, clients degrade gracefully — recall, then synthesize with
whatever model the agent already has:

```python
try:
    answer = alice.ask(question)["answer"]
except MemoturnError as e:
    if e.code != "unconfigured":
        raise
    memories = alice.recall(query=question)["memories"]
    answer = my_model.summarize(question, memories)  # bring-your-own synthesis
```

The `memory-agent` example in the repository runs this exact loop, and the
[MCP server](/mcp/)'s `memory_ask` tool surfaces the same behavior to agent frameworks.

## Governance

`ask` is AI egress: the question and recalled memories leave the database for the assistant
model. Namespaces can deny it wholesale with the `ai_egress.ask = deny` policy rule, and audit
streams record each call's metadata when enabled — see [security](/security/) and the
governance policy docs.
