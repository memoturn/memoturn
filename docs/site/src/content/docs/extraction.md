---
title: Server-side extraction
description: An opt-in, per-node endpoint that distills raw conversation transcripts into schema-valid typed memories before any database write.
---

Extraction — deciding *what* in a conversation is memorable — is the client's job by default.
The agent (or its framework) distills turns into typed memories and posts them to the ordinary
ingest endpoint; this bring-your-own posture keeps LLM credentials, cost, and latency entirely
out of the database. Raw turns still flow through the transcript layer verbatim, so nothing is
lost between extractions.

Nodes can opt in to doing the distillation server-side. A configured node accepts a raw
transcript, makes a control-plane LLM call to extract typed memories from it, and feeds the
proposals through the same idempotent ingest path as any client write.

## Node configuration

| Variable | Purpose |
| --- | --- |
| `MEMOTURN_EXTRACT_API_KEY` | Enables extraction; the API key for the control-plane LLM call (Anthropic API) |
| `MEMOTURN_EXTRACT_MODEL` | Optional model override (default `claude-opus-4-8`) |

Extraction is per-node and opt-in. A node without `MEMOTURN_EXTRACT_API_KEY` returns **503**
from the extract endpoint, and extraction stays bring-your-own for its clients. See
[Configuration](/configuration/) for the full environment reference.

## Endpoint

```
POST /v1/memory/{ns}/{profile}/extract
```

```json
{
  "turns": [
    { "role": "user", "content": "actually I'm vegan now, not just vegetarian" },
    { "role": "assistant", "content": "Noted — I'll keep that in mind." }
  ],
  "session_id": "s-417",
  "dry_run": false
}
```

- `turns` — the raw conversation, `{role, content}` per turn.
- `session_id` — optional; attaches extracted `task` memories and session-scoped semantics.
- `dry_run` — return the proposed memories without writing anything.

The response reports the proposals and, unless `dry_run` is set, the ingest results — the same
`created` / `revived` / `duplicate` statuses, supersession reporting, and `txid` as a direct
call to the ingest endpoint. Extracting the same transcript twice does not duplicate
memories.

## Position relative to the write path

The LLM call happens **before** any database write — never inside it. The sequence is:

1. The node sends the transcript to the control-plane model.
2. The call is structured-output-constrained: the model can only produce schema-valid typed
   memories (`fact` / `event` / `instruction` / `task`, with `topic_key`, `summary`,
   `content`).
3. The validated proposals enter the ordinary idempotent ingest — one batch, one transaction,
   one `txid`, with supersession applied by topic key.

Provider credentials, per-call cost, and LLM latency therefore never touch the write path,
and a slow or failing extraction call cannot stall or corrupt a write. Everything after step 2
is identical to a client posting memories itself.

## Clients

CLI — turns as a JSON array on stdin:

```bash
echo '[{"role":"user","content":"actually I am vegan now"}]' \
  | memoturn memory extract acme alice --dry-run
```

TypeScript:

```ts
const { results, proposed } = await alice.extract(
  [{ role: "user", content: "actually I'm vegan now" }],
  { dryRun: true },
);
```

Python:

```python
alice.extract([{"role": "user", "content": "actually I'm vegan now"}], dry_run=True)
```

MCP — the `memory_extract` tool takes the same `{namespace, profile, turns, session_id?,
dry_run?}` shape and reports a 503 error when the node has no extractor, so agents can fall
back to `memory_ingest` with their own distilled memories. See [MCP server](/mcp/).

## Default posture

Bring-your-own extraction remains the default. Use server-side extraction when you want one
consistent extraction policy across heterogeneous agents, or when agents are too constrained
to run their own distillation; keep extraction client-side when you already distill in your
agent framework or cannot route transcripts through the node's LLM provider.

## Related pages

- [Memories](/memories/) — the typed record extraction produces.
- [Sessions](/sessions/) — the transcript layer raw turns flow through regardless.
- [Auto-embedding](/embeddings/) — the analogous opt-in for the vector channel.
- [API reference](/api-rest/) — the full memory route set.
