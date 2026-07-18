"""Drop-in wrapper for a weaviate-client v4 collection handle (client.collections.get(name)).
Records each collection.query.<method>() retrieval call as a RETRIEVER span."""
from __future__ import annotations

import json
from typing import Any, Callable, Optional

from ._stream import _get
from .client import Memoturn, Trace
from .decorator import get_client

_MAX_CONTENT_LEN = 16 * 1024  # matches packages/core/src/events.ts MAX_MESSAGE_LEN
_MAX_EMBEDDING_DIM = 4096  # matches packages/core/src/events.ts MAX_EMBEDDING_DIM

_QUERY_METHODS = ("near_vector", "near_text", "hybrid", "bm25", "fetch_objects")

GetContent = Callable[[Any], Optional[str]]


def _default_get_content(obj: Any) -> Optional[str]:
    """Best-effort text extractor: tries common text-ish property keys, falling back to
    the stringified properties blob (never empty — content is required) if none match."""
    properties = _get(obj, "properties")
    if properties is None:
        return None
    for key in ("text", "content", "page_content"):
        value = properties.get(key) if isinstance(properties, dict) else _get(properties, key)
        if isinstance(value, str) and value:
            return value
    try:
        return json.dumps(properties, default=str)
    except Exception:  # noqa: BLE001
        return None


def _score(obj: Any) -> Optional[float]:
    """weaviate metadata carries score (hybrid/bm25), certainty, or distance depending
    on the query type; normalize to a single higher-is-better score."""
    metadata = _get(obj, "metadata")
    if metadata is None:
        return None
    score = _get(metadata, "score")
    if isinstance(score, (int, float)):
        return score
    certainty = _get(metadata, "certainty")
    if isinstance(certainty, (int, float)):
        return certainty
    distance = _get(metadata, "distance")
    return 1 - distance if isinstance(distance, (int, float)) else None


def _retrieved_documents(objects: Any, get_content: GetContent) -> list:
    docs = []
    for rank, obj in enumerate(objects or []):
        content = (get_content(obj) or _default_get_content(obj) or "")[:_MAX_CONTENT_LEN]
        uuid = _get(obj, "uuid")
        docs.append({"rank": rank, "id": str(uuid) if uuid is not None else None,
                      "score": _score(obj), "content": content, "metadata": _get(obj, "properties")})
    return docs


def _embedding(method: str, args: tuple, kwargs: dict) -> Optional[list]:
    vector = kwargs.get("near_vector") if method == "near_vector" else kwargs.get("vector")
    if vector is None and method == "near_vector" and args:
        vector = args[0]
    if isinstance(vector, list) and vector and all(isinstance(v, (int, float)) for v in vector):
        return vector[:_MAX_EMBEDDING_DIM]
    return None


def _query_text(method: str, args: tuple, kwargs: dict) -> Optional[str]:
    if method not in ("near_text", "hybrid", "bm25"):
        return None
    query = kwargs.get("query")
    if query is None and args:
        query = args[0]
    return query if isinstance(query, str) else None


def wrap_weaviate(collection: Any, memoturn: Optional[Memoturn] = None, *, trace: Optional[Trace] = None,
                   get_content: Optional[GetContent] = None) -> Any:
    """Patch the retrieval methods on collection.query (near_vector/near_text/hybrid/
    bm25/fetch_objects — whichever exist) to trace calls as RETRIEVER spans. Returns
    the same collection. content is extracted best-effort from each object's
    properties (text/content/page_content, else stringified properties) — pass
    get_content= to override for a non-standard schema."""
    mt = memoturn or get_client()
    gc = get_content or _default_get_content
    query_ns = getattr(collection, "query", None)
    if query_ns is None:
        return collection

    def _wrap(method: str, original: Callable[..., Any]) -> Callable[..., Any]:
        def patched(*args: Any, **kwargs: Any) -> Any:
            name = f"weaviate.{method}"
            t = trace or mt.trace(name=name)
            span = t.span(name=name, observationType="RETRIEVER",
                           metadata={"limit": kwargs.get("limit"), "query": _query_text(method, args, kwargs)},
                           embedding=_embedding(method, args, kwargs))
            try:
                resp = original(*args, **kwargs)
                docs = _retrieved_documents(_get(resp, "objects", []) or [], gc)
                span.end(retrievedDocuments=docs, output=f"{len(docs)} document(s)")
                return resp
            except Exception as e:  # noqa: BLE001
                span.end(level="ERROR", statusMessage=str(e))
                raise

        return patched

    for method in _QUERY_METHODS:
        original = getattr(query_ns, method, None)
        if callable(original):
            setattr(query_ns, method, _wrap(method, original))
    return collection
