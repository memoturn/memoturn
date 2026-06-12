"""Shared plumbing for the runnable examples.

Each example under examples/ is both a narrated demo and an e2e check: it
prints what it's doing step by step, asserts the outcomes, and exits nonzero
on any failure. They all run against the node at MEMOTURN_URL (default
http://127.0.0.1:8080) — `examples/run_e2e.py` spawns one if none is up.

The LLM layer is optional everywhere: with ANTHROPIC_API_KEY set, demos add
real Claude calls on top; without it, every deterministic assertion still runs.
"""

from __future__ import annotations

import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "sdk", "python"))
from memoturn import Memoturn, MemoturnError  # noqa: E402,F401

LLM_MODEL = os.environ.get("MEMORY_AGENT_MODEL", "claude-opus-4-8")

_step = 0
_checks = 0
_failures = 0


def client(source: str | None = None) -> Memoturn:
    """A client for the node under demo; credentials only matter with auth on."""
    return Memoturn(
        os.environ.get("MEMOTURN_URL", "http://127.0.0.1:8080"),
        token=os.environ.get("MEMOTURN_TOKEN"),
        platform_key=os.environ.get("MEMOTURN_PLATFORM_KEY"),
        source=source,
    )


def unique_ns(prefix: str) -> str:
    """Time-suffixed namespace so re-runs never collide with old state."""
    return f"{prefix}{int(time.time()) % 100000}"


def say(text: str) -> None:
    global _step
    _step += 1
    print(f"\n{_step}. {text}")


def note(text: str) -> None:
    print(f"   {text}")


def check(label: str, cond: bool, detail=None) -> None:
    global _checks, _failures
    _checks += 1
    if cond:
        print(f"   ok   {label}")
    else:
        _failures += 1
        print(f"   FAIL {label}" + (f" — {detail}" if detail is not None else ""))


def llm():
    """An Anthropic client when ANTHROPIC_API_KEY is set, else None."""
    if not os.environ.get("ANTHROPIC_API_KEY"):
        return None
    import anthropic

    return anthropic.Anthropic()


def complete(claude, system: str, prompt: str) -> str:
    """One short Claude completion for the optional LLM layers."""
    response = claude.messages.create(
        model=LLM_MODEL,
        max_tokens=2048,
        system=system,
        messages=[{"role": "user", "content": prompt}],
    )
    return next(b.text for b in response.content if b.type == "text")


def finish(name: str) -> None:
    if _failures:
        print(f"\n{name}: {_failures}/{_checks} checks FAILED")
        sys.exit(1)
    print(f"\n{name}: all {_checks} checks passed")
