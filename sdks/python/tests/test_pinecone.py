"""wrap_pinecone records index.query() calls as RETRIEVER spans. Wraps the data-plane
index handle (pc.Index(name)) — NOT the control-plane Pinecone client."""
from __future__ import annotations

from types import SimpleNamespace

import pytest
from conftest import Capture

from memoturn import Memoturn, wrap_pinecone

CREDS = dict(base_url="http://api.test", public_key="pk-mt-x", secret_key="sk-mt-y", flush_at=1000)


def _find(batch: list[dict], type_: str) -> dict:
    return next(e for e in batch if e["type"] == type_)


def _fake_index(query, **extra) -> SimpleNamespace:
    return SimpleNamespace(query=query, **extra)


def _match(id_: str = "id1", score: float = 0.9, metadata: dict | None = None) -> SimpleNamespace:
    return SimpleNamespace(id=id_, score=score, metadata=metadata)


def _response(matches: list | None = None) -> SimpleNamespace:
    return SimpleNamespace(matches=matches or [])


def test_records_retriever_span_with_recognized_content_key(capture: Capture) -> None:
    mt = Memoturn(**CREDS)
    match = _match(metadata={"content": "hello world"})
    resp = _response([match])
    index = _fake_index(query=lambda **kw: resp)
    wrap_pinecone(index, mt)

    res = index.query(vector=[0.1, 0.2], top_k=5, namespace="prod")
    assert res is resp
    mt.flush()

    batch = capture.batch()
    create = _find(batch, "span-create")
    update = _find(batch, "span-update")
    assert create["body"]["name"] == "pinecone.query"
    assert create["body"]["observationType"] == "RETRIEVER"
    assert create["body"]["metadata"] == {"namespace": "prod", "topK": 5, "filter": None}
    assert create["body"]["embedding"] == [0.1, 0.2]
    assert update["body"]["retrievedDocuments"] == [
        {"rank": 0, "id": "id1", "score": 0.9, "content": "hello world", "metadata": {"content": "hello world"}}
    ]
    assert update["body"]["output"] == "1 document(s)"


def test_falls_back_to_stringified_metadata_without_recognized_key(capture: Capture) -> None:
    mt = Memoturn(**CREDS)
    match = _match(metadata={"foo": "bar"})
    index = _fake_index(query=lambda **kw: _response([match]))
    wrap_pinecone(index, mt)

    index.query(vector=[0.1, 0.2])
    mt.flush()

    doc = _find(capture.batch(), "span-update")["body"]["retrievedDocuments"][0]
    assert doc["content"] == '{"foo": "bar"}'


def test_get_content_override_is_used_instead_of_default(capture: Capture) -> None:
    mt = Memoturn(**CREDS)
    match = _match(metadata={"content": "default text"})
    index = _fake_index(query=lambda **kw: _response([match]))
    wrap_pinecone(index, mt, get_content=lambda m: "custom text")

    index.query(vector=[0.1, 0.2])
    mt.flush()

    doc = _find(capture.batch(), "span-update")["body"]["retrievedDocuments"][0]
    assert doc["content"] == "custom text"


def test_namespace_kwarg_is_captured_in_span_metadata(capture: Capture) -> None:
    mt = Memoturn(**CREDS)
    index = _fake_index(query=lambda **kw: _response())
    wrap_pinecone(index, mt)

    index.query(vector=[0.1, 0.2], namespace="prod")
    mt.flush()

    assert _find(capture.batch(), "span-create")["body"]["metadata"]["namespace"] == "prod"


def test_empty_matches_produces_valid_zero_document_span(capture: Capture) -> None:
    mt = Memoturn(**CREDS)
    index = _fake_index(query=lambda **kw: _response())
    wrap_pinecone(index, mt)

    index.query(vector=[0.1, 0.2])
    mt.flush()

    update = _find(capture.batch(), "span-update")
    assert update["body"]["retrievedDocuments"] == []
    assert update["body"]["output"] == "0 document(s)"


def test_error_marks_span_and_reraises(capture: Capture) -> None:
    mt = Memoturn(**CREDS)

    def boom(**kw):
        raise RuntimeError("index unavailable")

    index = _fake_index(query=boom)
    wrap_pinecone(index, mt)

    with pytest.raises(RuntimeError, match="index unavailable"):
        index.query(vector=[0.1, 0.2])
    mt.flush()

    update = _find(capture.batch(), "span-update")
    assert update["body"]["level"] == "ERROR"
    assert "index unavailable" in update["body"]["statusMessage"]


def test_embedding_truncated_at_max_dim(capture: Capture) -> None:
    mt = Memoturn(**CREDS)
    vector = [0.0] * 5000
    index = _fake_index(query=lambda **kw: _response())
    wrap_pinecone(index, mt)

    index.query(vector=vector)
    mt.flush()

    embedding = _find(capture.batch(), "span-create")["body"]["embedding"]
    assert len(embedding) == 4096
    assert embedding == vector[:4096]


def test_leaves_non_query_methods_untouched(capture: Capture) -> None:
    mt = Memoturn(**CREDS)
    upsert = lambda **kw: "upserted"  # noqa: E731
    stats = lambda **kw: "stats"  # noqa: E731
    index = _fake_index(query=lambda **kw: _response(), upsert=upsert, describe_index_stats=stats)
    wrap_pinecone(index, mt)

    assert index.upsert is upsert
    assert index.describe_index_stats is stats


def test_nests_under_provided_trace(capture: Capture) -> None:
    mt = Memoturn(**CREDS)
    trace = mt.trace(name="outer")
    index = _fake_index(query=lambda **kw: _response())
    wrap_pinecone(index, mt, trace=trace)

    index.query(vector=[0.1, 0.2])
    mt.flush()
    assert _find(capture.batch(), "span-create")["body"]["traceId"] == trace.id
