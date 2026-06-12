"""Two agents, one mind: shared profile memory with source provenance.

A researcher agent and a writer agent serve the same project profile. Each
writes memories under its own ``source``; both recall everything, can filter
by who learned it, and see each other's supersessions immediately. The raw
transcript layer gives them a shared session log on top.

Run against any node:  MEMOTURN_URL=... python3 demo.py
With ANTHROPIC_API_KEY set, the writer also drafts a sentence grounded in the
researcher's findings.
"""

from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from common import check, client, complete, finish, llm, note, say, unique_ns  # noqa: E402

ns = unique_ns("team")
researcher = client(source="researcher").memory(ns, "apollo")
writer = client(source="writer").memory(ns, "apollo")
print(f"multi-agent demo · namespace {ns} · profile apollo · sources researcher, writer")

say("The researcher records a finding and an event")
r = researcher.ingest(
    [
        {
            "type": "fact",
            "topic_key": "research.best_method",
            "summary": "rank fusion beats any single recall channel",
            "content": {"basis": "eval run 7"},
            "keywords": "rank fusion recall channel method best",
        },
        {
            "type": "event",
            "summary": "collected three papers on retrieval evaluation",
            "content": {"count": 3},
            "keywords": "papers retrieval evaluation collected",
        },
    ]
)
check("researcher memories created", all(x["status"] == "created" for x in r["results"]), r)
finding_id = r["results"][0]["id"]

say("The writer recalls it — provenance says who learned it")
hits = writer.recall(query="rank fusion method")["memories"]
check("writer sees the researcher's finding", any(m["id"] == finding_id for m in hits), hits)
check(
    "the finding is attributed to the researcher",
    any(m["id"] == finding_id and m["source"] == "researcher" for m in hits),
    [(m["id"], m["source"]) for m in hits],
)

say("The writer contributes its own memory under its own source")
r = writer.ingest(
    [
        {
            "type": "event",
            "summary": "drafted the intro citing the rank fusion result",
            "content": {"doc": "intro"},
            "keywords": "draft intro rank fusion cited",
        }
    ]
)
check("writer memory created", r["results"][0]["status"] == "created", r)

say("Recall filters by source; unfiltered recall sees both agents")
only_research = researcher.recall(query="rank fusion", source="researcher")["memories"]
check(
    "source filter returns only researcher memories",
    bool(only_research) and all(m["source"] == "researcher" for m in only_research),
    only_research,
)
sources = {m["source"] for m in writer.recall(query="rank fusion")["memories"]}
check("unfiltered recall spans both sources", sources == {"researcher", "writer"}, sources)

say("The researcher revises the finding — the writer sees it instantly")
r = researcher.ingest(
    [
        {
            "type": "fact",
            "topic_key": "research.best_method",
            "summary": "rank fusion plus reranking beats every single channel",
            "content": {"basis": "eval run 9"},
            "keywords": "rank fusion reranking recall channel method best",
        }
    ]
)
check("revision superseded the original", r["results"][0].get("superseded") == [finding_id], r)
current = writer.recall(topic_key="research.best_method")["memories"]
check("writer's topic recall shows only the revision", len(current) == 1 and "reranking" in current[0]["summary"], current)
chain = writer.get(finding_id)
revision_id = current[0]["id"] if current else None
check("the original is still in the chain", chain is not None and chain.get("superseded_by") == revision_id, chain)

say("Shared transcript: both agents log to the same standup session")
standup = researcher.session("standup")
standup.append_turn("researcher", {"text": "eval run 9 done; reranking helps"})
writer.session("standup").append_turn("writer", {"text": "intro updated to cite run 9"})
window = standup.get_window(last=10)
check("both turns landed in order", [t.get("role") for t in window] == ["researcher", "writer"], window)

claude = llm()
if claude:
    say("LLM layer: the writer drafts a sentence grounded in shared memory")
    hits = writer.recall(query="rank fusion reranking method", k=4)["memories"]
    memories = "\n".join(f"- [{m['source']}] {m['summary']}" for m in hits)
    draft = complete(
        claude,
        f"You are the writer agent. The team's shared memory:\n{memories}\n"
        "Write one sentence for the paper intro grounded in it.",
        "Draft the sentence.",
    )
    note(f"writer> {draft}")
    check("writer produced a draft", bool(draft.strip()))
else:
    note("(ANTHROPIC_API_KEY unset — skipping the LLM draft layer)")

finish("multi-agent demo")
