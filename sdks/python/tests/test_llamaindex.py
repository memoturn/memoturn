"""LlamaIndex callback handler builds a real nested query/retrieve/llm tree."""
from __future__ import annotations

from types import SimpleNamespace

from conftest import Capture

from memoturn import Memoturn
from memoturn.llamaindex import MemoturnLlamaIndexHandler

CREDS = dict(base_url="http://api.test", public_key="pk-mt-x", secret_key="sk-mt-y", flush_at=1000)


def _node(node_id: str, text: str, score: float, metadata: dict | None = None) -> SimpleNamespace:
    node = SimpleNamespace(node_id=node_id, get_content=lambda: text, metadata=metadata or {})
    return SimpleNamespace(node=node, score=score)


def test_full_rag_flow_nests_correctly(capture: Capture) -> None:
    client = Memoturn(**CREDS)
    cb = MemoturnLlamaIndexHandler(client, trace_name="rag-query")

    cb.start_trace("query")
    root_id = cb.on_event_start("query", {"query_str": "what is memoturn?"}, parent_id="root")

    retrieve_id = cb.on_event_start("retrieve", {"query_str": "what is memoturn?"}, parent_id=root_id)
    nodes = [_node("doc-1", "memoturn is an observability platform", 0.9, {"source": "docs"}),
             _node("doc-2", "it is self-hostable", 0.7)]
    cb.on_event_end("retrieve", {"nodes": nodes}, event_id=retrieve_id)

    llm_id = cb.on_event_start("llm", {"messages": ["what is memoturn?"], "model_name": "gpt-4o"}, parent_id=root_id)
    response = SimpleNamespace(
        message=SimpleNamespace(content="an observability platform"),
        raw={"usage": {"prompt_tokens": 5, "completion_tokens": 3, "total_tokens": 8}},
    )
    cb.on_event_end("llm", {"response": response}, event_id=llm_id)

    cb.on_event_end("query", {"response": "an observability platform"}, event_id=root_id)
    cb.end_trace("query")
    cb.flush()

    batch = capture.batch()
    traces = [e for e in batch if e["type"] == "trace-create"]
    assert len(traces) == 1
    trace_id = traces[0]["body"]["id"]

    root = next(e for e in batch if e["type"] == "span-create" and e["body"]["name"] == "query")
    assert root["body"]["observationType"] == "CHAIN"
    assert "parentObservationId" not in root["body"]
    assert root["body"]["traceId"] == trace_id

    retrieve = next(e for e in batch if e["type"] == "span-create" and e["body"]["name"] == "retrieve")
    assert retrieve["body"]["observationType"] == "RETRIEVER"
    assert retrieve["body"]["parentObservationId"] == root["body"]["id"]

    retrieve_end = next(e for e in batch if e["type"] == "span-update" and e["body"]["id"] == retrieve["body"]["id"])
    docs = retrieve_end["body"]["retrievedDocuments"]
    assert docs == [
        {"rank": 0, "id": "doc-1", "score": 0.9, "content": "memoturn is an observability platform",
         "metadata": {"source": "docs"}},
        {"rank": 1, "id": "doc-2", "score": 0.7, "content": "it is self-hostable", "metadata": {}},
    ]

    gen = next(e for e in batch if e["type"] == "generation-create" and e["body"]["name"] == "llm")
    assert gen["body"]["model"] == "gpt-4o"
    assert gen["body"]["parentObservationId"] == root["body"]["id"]

    gen_end = next(e for e in batch if e["type"] == "generation-update" and e["body"]["id"] == gen["body"]["id"])
    assert gen_end["body"]["output"] == "an observability platform"
    assert gen_end["body"]["usage"] == {"promptTokens": 5, "completionTokens": 3, "totalTokens": 8}


def test_embedding_event(capture: Capture) -> None:
    client = Memoturn(**CREDS)
    cb = MemoturnLlamaIndexHandler(client)

    cb.start_trace()
    eid = cb.on_event_start("embedding", {"chunks": ["a", "b"]}, parent_id="root")
    cb.on_event_end("embedding", {"embeddings": [[0.1, 0.2], [0.3, 0.4]]}, event_id=eid)
    cb.flush()

    batch = capture.batch()
    create = next(e for e in batch if e["type"] == "span-create" and e["body"]["name"] == "embedding")
    assert create["body"]["observationType"] == "EMBEDDING"
    end = next(e for e in batch if e["type"] == "span-update" and e["body"]["id"] == create["body"]["id"])
    assert end["body"]["embedding"] == [0.1, 0.2]
    assert end["body"]["output"] == "2 embedding(s)"


def test_exception_nests_under_open_parent(capture: Capture) -> None:
    client = Memoturn(**CREDS)
    cb = MemoturnLlamaIndexHandler(client)

    cb.start_trace()
    retrieve_id = cb.on_event_start("retrieve", {"query_str": "q"}, parent_id="root")
    cb.on_event_start("exception", {"exception": ValueError("boom")}, parent_id=retrieve_id)
    cb.on_event_end("retrieve", {"nodes": []}, event_id=retrieve_id)
    cb.flush()

    batch = capture.batch()
    retrieve_create = next(e for e in batch if e["type"] == "span-create" and e["body"]["name"] == "retrieve")
    exc = next(e for e in batch if e["type"] == "event-create")
    assert exc["body"]["level"] == "ERROR"
    assert "boom" in exc["body"]["statusMessage"]
    assert exc["body"]["parentObservationId"] == retrieve_create["body"]["id"]


def test_defensive_lazy_trace_without_start_trace(capture: Capture) -> None:
    client = Memoturn(**CREDS)
    cb = MemoturnLlamaIndexHandler(client, trace_name="fallback")

    llm_id = cb.on_event_start("llm", {"messages": ["hi"]}, parent_id="root")
    cb.on_event_end("llm", {"response": SimpleNamespace(text="hi there")}, event_id=llm_id)
    cb.flush()

    batch = capture.batch()
    traces = [e for e in batch if e["type"] == "trace-create"]
    assert len(traces) == 1
    assert traces[0]["body"]["name"] == "fallback"

    gen = next(e for e in batch if e["type"] == "generation-create")
    assert "parentObservationId" not in gen["body"]


def test_malformed_payload_never_raises(capture: Capture) -> None:
    client = Memoturn(**CREDS)
    cb = MemoturnLlamaIndexHandler(client)

    cb.start_trace()
    llm_id = cb.on_event_start("llm", {"weird": object()}, parent_id="root")
    cb.on_event_end("llm", {"response": object()}, event_id=llm_id)
    cb.flush()

    batch = capture.batch()
    assert any(e["type"] == "generation-create" for e in batch)
    assert any(e["type"] == "generation-update" for e in batch)
