"""Burner-branch what-if: fork the agent's whole mind, speculate, discard.

A profile is one database, so a fork is an O(1) copy-on-write branch of the
entire memory. The strategist forks a burner branch, runs a speculative
"what if we changed pricing" line of thought there — supersessions and all —
compares it against main, and throws the branch away. Main never knew.

Run against any node:  MEMOTURN_URL=... python3 demo.py
With ANTHROPIC_API_KEY set, Claude also writes the what-if memo comparing
the two timelines.
"""

from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from common import check, client, complete, finish, llm, note, say, unique_ns  # noqa: E402

mt = client(source="strategist")
ns = unique_ns("lab")
main = mt.memory(ns, "strategist")
db = mt.db(f"{ns}--strategist")
print(f"what-if demo · namespace {ns} · profile strategist")

say("Baseline on main: current pricing and last quarter's signal")
r = main.ingest(
    [
        {
            "type": "fact",
            "topic_key": "strategy.pricing",
            "summary": "flat pricing at ten dollars monthly",
            "content": {"model": "flat", "usd": 10},
            "keywords": "pricing flat monthly dollars",
        },
        {
            "type": "event",
            "summary": "Q2 revenue came in flat",
            "content": {"quarter": "Q2"},
            "keywords": "revenue quarter flat signal",
        },
    ]
)
check("baseline created", all(x["status"] == "created" for x in r["results"]), r)

say("Fork the whole mind into a burner branch (O(1), copy-on-write)")
burner = main.fork("what-if", ttl=3600)
branches = [b["branch"] for b in db.branch.list()]
check("the what-if branch exists", "what-if" in branches, branches)

say("The burner inherits everything main knew")
inherited = burner.recall(query="revenue quarter")["memories"]
check("burner recalls main's revenue event", any("Q2" in m["summary"] for m in inherited), inherited)

say("Speculate on the burner: new pricing supersedes, consequences accumulate")
r = burner.ingest(
    [
        {
            "type": "fact",
            "topic_key": "strategy.pricing",
            "summary": "usage based pricing per call",
            "content": {"model": "usage"},
            "keywords": "pricing usage based per call",
        }
    ]
)
check("speculative pricing superseded the flat plan on the branch", bool(r["results"][0].get("superseded")), r)
burner.ingest(
    [
        {
            "type": "event",
            "summary": "simulated churn rose five percent under usage pricing",
            "content": {"churn_delta": 0.05},
            "keywords": "simulated churn usage pricing",
        }
    ]
)

say("Compare the timelines: the branch changed, main did not")
on_burner = burner.recall(topic_key="strategy.pricing")["memories"]
check("burner believes usage-based", bool(on_burner) and "usage" in on_burner[0]["summary"], on_burner)
on_main = main.recall(topic_key="strategy.pricing")["memories"]
check("main still believes flat", bool(on_main) and "flat" in on_main[0]["summary"], on_main)
leaked = main.recall(query="simulated churn")["memories"]
check("the simulation never leaked to main", leaked == [], leaked)

claude = llm()
if claude:
    say("LLM layer: a what-if memo comparing the two timelines")
    memo = complete(
        claude,
        "You are a strategy analyst. Compare a baseline and a speculative timeline in 2-3 sentences.",
        f"Baseline: {[m['summary'] for m in on_main]} plus Q2 revenue flat.\n"
        f"What-if branch: {[m['summary'] for m in on_burner]} plus simulated churn +5%.",
    )
    note(f"analyst> {memo}")
    check("memo produced", bool(memo.strip()))
else:
    note("(ANTHROPIC_API_KEY unset — skipping the LLM memo layer)")

say("Discard the experiment: delete the burner, main is untouched")
db.branch.delete("what-if")
branches = [b["branch"] for b in db.branch.list()]
check("the branch is gone", "what-if" not in branches, branches)
on_main = main.recall(topic_key="strategy.pricing")["memories"]
check("main is unchanged after the discard", bool(on_main) and "flat" in on_main[0]["summary"], on_main)

finish("what-if demo")
