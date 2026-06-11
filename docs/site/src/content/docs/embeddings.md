---
title: Auto-embedding
description: An opt-in, per-node embedder that gives text-only ingest and recall the vector channel — best-effort, outside the write path.
---

Embeddings are bring-your-own by default. Clients pass an `embedding` vector with each memory
at ingest and with each query at recall; the vector channel of [hybrid recall](/recall/) runs
only when vectors are present. Text-only requests are valid on any node — they use the
keyword and topic channels and skip the vector channel silently.

Nodes can opt in to embedding text themselves. With auto-embedding enabled, a memory ingested
without a vector gets one computed from its `summary` and `keywords`, and a bare `query`
string at recall is embedded before the vector channel runs — so plain-text agents get full
three-channel recall with no client-side embedding code.

## Node configuration

| Variable | Purpose |
| --- | --- |
| `MEMOTURN_EMBED_API_KEY` | Enables auto-embedding; the embedding provider's API key |
| `MEMOTURN_EMBED_PROVIDER` | `voyage` (default) or `openai` |
| `MEMOTURN_EMBED_MODEL` | Optional model override (defaults: `voyage-3.5`, `text-embedding-3-small`) |
| `MEMOTURN_EMBED_BASE_URL` | Optional base URL for the `openai` provider — any OpenAI-compatible server |

Auto-embedding is per-node and opt-in: without `MEMOTURN_EMBED_API_KEY`, vectors stay
bring-your-own and text-only requests simply skip the vector channel. See
[Configuration](/configuration/) for the full environment reference.

### Hosted providers

```bash
# Voyage (default provider)
MEMOTURN_EMBED_API_KEY=... memoturnd

# OpenAI
MEMOTURN_EMBED_PROVIDER=openai MEMOTURN_EMBED_API_KEY=... memoturnd
```

### Local, zero-egress embedding

The `openai` provider speaks the OpenAI embeddings wire format, so `MEMOTURN_EMBED_BASE_URL`
can point it at any OpenAI-compatible server — including one running on your own hardware —
and no text leaves your network for embedding:

```bash
MEMOTURN_EMBED_PROVIDER=openai \
MEMOTURN_EMBED_BASE_URL=http://127.0.0.1:11434/v1 \
MEMOTURN_EMBED_API_KEY=unused \
MEMOTURN_EMBED_MODEL=<local-model> \
memoturnd
```

## What gets embedded

| Operation | Input to the embedder | Condition |
| --- | --- | --- |
| Ingest | `summary` + `keywords` of the memory | Memory carries no client-supplied `embedding`; `task` memories are skipped by type |
| Recall | The bare `query` string | Request carries no client-supplied `embedding` |

A client-supplied vector always wins — auto-embedding never overwrites or recomputes it, so
BYO and auto-embedded clients can share a node. The vector index inside a profile is created
lazily at the dimension of the first embedding it sees.

## Failure behavior

Auto-embedding is **best-effort** and runs outside the write path:

- At ingest, a provider failure stores the memory without a vector — the write succeeds and
  the memory remains fully recallable through the keyword and topic channels. An embedding
  provider can never fail a write.
- At recall, a provider failure degrades the query to keyword + topic fusion for that request.

Hybrid recall is built for partial channels: results are reciprocal-rank fused across whatever
channels ran, and each hit reports which channels found it, so degraded recall is visible
rather than silent.

## Performance

From the README measured table (prototype, single node, p50): memory ingest of a typed fact
with a 256-dimension embedding and supersession completes in 3.9 ms, and hybrid recall over
10k memories — FTS, topic, and ANN, rank-fused — in 11.7 ms. Reproduce with
`cargo run --release -p memoturn-bench`. Calls to a remote embedding provider add that
provider's round trip on top.

## Choosing a posture

- **BYO** (default) — you already compute embeddings in your pipeline, want one model shared
  with other systems, or want full control over dimensions and versioning.
- **Auto-embedding** — agents send plain text and you want the vector channel anyway; one
  provider configuration per node instead of per client.
- **Auto-embedding with a local server** — the same, with zero egress.

## Related pages

- [Recall](/recall/) — channel weights and rank fusion.
- [Memories](/memories/) — the typed record and which types carry embeddings.
- [Server-side extraction](/extraction/) — the analogous opt-in for distilling transcripts.
- [Quickstart](/quickstart/) — ingest and recall end to end.
