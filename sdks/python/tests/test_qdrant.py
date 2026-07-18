"""wrap_qdrant records client.search() (bare list of scored points) and
client.query_points() (QueryResponse with .points) calls as RETRIEVER spans."""
from __future__ import annotations

from types import SimpleNamespace

import pytest
from conftest import Capture

from memoturn import Memoturn, wrap_qdrant

CREDS = dict(base_url="http://api.test", public_key="pk-mt-x", secret_key="sk-mt-y", flush_at=1000)


def _find(batch: list[dict], type_: str) -> dict:
    return next(e for e in batch if e["type"] == type_)


def _fake_client(**methods) -> SimpleNamespace:
    return SimpleNamespace(**methods)


def _point(id_: str = "p1", score: float = 0.9, payload: dict | None = None) -> SimpleNamespace:
    return SimpleNamespace(id=id_, score=score, payload=payload)


def test_search_records_retriever_span_with_documents(capture: Capture) -> None:
    mt = Memoturn(**CREDS)
    point = _point(payload={"content": "hello world"})
    results = [point]
    client = _fake_client(search=lambda **kw: results)
    wrap_qdrant(client, mt)

    res = client.search(collection_name="docs", query_vector=[0.1, 0.2], limit=5)
    assert res is results
    mt.flush()

    batch = capture.batch()
    create = _find(batch, "span-create")
    update = _find(batch, "span-update")
    assert create["body"]["name"] == "qdrant.search"
    assert create["body"]["observationType"] == "RETRIEVER"
    assert create["body"]["metadata"] == {"collection": "docs", "limit": 5, "filter": None}
    assert create["body"]["embedding"] == [0.1, 0.2]
    assert update["body"]["retrievedDocuments"] == [
        {"rank": 0, "id": "p1", "score": 0.9, "content": "hello world", "metadata": {"content": "hello world"}}
    ]
    assert update["body"]["output"] == "1 document(s)"


def test_query_points_unwraps_points_attribute(capture: Capture) -> None:
    mt = Memoturn(**CREDS)
    resp = SimpleNamespace(points=[_point(id_="p1", payload={"text": "chunk"}),
                                    _point(id_="p2", score=0.5, payload={"text": "other"})])
    client = _fake_client(query_points=lambda **kw: resp)
    wrap_qdrant(client, mt)

    res = client.query_points(collection_name="docs", query=[0.1, 0.2], limit=2)
    assert res is resp
    mt.flush()

    batch = capture.batch()
    create = _find(batch, "span-create")
    assert create["body"]["name"] == "qdrant.query_points"
    assert create["body"]["embedding"] == [0.1, 0.2]
    docs = _find(batch, "span-update")["body"]["retrievedDocuments"]
    assert [d["id"] for d in docs] == ["p1", "p2"]
    assert docs[0]["content"] == "chunk"
    assert docs[1]["score"] == 0.5


def test_point_id_query_is_not_recorded_as_embedding(capture: Capture) -> None:
    mt = Memoturn(**CREDS)
    client = _fake_client(query_points=lambda **kw: SimpleNamespace(points=[]))
    wrap_qdrant(client, mt)

    client.query_points(collection_name="docs", query="43cf51e2-8777-4f52-bc74-c2cbde0c8b04")
    mt.flush()

    assert _find(capture.batch(), "span-create")["body"]["embedding"] is None


def test_falls_back_to_stringified_payload_without_recognized_key(capture: Capture) -> None:
    mt = Memoturn(**CREDS)
    point = _point(payload={"foo": "bar"})
    client = _fake_client(search=lambda **kw: [point])
    wrap_qdrant(client, mt)

    client.search(collection_name="docs", query_vector=[0.1])
    mt.flush()

    doc = _find(capture.batch(), "span-update")["body"]["retrievedDocuments"][0]
    assert doc["content"] == '{"foo": "bar"}'


def test_get_content_override_is_used_instead_of_default(capture: Capture) -> None:
    mt = Memoturn(**CREDS)
    point = _point(payload={"content": "default text"})
    client = _fake_client(search=lambda **kw: [point])
    wrap_qdrant(client, mt, get_content=lambda p: "custom text")

    client.search(collection_name="docs", query_vector=[0.1])
    mt.flush()

    doc = _find(capture.batch(), "span-update")["body"]["retrievedDocuments"][0]
    assert doc["content"] == "custom text"


def test_empty_results_produce_valid_zero_document_span(capture: Capture) -> None:
    mt = Memoturn(**CREDS)
    client = _fake_client(search=lambda **kw: [])
    wrap_qdrant(client, mt)

    client.search(collection_name="docs", query_vector=[0.1])
    mt.flush()

    update = _find(capture.batch(), "span-update")
    assert update["body"]["retrievedDocuments"] == []
    assert update["body"]["output"] == "0 document(s)"


def test_error_marks_span_and_reraises(capture: Capture) -> None:
    mt = Memoturn(**CREDS)

    def boom(**kw):
        raise RuntimeError("collection unavailable")

    client = _fake_client(search=boom)
    wrap_qdrant(client, mt)

    with pytest.raises(RuntimeError, match="collection unavailable"):
        client.search(collection_name="docs", query_vector=[0.1])
    mt.flush()

    update = _find(capture.batch(), "span-update")
    assert update["body"]["level"] == "ERROR"
    assert "collection unavailable" in update["body"]["statusMessage"]


def test_embedding_truncated_at_max_dim(capture: Capture) -> None:
    mt = Memoturn(**CREDS)
    vector = [0.0] * 5000
    client = _fake_client(search=lambda **kw: [])
    wrap_qdrant(client, mt)

    client.search(collection_name="docs", query_vector=vector)
    mt.flush()

    embedding = _find(capture.batch(), "span-create")["body"]["embedding"]
    assert len(embedding) == 4096
    assert embedding == vector[:4096]


def test_leaves_non_query_methods_untouched(capture: Capture) -> None:
    mt = Memoturn(**CREDS)
    upsert = lambda **kw: "upserted"  # noqa: E731
    client = _fake_client(search=lambda **kw: [], upsert=upsert)
    wrap_qdrant(client, mt)

    assert client.upsert is upsert
    assert not hasattr(client, "query_points")  # only existing methods are patched


def test_nests_under_provided_trace(capture: Capture) -> None:
    mt = Memoturn(**CREDS)
    trace = mt.trace(name="outer")
    client = _fake_client(search=lambda **kw: [])
    wrap_qdrant(client, mt, trace=trace)

    client.search(collection_name="docs", query_vector=[0.1])
    mt.flush()
    assert _find(capture.batch(), "span-create")["body"]["traceId"] == trace.id
