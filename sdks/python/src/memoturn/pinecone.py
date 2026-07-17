"""Drop-in wrapper for a Pinecone data-plane index handle (pc.Index(name)) — NOT the
control-plane Pinecone client. Records each index.query() call as a RETRIEVER span."""
from __future__ import annotations

import json
from typing import Any, Callable, Optional

from ._stream import _get
from .client import Memoturn, Trace
from .decorator import get_client

_MAX_CONTENT_LEN = 16 * 1024  # matches packages/core/src/events.ts MAX_MESSAGE_LEN
_MAX_EMBEDDING_DIM = 4096  # matches packages/core/src/events.ts MAX_EMBEDDING_DIM

GetContent = Callable[[Any], Optional[str]]


def _default_get_content(match: Any) -> Optional[str]:
    """Best-effort text extractor: tries common metadata keys RAG frameworks use for raw
    chunk text, falling back to the stringified metadata blob (never empty — content is
    required) if none match."""
    metadata = _get(match, "metadata")
    if metadata is None:
        return None
    for key in ("text", "content", "page_content"):
        value = metadata.get(key) if isinstance(metadata, dict) else _get(metadata, key)
        if isinstance(value, str) and value:
            return value
    try:
        return json.dumps(metadata, default=str)
    except Exception:  # noqa: BLE001
        return None


def _retrieved_documents(matches: Any, get_content: GetContent) -> list:
    docs = []
    for rank, match in enumerate(matches or []):
        content = (get_content(match) or _default_get_content(match) or "")[:_MAX_CONTENT_LEN]
        mid = _get(match, "id")
        docs.append({"rank": rank, "id": str(mid) if mid is not None else None,
                      "score": _get(match, "score"), "content": content, "metadata": _get(match, "metadata")})
    return docs


def wrap_pinecone(index: Any, memoturn: Optional[Memoturn] = None, *, trace: Optional[Trace] = None,
                   get_content: Optional[GetContent] = None) -> Any:
    """Patch index.query to trace calls as RETRIEVER spans. Returns the same index.
    content is extracted best-effort from metadata (text/content/page_content, else
    stringified metadata) — pass get_content= to override for a non-standard schema."""
    mt = memoturn or get_client()
    gc = get_content or _default_get_content
    original = index.query

    def query(*args: Any, **kwargs: Any) -> Any:
        t = trace or mt.trace(name="pinecone.query")
        vector = kwargs.get("vector")
        embedding = vector[:_MAX_EMBEDDING_DIM] if isinstance(vector, list) else None
        extra_meta = {k: v for k, v in kwargs.items()
                      if k not in ("vector", "top_k", "filter", "namespace", "include_metadata", "include_values")}
        span = t.span(name="pinecone.query", observationType="RETRIEVER",
                       metadata={"namespace": kwargs.get("namespace"), "topK": kwargs.get("top_k"),
                                 "filter": kwargs.get("filter"), **extra_meta},
                       embedding=embedding)
        try:
            resp = original(*args, **kwargs)
            matches = _get(resp, "matches", []) or []
            span.end(retrievedDocuments=_retrieved_documents(matches, gc), output=f"{len(matches)} document(s)")
            return resp
        except Exception as e:  # noqa: BLE001
            span.end(level="ERROR", statusMessage=str(e))
            raise

    index.query = query  # type: ignore[assignment]
    return index
