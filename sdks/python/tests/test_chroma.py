"""wrap_chroma records collection.query() calls as RETRIEVER spans. Wraps a Chroma
collection handle; responses are columnar arrays-of-arrays (one column per query)."""
from __future__ import annotations

from types import SimpleNamespace

import pytest
from conftest import Capture

from memoturn import Memoturn, wrap_chroma

CREDS = dict(base_url="http://api.test", public_key="pk-mt-x", secret_key="sk-mt-y", flush_at=1000)


def _find(batch: list[dict], type_: str) -> dict:
    return next(e for e in batch if e["type"] == type_)


def _fake_collection(query, **extra) -> SimpleNamespace:
    return SimpleNamespace(query=query, **extra)


def _response(ids=None, distances=None, documents=None, metadatas=None) -> dict:
    return {
        "ids": [ids or []],
        "distances": [distances] if distances is not None else None,
        "documents": [documents] if documents is not None else None,
        "metadatas": [metadatas] if metadatas is not None else None,
    }


def test_records_retriever_span_with_documents_and_distance_score(capture: Capture) -> None:
    mt = Memoturn(**CREDS)
    resp = _response(ids=["id1"], distances=[0.25], documents=["hello world"], metadatas=[{"source": "a.md"}])
    collection = _fake_collection(query=lambda **kw: resp)
    wrap_chroma(collection, mt)

    res = collection.query(query_embeddings=[[0.1, 0.2]], n_results=5, where={"lang": "en"})
    assert res is resp
    mt.flush()

    batch = capture.batch()
    create = _find(batch, "span-create")
    update = _find(batch, "span-update")
    assert create["body"]["name"] == "chroma.query"
    assert create["body"]["observationType"] == "RETRIEVER"
    assert create["body"]["metadata"] == {"nResults": 5, "where": {"lang": "en"}, "queryTexts": None}
    assert create["body"]["embedding"] == [0.1, 0.2]
    assert update["body"]["retrievedDocuments"] == [
        {"rank": 0, "id": "id1", "score": 0.75, "content": "hello world", "metadata": {"source": "a.md"}}
    ]
    assert update["body"]["output"] == "1 document(s)"


def test_falls_back_to_metadata_keys_then_stringified_metadata(capture: Capture) -> None:
    mt = Memoturn(**CREDS)
    resp = _response(ids=["id1", "id2"], metadatas=[{"text": "from metadata"}, {"foo": "bar"}])
    collection = _fake_collection(query=lambda **kw: resp)
    wrap_chroma(collection, mt)

    collection.query(query_embeddings=[[0.1]])
    mt.flush()

    docs = _find(capture.batch(), "span-update")["body"]["retrievedDocuments"]
    assert docs[0]["content"] == "from metadata"
    assert docs[1]["content"] == '{"foo": "bar"}'
    assert docs[0]["score"] is None  # no distances included


def test_get_content_override_is_used_instead_of_default(capture: Capture) -> None:
    mt = Memoturn(**CREDS)
    resp = _response(ids=["id1"], documents=["default text"])
    collection = _fake_collection(query=lambda **kw: resp)
    wrap_chroma(collection, mt, get_content=lambda r: "custom text")

    collection.query(query_embeddings=[[0.1]])
    mt.flush()

    doc = _find(capture.batch(), "span-update")["body"]["retrievedDocuments"][0]
    assert doc["content"] == "custom text"


def test_only_first_query_column_is_recorded(capture: Capture) -> None:
    mt = Memoturn(**CREDS)
    resp = {"ids": [["a"], ["b"]], "distances": [[0.1], [0.2]], "documents": [["first"], ["second"]],
            "metadatas": [[None], [None]]}
    collection = _fake_collection(query=lambda **kw: resp)
    wrap_chroma(collection, mt)

    collection.query(query_embeddings=[[0.1], [0.2]])
    mt.flush()

    docs = _find(capture.batch(), "span-update")["body"]["retrievedDocuments"]
    assert [d["id"] for d in docs] == ["a"]
    assert docs[0]["content"] == "first"


def test_empty_results_produce_valid_zero_document_span(capture: Capture) -> None:
    mt = Memoturn(**CREDS)
    collection = _fake_collection(query=lambda **kw: _response())
    wrap_chroma(collection, mt)

    collection.query(query_texts=["what is memoturn?"])
    mt.flush()

    update = _find(capture.batch(), "span-update")
    assert update["body"]["retrievedDocuments"] == []
    assert update["body"]["output"] == "0 document(s)"
    assert _find(capture.batch(), "span-create")["body"]["metadata"]["queryTexts"] == ["what is memoturn?"]


def test_error_marks_span_and_reraises(capture: Capture) -> None:
    mt = Memoturn(**CREDS)

    def boom(**kw):
        raise RuntimeError("collection unavailable")

    collection = _fake_collection(query=boom)
    wrap_chroma(collection, mt)

    with pytest.raises(RuntimeError, match="collection unavailable"):
        collection.query(query_embeddings=[[0.1]])
    mt.flush()

    update = _find(capture.batch(), "span-update")
    assert update["body"]["level"] == "ERROR"
    assert "collection unavailable" in update["body"]["statusMessage"]


def test_embedding_truncated_at_max_dim(capture: Capture) -> None:
    mt = Memoturn(**CREDS)
    vector = [0.0] * 5000
    collection = _fake_collection(query=lambda **kw: _response())
    wrap_chroma(collection, mt)

    collection.query(query_embeddings=[vector])
    mt.flush()

    embedding = _find(capture.batch(), "span-create")["body"]["embedding"]
    assert len(embedding) == 4096
    assert embedding == vector[:4096]


def test_leaves_non_query_methods_untouched(capture: Capture) -> None:
    mt = Memoturn(**CREDS)
    add = lambda **kw: "added"  # noqa: E731
    get = lambda **kw: "got"  # noqa: E731
    collection = _fake_collection(query=lambda **kw: _response(), add=add, get=get)
    wrap_chroma(collection, mt)

    assert collection.add is add
    assert collection.get is get


def test_nests_under_provided_trace(capture: Capture) -> None:
    mt = Memoturn(**CREDS)
    trace = mt.trace(name="outer")
    collection = _fake_collection(query=lambda **kw: _response())
    wrap_chroma(collection, mt, trace=trace)

    collection.query(query_embeddings=[[0.1]])
    mt.flush()
    assert _find(capture.batch(), "span-create")["body"]["traceId"] == trace.id
