"""Drop-in wrapper for a Chroma collection handle (client.get_or_create_collection(name)).
Records each collection.query() call as a RETRIEVER span."""
from __future__ import annotations

import json
from typing import Any, Callable, Optional

from ._stream import _get
from .client import Memoturn, Trace
from .decorator import get_client

_MAX_CONTENT_LEN = 16 * 1024  # matches packages/core/src/events.ts MAX_MESSAGE_LEN
_MAX_EMBEDDING_DIM = 4096  # matches packages/core/src/events.ts MAX_EMBEDDING_DIM

GetContent = Callable[[Any], Optional[str]]


def _default_get_content(result: Any) -> Optional[str]:
    """Best-effort text extractor: Chroma results usually carry the raw chunk in
    ``documents`` — use it when present, else try common metadata keys, else fall back
    to the stringified metadata blob (never empty — content is required)."""
    document = _get(result, "document")
    if isinstance(document, str) and document:
        return document
    metadata = _get(result, "metadata")
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


def _first(columns: Any) -> list:
    """Chroma query responses are columnar arrays-of-arrays (one inner list per query
    embedding/text); take the first query's column, defensively."""
    if isinstance(columns, (list, tuple)) and columns and isinstance(columns[0], (list, tuple)):
        return list(columns[0])
    return []


def _retrieved_documents(resp: Any, get_content: GetContent) -> list:
    ids = _first(_get(resp, "ids"))
    distances = _first(_get(resp, "distances"))
    documents = _first(_get(resp, "documents"))
    metadatas = _first(_get(resp, "metadatas"))
    docs = []
    for rank, rid in enumerate(ids):
        distance = distances[rank] if rank < len(distances) else None
        result = {
            "id": rid,
            "distance": distance,
            "document": documents[rank] if rank < len(documents) else None,
            "metadata": metadatas[rank] if rank < len(metadatas) else None,
        }
        content = (get_content(result) or _default_get_content(result) or "")[:_MAX_CONTENT_LEN]
        score = 1 - distance if isinstance(distance, (int, float)) else None
        docs.append({"rank": rank, "id": str(rid) if rid is not None else None,
                      "score": score, "content": content, "metadata": result["metadata"]})
    return docs


def _embedding(query_embeddings: Any) -> Optional[list]:
    """query_embeddings may be one vector or a list of vectors; record the first."""
    if not isinstance(query_embeddings, list) or not query_embeddings:
        return None
    first = query_embeddings[0]
    vector = first if isinstance(first, list) else query_embeddings
    return vector[:_MAX_EMBEDDING_DIM] if all(isinstance(v, (int, float)) for v in vector) else None


def wrap_chroma(collection: Any, memoturn: Optional[Memoturn] = None, *, trace: Optional[Trace] = None,
                 get_content: Optional[GetContent] = None) -> Any:
    """Patch collection.query to trace calls as RETRIEVER spans. Returns the same
    collection. content comes from the result's ``documents`` entry when present, else
    metadata keys (text/content/page_content), else stringified metadata — pass
    get_content= (receives {id, distance, document, metadata}) to override."""
    mt = memoturn or get_client()
    gc = get_content or _default_get_content
    original = collection.query

    def query(*args: Any, **kwargs: Any) -> Any:
        t = trace or mt.trace(name="chroma.query")
        extra_meta = {k: v for k, v in kwargs.items()
                      if k not in ("query_embeddings", "query_texts", "n_results", "where", "where_document",
                                   "include")}
        span = t.span(name="chroma.query", observationType="RETRIEVER",
                       metadata={"nResults": kwargs.get("n_results"), "where": kwargs.get("where"),
                                 "queryTexts": kwargs.get("query_texts"), **extra_meta},
                       embedding=_embedding(kwargs.get("query_embeddings")))
        try:
            resp = original(*args, **kwargs)
            docs = _retrieved_documents(resp, gc)
            span.end(retrievedDocuments=docs, output=f"{len(docs)} document(s)")
            return resp
        except Exception as e:  # noqa: BLE001
            span.end(level="ERROR", statusMessage=str(e))
            raise

    collection.query = query  # type: ignore[assignment]
    return collection
