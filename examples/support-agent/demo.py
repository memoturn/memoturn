"""Customer support agent: one namespace per company, one profile per customer.

The support story in five beats: the agent knows the customer before the
ticket opens, tracks the ticket as a task + a status fact, *supersedes* the
status when the ticket resolves (history preserved, recall shows the truth),
closes out the session, and never leaks one customer's memory into another's.

Run against any node:  MEMOTURN_URL=... python3 demo.py
With ANTHROPIC_API_KEY set, the agent also answers a customer question
grounded in its recall.
"""

from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from common import check, client, complete, finish, llm, note, say, unique_ns  # noqa: E402

mt = client(source="support-agent")
ns = unique_ns("acmesupport")
carol = mt.memory(ns, "carol")
dave = mt.memory(ns, "dave")
print(f"support-agent demo · namespace {ns} · profiles carol, dave")

say("Onboard carol: the agent learns her plan and environment")
r = carol.ingest(
    [
        {
            "type": "fact",
            "topic_key": "customer.plan",
            "summary": "on the Pro plan",
            "content": {"plan": "pro"},
            "keywords": "plan tier subscription pro",
        },
        {
            "type": "fact",
            "topic_key": "customer.env",
            "summary": "runs self-hosted on Kubernetes",
            "content": {"deploy": "k8s"},
            "keywords": "kubernetes self-hosted environment deploy",
        },
    ]
)
check("both facts created", all(x["status"] == "created" for x in r["results"]), r)

say("Ticket T-1001 opens: a task to follow up, and a status fact")
r = carol.ingest(
    [
        {
            "type": "task",
            "summary": "T-1001 follow up on webhook timeouts",
            "content": {"ticket": "T-1001"},
            "keywords": "ticket webhook timeout follow",
            "session_id": "t-1001",
        },
        {
            "type": "fact",
            "topic_key": "ticket.t-1001.status",
            "summary": "T-1001 open: webhook timeouts under investigation",
            "content": {"ticket": "T-1001", "status": "open"},
            "keywords": "ticket webhook timeout status open",
        },
    ]
)
check("ticket memories created", all(x["status"] == "created" for x in r["results"]), r)
open_id = r["results"][1]["id"]

say("Resolution: the new status fact SUPERSEDES the open one (same topic_key)")
r = carol.ingest(
    [
        {
            "type": "fact",
            "topic_key": "ticket.t-1001.status",
            "summary": "T-1001 resolved: webhook timeout raised to 30s",
            "content": {"ticket": "T-1001", "status": "resolved"},
            "keywords": "ticket webhook timeout status resolved",
        }
    ]
)
check("resolution superseded the open status", r["results"][0].get("superseded") == [open_id], r)
resolved_id = r["results"][0]["id"]

say("Recall shows only the current truth; the chain preserves history")
by_topic = carol.recall(topic_key="ticket.t-1001.status")["memories"]
check("topic recall returns exactly the resolved status", [m["id"] for m in by_topic] == [resolved_id], by_topic)
by_query = carol.recall(query="webhook timeout status")["memories"]
check("query recall's top hit is the resolution", bool(by_query) and "resolved" in by_query[0]["summary"], by_query)
check("the open status is hidden from recall", all(m["id"] != open_id for m in by_query), by_query)
chain = carol.get(open_id)
check("history preserved: open → resolved chain", chain is not None and chain.get("superseded_by") == resolved_id, chain)

say("Close out: ending the ticket session expires its task")
carol.end_session("t-1001")
check("no sessions remain", carol.sessions() == [], carol.sessions())
tasks = carol.recall(query="webhook follow", types=["task"])["memories"]
check("the follow-up task is gone", tasks == [], tasks)

say("Isolation: dave's profile is a different database entirely")
dave.ingest(
    [
        {
            "type": "fact",
            "topic_key": "customer.plan",
            "summary": "on the Free plan",
            "content": {"plan": "free"},
            "keywords": "plan tier subscription free",
        }
    ]
)
carol_plan = carol.recall(topic_key="customer.plan")["memories"]
check("carol's plan is still Pro", bool(carol_plan) and "Pro" in carol_plan[0]["summary"], carol_plan)

claude = llm()
if claude:
    say("LLM layer: answer carol's question grounded in her memories")
    hits = carol.recall(query="webhook timeout status ticket", k=6)["memories"]
    memories = "\n".join(f"- [{m['type']}] {m['summary']}" for m in hits)
    answer = complete(
        claude,
        f"You are acme's support agent. What you know about this customer:\n{memories}\n"
        "Answer from these memories; be concise.",
        "What's the status of my webhook issue?",
    )
    note(f"agent> {answer}")
    check("agent produced an answer", bool(answer.strip()))
else:
    note("(ANTHROPIC_API_KEY unset — skipping the LLM answer layer)")

finish("support-agent demo")
