"""wrap_weaviate records the v4 collection.query namespace retrieval calls
(near_vector/near_text/hybrid/bm25/fetch_objects) as RETRIEVER spans."""
from __future__ import annotations

from types import SimpleNamespace

import pytest
from conftest import Capture

from memoturn import Memoturn, wrap_weaviate

CREDS = dict(base_url="http://api.test", public_key="pk-mt-x", secret_key="sk-mt-y", flush_at=1000)


def _find(batch: list[dict], type_: str) -> dict:
    return next(e for e in batch if e["type"] == type_)


def _fake_collection(**query_methods) -> SimpleNamespace:
    return SimpleNamespace(query=SimpleNamespace(**query_methods))


def _obj(uuid: str = "uuid1", properties: dict | None = None, **metadata) -> SimpleNamespace:
    meta = {"distance": None, "score": None, "certainty": None, **metadata}
    return SimpleNamespace(uuid=uuid, properties=properties, metadata=SimpleNamespace(**meta))


def _response(objects: list | None = None) -> SimpleNamespace:
    return SimpleNamespace(objects=objects or [])


def test_near_vector_records_retriever_span_with_distance_score(capture: Capture) -> None:
    mt = Memoturn(**CREDS)
    obj = _obj(properties={"content": "hello world"}, distance=0.25)
    resp = _response([obj])
    collection = _fake_collection(near_vector=lambda **kw: resp)
    wrap_weaviate(collection, mt)

    res = collection.query.near_vector(near_vector=[0.1, 0.2], limit=5)
    assert res is resp
    mt.flush()

    batch = capture.batch()
    create = _find(batch, "span-create")
    update = _find(batch, "span-update")
    assert create["body"]["name"] == "weaviate.near_vector"
    assert create["body"]["observationType"] == "RETRIEVER"
    assert create["body"]["metadata"] == {"limit": 5, "query": None}
    assert create["body"]["embedding"] == [0.1, 0.2]
    assert update["body"]["retrievedDocuments"] == [
        {"rank": 0, "id": "uuid1", "score": 0.75, "content": "hello world",
         "metadata": {"content": "hello world"}}
    ]
    assert update["body"]["output"] == "1 document(s)"


def test_hybrid_prefers_explicit_score_and_records_query_text(capture: Capture) -> None:
    mt = Memoturn(**CREDS)
    obj = _obj(properties={"text": "chunk"}, score=0.42, distance=0.9)
    collection = _fake_collection(hybrid=lambda **kw: _response([obj]))
    wrap_weaviate(collection, mt)

    collection.query.hybrid(query="what is memoturn?", vector=[0.1], limit=3)
    mt.flush()

    batch = capture.batch()
    assert _find(batch, "span-create")["body"]["metadata"] == {"limit": 3, "query": "what is memoturn?"}
    assert _find(batch, "span-create")["body"]["embedding"] == [0.1]
    assert _find(batch, "span-update")["body"]["retrievedDocuments"][0]["score"] == 0.42


def test_certainty_used_when_no_score(capture: Capture) -> None:
    mt = Memoturn(**CREDS)
    obj = _obj(properties={"text": "chunk"}, certainty=0.88)
    collection = _fake_collection(near_text=lambda **kw: _response([obj]))
    wrap_weaviate(collection, mt)

    collection.query.near_text(query="biology", limit=2)
    mt.flush()

    assert _find(capture.batch(), "span-update")["body"]["retrievedDocuments"][0]["score"] == 0.88


def test_falls_back_to_stringified_properties_without_recognized_key(capture: Capture) -> None:
    mt = Memoturn(**CREDS)
    obj = _obj(properties={"foo": "bar"})
    collection = _fake_collection(bm25=lambda **kw: _response([obj]))
    wrap_weaviate(collection, mt)

    collection.query.bm25(query="bar")
    mt.flush()

    doc = _find(capture.batch(), "span-update")["body"]["retrievedDocuments"][0]
    assert doc["content"] == '{"foo": "bar"}'
    assert doc["score"] is None


def test_get_content_override_is_used_instead_of_default(capture: Capture) -> None:
    mt = Memoturn(**CREDS)
    obj = _obj(properties={"content": "default text"})
    collection = _fake_collection(fetch_objects=lambda **kw: _response([obj]))
    wrap_weaviate(collection, mt, get_content=lambda o: "custom text")

    collection.query.fetch_objects(limit=10)
    mt.flush()

    doc = _find(capture.batch(), "span-update")["body"]["retrievedDocuments"][0]
    assert doc["content"] == "custom text"


def test_only_existing_query_methods_are_patched(capture: Capture) -> None:
    mt = Memoturn(**CREDS)
    aggregate = lambda **kw: "aggregated"  # noqa: E731
    collection = _fake_collection(near_vector=lambda **kw: _response())
    collection.query.aggregate_stub = aggregate
    wrap_weaviate(collection, mt)

    assert collection.query.aggregate_stub is aggregate
    assert not hasattr(collection.query, "near_text")
    assert not hasattr(collection.query, "hybrid")


def test_error_marks_span_and_reraises(capture: Capture) -> None:
    mt = Memoturn(**CREDS)

    def boom(**kw):
        raise RuntimeError("collection unavailable")

    collection = _fake_collection(near_vector=boom)
    wrap_weaviate(collection, mt)

    with pytest.raises(RuntimeError, match="collection unavailable"):
        collection.query.near_vector(near_vector=[0.1])
    mt.flush()

    update = _find(capture.batch(), "span-update")
    assert update["body"]["level"] == "ERROR"
    assert "collection unavailable" in update["body"]["statusMessage"]


def test_embedding_truncated_at_max_dim(capture: Capture) -> None:
    mt = Memoturn(**CREDS)
    vector = [0.0] * 5000
    collection = _fake_collection(near_vector=lambda **kw: _response())
    wrap_weaviate(collection, mt)

    collection.query.near_vector(near_vector=vector)
    mt.flush()

    embedding = _find(capture.batch(), "span-create")["body"]["embedding"]
    assert len(embedding) == 4096
    assert embedding == vector[:4096]


def test_nests_under_provided_trace(capture: Capture) -> None:
    mt = Memoturn(**CREDS)
    trace = mt.trace(name="outer")
    collection = _fake_collection(near_text=lambda **kw: _response())
    wrap_weaviate(collection, mt, trace=trace)

    collection.query.near_text(query="q")
    mt.flush()
    assert _find(capture.batch(), "span-create")["body"]["traceId"] == trace.id
