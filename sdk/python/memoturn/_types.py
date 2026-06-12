"""Typed shapes for request results. TypedDicts, not dataclasses: results are
plain dicts at runtime (``hit["summary"]`` keeps working) — the types exist
for IDEs and type checkers."""

from __future__ import annotations

from typing import Any, List, Optional, TypedDict

__all__ = [
    "Memory",
    "RecallResult",
    "IngestItem",
    "IngestResult",
    "AskResult",
    "Turn",
    "TurnAppendResult",
    "ErasureCoupon",
]


class Memory(TypedDict, total=False):
    id: str
    type: str
    topic_key: Optional[str]
    summary: str
    content: Any
    keywords: Optional[str]
    session_id: Optional[str]
    source: Optional[str]
    created_at: int
    superseded_by: Optional[str]
    # Recall only: fused relevance score and contributing channels.
    score: float
    channels: List[str]
    # get() only: ids this memory superseded.
    supersedes: List[str]


class RecallResult(TypedDict, total=False):
    memories: List[Memory]
    turns: List["Turn"]
    txid: int


class IngestItem(TypedDict, total=False):
    id: str
    status: str  # "created" | "duplicate"
    superseded: List[str]


class IngestResult(TypedDict, total=False):
    results: List[IngestItem]
    txid: int


class AskResult(TypedDict, total=False):
    answer: Optional[str]
    sources: List[str]
    memories: List[Memory]
    txid: int


class Turn(TypedDict, total=False):
    session_id: str
    seq: int
    role: str
    content: Any
    distance: float


class TurnAppendResult(TypedDict, total=False):
    seq: int
    txid: int


class ErasureCoupon(TypedDict, total=False):
    id: str
    status: str  # "pending" | "completed"
    target: Any
    requested_at: int
    completed_at: Optional[int]
    receipt: Any
