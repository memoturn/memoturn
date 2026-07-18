"""Drop-in wrapper for a QdrantClient. Records each client.search() and
client.query_points() call as a RETRIEVER span."""
from __future__ import annotations

import json
from typing import Any, Callable, Optional

from ._stream import _get
from .client import Memoturn, Trace
from .decorator import get_client

_MAX_CONTENT_LEN = 16 * 1024  # matches packages/core/src/events.ts MAX_MESSAGE_LEN
_MAX_EMBEDDING_DIM = 4096  # matches packages/core/src/events.ts MAX_EMBEDDING_DIM

GetContent = Callable[[Any], Optional[str]]


def _default_get_content(point: Any) -> Optional[str]:
    """Best-effort text extractor: tries common text-ish payload keys, falling back to
    the stringified payload blob (never empty — content is required) if none match."""
    payload = _get(point, "payload")
    if payload is None:
        return None
    for key in ("text", "content", "page_content"):
        value = payload.get(key) if isinstance(payload, dict) else _get(payload, key)
        if isinstance(value, str) and value:
            return value
    try:
        return json.dumps(payload, default=str)
    except Exception:  # noqa: BLE001
        return None


def _points(resp: Any) -> list:
    """search() returns a bare list of scored points; query_points() returns a
    QueryResponse whose .points holds them."""
    if isinstance(resp, list):
        return resp
    points = _get(resp, "points")
    return points if isinstance(points, list) else []


def _retrieved_documents(points: Any, get_content: GetContent) -> list:
    docs = []
    for rank, point in enumerate(points or []):
        content = (get_content(point) or _default_get_content(point) or "")[:_MAX_CONTENT_LEN]
        pid = _get(point, "id")
        docs.append({"rank": rank, "id": str(pid) if pid is not None else None,
                      "score": _get(point, "score"), "content": content, "metadata": _get(point, "payload")})
    return docs


def _embedding(kwargs: dict) -> Optional[list]:
    """search() takes query_vector=, query_points() takes query= (which may also be a
    point id or recommend/fusion query object — only flat float vectors are recorded)."""
    vector = kwargs.get("query_vector", kwargs.get("query"))
    if isinstance(vector, list) and vector and all(isinstance(v, (int, float)) for v in vector):
        return vector[:_MAX_EMBEDDING_DIM]
    return None


def wrap_qdrant(client: Any, memoturn: Optional[Memoturn] = None, *, trace: Optional[Trace] = None,
                 get_content: Optional[GetContent] = None) -> Any:
    """Patch client.search and client.query_points (whichever exist) to trace calls as
    RETRIEVER spans. Returns the same client. content is extracted best-effort from
    each point's payload (text/content/page_content, else stringified payload) — pass
    get_content= to override for a non-standard schema."""
    mt = memoturn or get_client()
    gc = get_content or _default_get_content

    def _wrap(method: str, original: Callable[..., Any]) -> Callable[..., Any]:
        def patched(*args: Any, **kwargs: Any) -> Any:
            name = f"qdrant.{method}"
            t = trace or mt.trace(name=name)
            span = t.span(name=name, observationType="RETRIEVER",
                           metadata={"collection": kwargs.get("collection_name"), "limit": kwargs.get("limit"),
                                     "filter": kwargs.get("query_filter")},
                           embedding=_embedding(kwargs))
            try:
                resp = original(*args, **kwargs)
                docs = _retrieved_documents(_points(resp), gc)
                span.end(retrievedDocuments=docs, output=f"{len(docs)} document(s)")
                return resp
            except Exception as e:  # noqa: BLE001
                span.end(level="ERROR", statusMessage=str(e))
                raise

        return patched

    for method in ("search", "query_points"):
        original = getattr(client, method, None)
        if callable(original):
            setattr(client, method, _wrap(method, original))
    return client
