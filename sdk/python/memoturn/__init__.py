"""Memoturn Python SDK — memory for AI agents.

The headline surface is agent memory (docs/architecture/07): typed memories
with supersession and hybrid recall, organized ``namespace > profile > memory``
where a profile is one Memoturn database every agent serving that user shares.
The multi-model substrate (docs/KV/SQL/vectors/transcript, branching) is
exposed on ``db()``.

    from memoturn import Memoturn

    mt = Memoturn(url="http://127.0.0.1:8080", token=token)
    alice = mt.memory("acme", "alice")
    alice.ingest([{"type": "fact", "topic_key": "user.diet",
                   "summary": "vegetarian since 2024",
                   "content": {"diet": "vegetarian"}}])
    hits = alice.recall(query="what can this user eat?")

Async agents use the twin client:

    from memoturn import AsyncMemoturn

    async with AsyncMemoturn(url, token=token) as mt:
        hits = await mt.memory("acme", "alice").recall(query="…")

Lookups by id (``get``/``erasure``/``kv.get``) return ``None`` on 404 and
``forget`` returns ``False``; every other failure raises
:class:`MemoturnError` with ``.status`` and a stable machine-readable
``.code`` (``branch_not_found``, ``unconfigured``, ``overloaded``, …).
"""

from ._async import (
    AsyncCollection,
    AsyncDb,
    AsyncMemoryProfile,
    AsyncMemoturn,
    AsyncTranscriptSession,
)
from ._errors import MemoturnError
from ._sync import Collection, Db, MemoryProfile, Memoturn, TranscriptSession
from ._types import (
    AskResult,
    ErasureCoupon,
    IngestResult,
    Memory,
    RecallResult,
    Turn,
    TurnAppendResult,
)

__all__ = [
    "Memoturn",
    "MemoryProfile",
    "TranscriptSession",
    "Collection",
    "Db",
    "AsyncMemoturn",
    "AsyncMemoryProfile",
    "AsyncTranscriptSession",
    "AsyncCollection",
    "AsyncDb",
    "MemoturnError",
    "Memory",
    "RecallResult",
    "IngestResult",
    "AskResult",
    "Turn",
    "TurnAppendResult",
    "ErasureCoupon",
]
