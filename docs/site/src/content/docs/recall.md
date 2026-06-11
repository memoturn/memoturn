---
title: Hybrid recall
description: The topic, keyword, and vector recall channels, reciprocal-rank fusion, filters, and the raw-turn channel.
---

Recall runs entirely inside one [profile](/profiles/) database — three channels over the same
rows, merged by reciprocal-rank fusion. There is no cross-profile search, structurally.

`POST /v1/memory/{ns}/{profile}/recall` requires at least one of `query`, `embedding`,
`topic_key`.

## The three channels

| Channel | Mechanism | Driven by | RRF weight |
| --- | --- | --- | --- |
| topic | exact `topic_key` lookup over active memories | `topic_key` | 2.0 |
| keyword | FTS5 (BM25) over `summary` + `keywords` | `query` | 1.0 |
| vector | DiskANN ANN over memory embeddings | `embedding` (or `query` with [auto-embedding](/embeddings/)) | 1.0 |

The vector channel is best-effort: a missing vector table or a dimension mismatch degrades recall
to keyword + topic rather than failing the request. Task memories skip the vector channel
entirely — see [Typed memories](/memories/).

## Rank fusion

Channel results merge by reciprocal-rank fusion: `score = Σ w / (60 + rank)` across the channels
that returned the memory. The merged list drops superseded and expired rows, tiebreaks on
recency, and truncates to `k` (default 8).

Each hit reports which channels found it (`channels`), so an agent can weigh an exact topic match
differently from a fuzzy semantic one.

**Empty is a valid answer.** Recall never pads results to reach `k`, and recall against a profile
that does not exist returns `{"memories": [], "txid": 0}` without creating anything.

Hybrid recall over 10k memories (FTS5 + topic + ANN, rank-fused) measured **11.7 ms p50** on the
prototype.

## Request

```bash
curl -X POST http://localhost:8080/v1/memory/acme/alice/recall \
  -H 'content-type: application/json' \
  -d '{"query": "what can this user eat?",
       "topic_key": "user.diet",
       "types": ["fact"],
       "k": 8}'
```

| Field | Meaning |
| --- | --- |
| `query` | free text for the keyword channel (and the vector channel when auto-embedding is configured) |
| `embedding` | `f32` vector for the vector channel; bring-your-own by default |
| `topic_key` | exact key for the topic channel |
| `types` | filter to a subset of `fact` / `event` / `instruction` / `task` |
| `session_id` | restrict to memories ingested with this session |
| `k` | result cap, default 8 |
| `include_superseded` | include superseded rows (default `false`) |
| `include_turns` | also search the raw transcript (see below) |

## Response

```json
{
  "memories": [
    {
      "id": "mem_b2…",
      "type": "fact",
      "topic_key": "user.diet",
      "summary": "vegan since 2026",
      "content": {"diet": "vegan"},
      "keywords": "food preference",
      "session_id": null,
      "created_at": 1781136000000,
      "superseded_by": null,
      "score": 0.04918,
      "channels": ["topic", "keyword"]
    }
  ],
  "txid": 43
}
```

The vegetarian fact this one [superseded](/memories/) does not appear; pass
`"include_superseded": true` or fetch it by id to see the chain. Every response carries `txid`
(also as the `Memoturn-Txid` header) — send `Memoturn-Min-Txid` for read-your-writes after an
ingest. See [Consistency](/consistency/).

## The raw-turn channel

Typed memories are distilled; the verbatim transcript is still searchable. With
`"include_turns": true` (requires an `embedding`, or a `query` plus a configured embedder),
recall additionally runs a brute-force cosine search over the transcript layer — optionally
scoped by `session_id` — and returns matching turns in a separate `turns` array:

```json
{
  "memories": [ … ],
  "turns": [
    {"session_id": "s-417", "seq": 12, "role": "user",
     "content": {"text": "I went vegan in January"}, "distance": 0.18}
  ],
  "txid": 43
}
```

Turns are not memories, so they are reported alongside the fused ranking, never mixed into it.
The transcript layer itself is covered in [Sessions](/sessions/).

## Targeted lookups

Two non-fused reads complement recall:

```bash
# one memory by id, with its full supersession chain
curl http://localhost:8080/v1/memory/acme/alice/memories/mem_b2…

# the profile's sessions
curl http://localhost:8080/v1/memory/acme/alice/sessions
```

## Related

- [Typed memories](/memories/) — what recall searches
- [Embeddings](/embeddings/) — auto-embedding bare `query` strings
- [API reference](/api-rest/) — the full memory route list
- [SDKs](/sdk-typescript/) and [MCP](/mcp/) — `memory_recall` as a tool
