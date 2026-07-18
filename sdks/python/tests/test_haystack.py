"""MemoturnHaystackTracer maps Haystack 2.x tracing calls (pipeline run → trace,
component run → typed observation) by driving the tracer exactly the way Haystack's
Pipeline.run does: tracer.trace("haystack.pipeline.run", tags=...) around the run,
tracer.trace("haystack.component.run", tags=..., parent_span=...) around each component,
with real input/output arriving via span.set_content_tag."""
from __future__ import annotations

from types import SimpleNamespace

import pytest
from conftest import Capture

from memoturn import Memoturn
from memoturn.haystack import MemoturnHaystackTracer

CREDS = dict(base_url="http://api.test", public_key="pk-mt-x", secret_key="sk-mt-y", flush_at=1000)

PIPELINE_OP = "haystack.pipeline.run"
COMPONENT_OP = "haystack.component.run"


def _component_tags(name: str, ctype: str) -> dict:
    return {"haystack.component.name": name, "haystack.component.type": ctype}


def _doc(doc_id: str, content: str, score: float, meta: dict | None = None) -> SimpleNamespace:
    return SimpleNamespace(id=doc_id, content=content, score=score, meta=meta or {})


def test_pipeline_run_maps_to_trace_with_typed_component_observations(capture: Capture) -> None:
    client = Memoturn(**CREDS)
    tracer = MemoturnHaystackTracer(client)
    outputs: dict = {}

    with tracer.trace(
        PIPELINE_OP,
        tags={"haystack.pipeline.input_data": {"retriever": {"query": "what is memoturn?"}},
              "haystack.pipeline.output_data": outputs},
    ) as pipeline_span:
        with tracer.trace(
            COMPONENT_OP, tags=_component_tags("retriever", "InMemoryBM25Retriever"), parent_span=pipeline_span
        ) as span:
            span.set_content_tag("haystack.component.input", {"query": "what is memoturn?"})
            span.set_content_tag(
                "haystack.component.output",
                {"documents": [_doc("doc-1", "memoturn is an observability platform", 0.9, {"source": "docs"}),
                               _doc("doc-2", "it is self-hostable", 0.7)]},
            )
        with tracer.trace(
            COMPONENT_OP, tags=_component_tags("llm", "OpenAIGenerator"), parent_span=pipeline_span
        ) as span:
            span.set_content_tag("haystack.component.input", {"prompt": "what is memoturn?"})
            span.set_content_tag(
                "haystack.component.output",
                {"replies": ["an observability platform"],
                 "meta": [{"model": "gpt-4o-mini",
                           "usage": {"prompt_tokens": 5, "completion_tokens": 3, "total_tokens": 8}}]},
            )
        outputs["llm"] = {"replies": ["an observability platform"]}
    client.flush()

    batch = capture.batch()
    traces = [e for e in batch if e["type"] == "trace-create"]
    trace_id = traces[0]["body"]["id"]
    assert traces[0]["body"]["name"] == "haystack.pipeline"
    assert traces[0]["body"]["input"] == {"retriever": {"query": "what is memoturn?"}}
    # The output_data reference is read at pipeline end, after the run populated it.
    final = next(e for e in traces if e["body"].get("output") is not None)
    assert final["body"]["output"] == {"llm": {"replies": ["an observability platform"]}}

    retrieve = next(e for e in batch if e["type"] == "span-create" and e["body"]["name"] == "retriever")
    assert retrieve["body"]["observationType"] == "RETRIEVER"
    assert retrieve["body"]["traceId"] == trace_id
    assert "parentObservationId" not in retrieve["body"]  # direct child of the trace
    assert retrieve["body"]["metadata"] == {"componentType": "InMemoryBM25Retriever"}

    retrieve_end = next(e for e in batch if e["type"] == "span-update" and e["body"]["id"] == retrieve["body"]["id"])
    assert retrieve_end["body"]["input"] == {"query": "what is memoturn?"}
    assert retrieve_end["body"]["retrievedDocuments"] == [
        {"rank": 0, "id": "doc-1", "score": 0.9, "content": "memoturn is an observability platform",
         "metadata": {"source": "docs"}},
        {"rank": 1, "id": "doc-2", "score": 0.7, "content": "it is self-hostable", "metadata": {}},
    ]
    assert retrieve_end["body"]["output"] == "2 document(s)"

    gen = next(e for e in batch if e["type"] == "generation-create" and e["body"]["name"] == "llm")
    assert gen["body"]["traceId"] == trace_id
    gen_end = next(e for e in batch if e["type"] == "generation-update" and e["body"]["id"] == gen["body"]["id"])
    assert gen_end["body"]["model"] == "gpt-4o-mini"
    assert gen_end["body"]["usage"] == {"promptTokens": 5, "completionTokens": 3, "totalTokens": 8}
    assert gen_end["body"]["output"]["replies"] == ["an observability platform"]


def test_one_trace_per_pipeline_run(capture: Capture) -> None:
    client = Memoturn(**CREDS)
    tracer = MemoturnHaystackTracer(client)

    for _ in range(2):
        with tracer.trace(PIPELINE_OP, tags={"haystack.pipeline.input_data": {}}):
            pass
    client.flush()

    trace_ids = {e["body"]["id"] for e in capture.batch() if e["type"] == "trace-create"}
    assert len(trace_ids) == 2


def test_chat_generator_usage_from_reply_meta(capture: Capture) -> None:
    """ChatGenerator replies are ChatMessage objects carrying model/usage on .meta."""
    client = Memoturn(**CREDS)
    tracer = MemoturnHaystackTracer(client)

    reply = SimpleNamespace(meta={"model": "claude-sonnet-4-5", "usage": {"input_tokens": 12, "output_tokens": 4}})
    with tracer.trace(PIPELINE_OP, tags={}) as pipeline_span:
        with tracer.trace(
            COMPONENT_OP, tags=_component_tags("llm", "AnthropicChatGenerator"), parent_span=pipeline_span
        ) as span:
            span.set_content_tag("haystack.component.output", {"replies": [reply]})
    client.flush()

    batch = capture.batch()
    gen_end = next(e for e in batch if e["type"] == "generation-update")
    assert gen_end["body"]["model"] == "claude-sonnet-4-5"
    assert gen_end["body"]["usage"] == {"promptTokens": 12, "completionTokens": 4, "totalTokens": 16}


def test_component_nesting_via_parent_span_and_current_span_fallback(capture: Capture) -> None:
    client = Memoturn(**CREDS)
    tracer = MemoturnHaystackTracer(client)

    with tracer.trace(PIPELINE_OP, tags={}) as pipeline_span:
        with tracer.trace(COMPONENT_OP, tags=_component_tags("agent", "Agent"), parent_span=pipeline_span) as agent_span:
            assert tracer.current_span() is agent_span
            # No explicit parent_span — must fall back to the innermost open span.
            with tracer.trace(COMPONENT_OP, tags=_component_tags("llm", "OpenAIChatGenerator")):
                pass
    client.flush()

    batch = capture.batch()
    agent = next(e for e in batch if e["type"] == "span-create" and e["body"]["name"] == "agent")
    assert agent["body"]["observationType"] == "AGENT"
    gen = next(e for e in batch if e["type"] == "generation-create" and e["body"]["name"] == "llm")
    assert gen["body"]["parentObservationId"] == agent["body"]["id"]
    assert tracer.current_span() is None


def test_embedder_and_unknown_components(capture: Capture) -> None:
    client = Memoturn(**CREDS)
    tracer = MemoturnHaystackTracer(client)

    with tracer.trace(PIPELINE_OP, tags={}) as pipeline_span:
        with tracer.trace(
            COMPONENT_OP, tags=_component_tags("embedder", "SentenceTransformersTextEmbedder"), parent_span=pipeline_span
        ) as span:
            span.set_content_tag("haystack.component.output", {"embedding": [0.1, 0.2, 0.3]})
        with tracer.trace(
            COMPONENT_OP, tags=_component_tags("prompt", "PromptBuilder"), parent_span=pipeline_span
        ) as span:
            span.set_content_tag("haystack.component.output", {"prompt": "rendered"})
    client.flush()

    batch = capture.batch()
    embed = next(e for e in batch if e["type"] == "span-create" and e["body"]["name"] == "embedder")
    assert embed["body"]["observationType"] == "EMBEDDING"
    embed_end = next(e for e in batch if e["type"] == "span-update" and e["body"]["id"] == embed["body"]["id"])
    assert embed_end["body"]["embedding"] == [0.1, 0.2, 0.3]
    assert embed_end["body"]["output"] == "3-dim embedding"

    prompt = next(e for e in batch if e["type"] == "span-create" and e["body"]["name"] == "prompt")
    assert "observationType" not in prompt["body"]  # plain SPAN
    prompt_end = next(e for e in batch if e["type"] == "span-update" and e["body"]["id"] == prompt["body"]["id"])
    assert prompt_end["body"]["output"] == {"prompt": "rendered"}


def test_tool_and_ranker_components_are_classified(capture: Capture) -> None:
    client = Memoturn(**CREDS)
    tracer = MemoturnHaystackTracer(client)

    with tracer.trace(PIPELINE_OP, tags={}) as pipeline_span:
        with tracer.trace(COMPONENT_OP, tags=_component_tags("tools", "ToolInvoker"), parent_span=pipeline_span):
            pass
        with tracer.trace(
            COMPONENT_OP, tags=_component_tags("ranker", "TransformersSimilarityRanker"), parent_span=pipeline_span
        ) as span:
            span.set_content_tag("haystack.component.output", {"documents": [_doc("d", "text", 0.5)]})
    client.flush()

    batch = capture.batch()
    tool = next(e for e in batch if e["type"] == "span-create" and e["body"]["name"] == "tools")
    assert tool["body"]["observationType"] == "TOOL"
    ranker = next(e for e in batch if e["type"] == "span-create" and e["body"]["name"] == "ranker")
    assert ranker["body"]["observationType"] == "RERANKER"
    ranker_end = next(e for e in batch if e["type"] == "span-update" and e["body"]["id"] == ranker["body"]["id"])
    assert ranker_end["body"]["retrievedDocuments"][0]["content"] == "text"


def test_component_error_marks_observation_error_and_reraises(capture: Capture) -> None:
    client = Memoturn(**CREDS)
    tracer = MemoturnHaystackTracer(client)

    with pytest.raises(RuntimeError, match="boom"):
        with tracer.trace(PIPELINE_OP, tags={}) as pipeline_span:
            with tracer.trace(
                COMPONENT_OP, tags=_component_tags("llm", "OpenAIGenerator"), parent_span=pipeline_span
            ):
                raise RuntimeError("boom")
    client.flush()

    batch = capture.batch()
    gen_end = next(e for e in batch if e["type"] == "generation-update")
    assert gen_end["body"]["level"] == "ERROR"
    assert "boom" in gen_end["body"]["statusMessage"]
    # The pipeline trace records the failure too.
    trace_err = next(e for e in batch if e["type"] == "trace-create" and e["body"].get("metadata"))
    assert trace_err["body"]["metadata"] == {"error": "boom"}


def test_nested_pipeline_becomes_chain_span_not_new_trace(capture: Capture) -> None:
    client = Memoturn(**CREDS)
    tracer = MemoturnHaystackTracer(client)

    with tracer.trace(PIPELINE_OP, tags={}) as outer:
        with tracer.trace(
            COMPONENT_OP, tags=_component_tags("super", "SuperComponent"), parent_span=outer
        ):
            inner_outputs = {"llm": {"replies": ["hi"]}}
            with tracer.trace(PIPELINE_OP, tags={"haystack.pipeline.input_data": {"q": "hi"},
                                                 "haystack.pipeline.output_data": inner_outputs}):
                pass
    client.flush()

    batch = capture.batch()
    traces = {e["body"]["id"] for e in batch if e["type"] == "trace-create"}
    assert len(traces) == 1  # the nested pipeline joined the outer trace
    chain = next(e for e in batch if e["type"] == "span-create" and e["body"].get("observationType") == "CHAIN")
    assert chain["body"]["input"] == {"q": "hi"}
    super_span = next(e for e in batch if e["type"] == "span-create" and e["body"]["name"] == "super")
    assert chain["body"]["parentObservationId"] == super_span["body"]["id"]
    chain_end = next(e for e in batch if e["type"] == "span-update" and e["body"]["id"] == chain["body"]["id"])
    assert chain_end["body"]["output"] == {"llm": {"replies": ["hi"]}}


def test_component_outside_any_pipeline_gets_a_fresh_trace(capture: Capture) -> None:
    client = Memoturn(**CREDS)
    tracer = MemoturnHaystackTracer(client)

    with tracer.trace(COMPONENT_OP, tags=_component_tags("llm", "OpenAIGenerator")):
        pass
    client.flush()

    batch = capture.batch()
    assert any(e["type"] == "trace-create" for e in batch)
    assert any(e["type"] == "generation-create" for e in batch)


def test_malformed_tags_never_raise(capture: Capture) -> None:
    client = Memoturn(**CREDS)
    tracer = MemoturnHaystackTracer(client)

    with tracer.trace(PIPELINE_OP, tags=None) as pipeline_span:
        with tracer.trace(COMPONENT_OP, tags={"weird": object()}, parent_span=pipeline_span) as span:
            span.set_content_tag("haystack.component.output", object())
    client.flush()

    batch = capture.batch()
    assert any(e["type"] == "trace-create" for e in batch)
    assert any(e["type"] == "span-create" for e in batch)
    assert any(e["type"] == "span-update" for e in batch)


def test_span_surface_matches_haystack_expectations(capture: Capture) -> None:
    """Haystack calls set_tag/set_tags/set_content_tag/raw_span/get_correlation_data_for_logs
    on whatever span the tracer yields — all must exist and never raise."""
    client = Memoturn(**CREDS)
    tracer = MemoturnHaystackTracer(client)

    with tracer.trace(PIPELINE_OP, tags={}) as pipeline_span:
        assert pipeline_span.raw_span() is not None
        assert "memoturn.trace_id" in pipeline_span.get_correlation_data_for_logs()
        with tracer.trace(COMPONENT_OP, tags=_component_tags("llm", "OpenAIGenerator"),
                          parent_span=pipeline_span) as span:
            span.set_tags({"haystack.component.visits": 1})
            data = span.get_correlation_data_for_logs()
            assert "memoturn.trace_id" in data and "memoturn.observation_id" in data
    client.flush()
