"""A chat agent whose memory lives in Memoturn.

The full product loop in ~200 lines:

  1. Before answering, the agent RECALLS relevant memories from the user's
     profile and injects them into the system prompt.
  2. It answers with the Claude API.
  3. After each exchange it EXTRACTS new typed memories — server-side via
     POST /extract when the node has MEMOTURN_EXTRACT_API_KEY, otherwise
     client-side with the same Claude structured-outputs call.
  4. The transcript is appended verbatim; memories supersede by topic.

Because a profile is one database, the agent's whole mind is operable:

  /checkpoint <name>   snapshot the mind
  /rewind <name>       restore it (forget everything since)
  /memories            show what it knows (active, ranked by recency)
  /ask <question>      ask the memory directly (server-side answer synthesis,
                       needs MEMOTURN_ASSISTANT_API_KEY on the node)
  /remember <json>     ingest one memory object directly (no LLM involved)
  /expect <substring> :: <query>
                       assert recall(query) mentions substring — turns a
                       piped script into an e2e check (exit 1 on any miss)
  /quit

Restart the script — it still remembers. That's the pitch.

Pipe a script for a non-interactive run (see script.txt, used by
examples/run_e2e.py):  python agent.py demo alice < script.txt

Env: ANTHROPIC_API_KEY (optional — without it, chat replies degrade to the
     raw recall results and extraction only runs server-side),
     MEMOTURN_URL (default :8080), MEMOTURN_TOKEN (when the node has auth on),
     MEMORY_AGENT_MODEL (default claude-opus-4-8).
Usage: python agent.py [namespace] [profile]      (default: demo alice)
"""

from __future__ import annotations

import json
import os
import sys
import uuid

import anthropic

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "sdk", "python"))
from memoturn import Memoturn, MemoturnError  # noqa: E402

MODEL = os.environ.get("MEMORY_AGENT_MODEL", "claude-opus-4-8")

EXTRACTION_SCHEMA = {
    "type": "object",
    "properties": {
        "memories": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "type": {"type": "string", "enum": ["fact", "event", "instruction", "task"]},
                    "topic_key": {"type": ["string", "null"]},
                    "summary": {"type": "string"},
                    "details": {"type": "string"},
                    "keywords": {"type": "string"},
                },
                "required": ["type", "topic_key", "summary", "details", "keywords"],
                "additionalProperties": False,
            },
        }
    },
    "required": ["memories"],
    "additionalProperties": False,
}

EXTRACTION_PROMPT = (
    "You distill conversation transcripts into typed agent memories. "
    "fact/instruction carry a stable dot-namespaced topic_key (newer supersedes older); "
    "events accumulate (topic_key null); tasks are short-lived follow-ups (topic_key null). "
    "Be selective — small talk is not a memory. An empty list is a correct answer."
)


def recall_block(profile, user_message: str) -> str:
    """Fetch relevant memories and render them for the system prompt."""
    hits = profile.recall(query=user_message, k=6)["memories"]
    if not hits:
        return "(no stored memories matched)"
    lines = [
        f"- [{m['type']}] {m['summary']}" + (f"  (topic: {m['topic_key']})" if m["topic_key"] else "")
        for m in hits
    ]
    return "\n".join(lines)


def extract_memories(profile, claude, turns: list[dict], session_id: str) -> list[str]:
    """Server-side /extract when the node supports it; otherwise the same
    structured-outputs call client-side, fed through ordinary ingest."""
    try:
        results = profile.extract(turns, session_id=session_id)["results"]
        return [r["id"] for r in results if r["status"] == "created"]
    except MemoturnError as e:
        if e.status != 503:
            raise
    if claude is None:  # no node extractor and no client key — nothing to extract with
        return []
    # Client-side fallback: Claude structured outputs guarantee schema-valid JSON.
    transcript = "\n".join(f"{t['role']}: {t['content']}" for t in turns)
    response = claude.messages.create(
        model=MODEL,
        max_tokens=16000,
        system=EXTRACTION_PROMPT,
        messages=[{"role": "user", "content": f"Extract memories:\n\n{transcript}"}],
        output_config={"format": {"type": "json_schema", "schema": EXTRACTION_SCHEMA}},
    )
    text = next(b.text for b in response.content if b.type == "text")
    proposed = json.loads(text)["memories"]
    if not proposed:
        return []
    results = profile.ingest(
        [
            {
                "type": m["type"],
                **(
                    {"topic_key": m["topic_key"]}
                    if m["topic_key"] and m["type"] in ("fact", "instruction")
                    else {}
                ),
                "summary": m["summary"],
                "content": {"text": m["details"]},
                "keywords": m["keywords"],
                "session_id": session_id,
            }
            for m in proposed
        ]
    )["results"]
    return [r["id"] for r in results if r["status"] == "created"]


def main() -> None:
    ns = sys.argv[1] if len(sys.argv) > 1 else "demo"
    user = sys.argv[2] if len(sys.argv) > 2 else "alice"
    mt = Memoturn(
        os.environ.get("MEMOTURN_URL", "http://127.0.0.1:8080"),
        token=os.environ.get("MEMOTURN_TOKEN"),
        # Provenance: every memory this agent writes is attributed to it, so
        # other agents sharing the profile can filter recall by source.
        source="memory-agent",
    )
    profile = mt.memory(ns, user)
    claude = anthropic.Anthropic() if os.environ.get("ANTHROPIC_API_KEY") else None
    session_id = f"s-{uuid.uuid4().hex[:8]}"
    history: list[dict] = []
    interactive = sys.stdin.isatty()
    expect_failures = 0

    print(f"memory-agent · profile {ns}/{user} · session {session_id}")
    if claude is None:
        print("(no ANTHROPIC_API_KEY — replies degrade to raw recall results)")
    print(
        "commands: /memories /ask <q> /remember <json> /expect <s> :: <q> "
        "/checkpoint <name> /rewind <name> /quit\n"
    )

    while True:
        try:
            user_message = input("you> " if interactive else "").strip()
        except (EOFError, KeyboardInterrupt):
            break
        if not user_message or user_message.startswith("#"):
            continue
        if not interactive:
            print(f"you> {user_message}")  # echo piped input so the run reads like a session

        if user_message == "/quit":
            break
        if user_message == "/memories":
            hits = profile.recall(query="everything you know", k=20, include_superseded=False)
            for m in hits["memories"]:
                print(f"  [{m['type']}] {m['summary']}")
            if not hits["memories"]:
                print(
                    "  (none matched — without MEMOTURN_EMBED_API_KEY on the node, "
                    "recall needs keyword overlap with the stored memories)"
                )
            continue
        if user_message.startswith("/remember "):
            try:
                memory = json.loads(user_message.split(" ", 1)[1])
            except json.JSONDecodeError as e:
                print(f"  bad JSON: {e}")
                continue
            result = profile.ingest([memory])["results"][0]
            line = f"  {result['status']} {result['id']}"
            if result.get("superseded"):
                line += f" — superseded {', '.join(result['superseded'])}"
            print(line)
            continue
        if user_message.startswith("/expect "):
            needle, sep, query = user_message[len("/expect ") :].partition(" :: ")
            if not sep:
                print("  usage: /expect <substring> :: <query>")
                continue
            needle, query = needle.strip(), query.strip()
            hits = profile.recall(query=query, k=8)["memories"]
            if any(needle in m["summary"] for m in hits):
                print(f"  ok — recall('{query}') mentions '{needle}'")
            else:
                expect_failures += 1
                print(
                    f"  FAIL — recall('{query}') has no '{needle}': "
                    f"{[m['summary'] for m in hits]}"
                )
            continue
        if user_message.startswith("/ask "):
            question = user_message.split(" ", 1)[1]
            try:
                asked = profile.ask(question)
                if asked["answer"] is None:
                    print("  (no matching memories)")
                else:
                    print(f"  {asked['answer']}")
                    if asked["sources"]:
                        print(f"  sources: {', '.join(asked['sources'])}")
            except MemoturnError as e:
                if e.status != 503:
                    raise
                print("  (node has no assistant — set MEMOTURN_ASSISTANT_API_KEY on it)")
            continue
        if user_message.startswith("/checkpoint "):
            name = user_message.split(" ", 1)[1]
            profile.checkpoint(name)
            print(f"  mind checkpointed as '{name}'")
            continue
        if user_message.startswith("/rewind "):
            name = user_message.split(" ", 1)[1]
            profile.rewind(name)
            history.clear()
            print(f"  mind rewound to '{name}' — everything since is forgotten")
            continue

        # 1. Recall → 2. answer with the memories in context.
        memories = recall_block(profile, user_message)
        history.append({"role": "user", "content": user_message})
        if claude is None:
            reply = f"(no LLM key — what I recalled for that:\n{memories})"
        else:
            response = claude.messages.create(
                model=MODEL,
                max_tokens=16000,
                thinking={"type": "adaptive"},
                system=(
                    f"You are a personal assistant for one user. What you remember about them "
                    f"from prior conversations:\n{memories}\n\n"
                    f"Use these memories naturally; don't recite them. Be concise."
                ),
                messages=history,
            )
            reply = next(b.text for b in response.content if b.type == "text")
        history.append({"role": "assistant", "content": reply})
        print(f"agent> {reply}\n")

        # 3. Persist the verbatim turns + extract typed memories.
        transcript = profile.session(session_id)
        transcript.append_turn("user", {"text": user_message})
        transcript.append_turn("assistant", {"text": reply})
        new_ids = extract_memories(
            profile,
            claude,
            [
                {"role": "user", "content": user_message},
                {"role": "assistant", "content": reply},
            ],
            session_id,
        )
        if new_ids:
            print(f"  ({len(new_ids)} new memor{'y' if len(new_ids) == 1 else 'ies'} stored)\n")

    if expect_failures:
        print(f"\n{expect_failures} /expect check(s) FAILED")
        sys.exit(1)


if __name__ == "__main__":
    main()
