"""LangChain callback handler builds a single-trace chain/llm/tool tree."""
from __future__ import annotations

from types import SimpleNamespace
from uuid import uuid4

from conftest import Capture

from memoturn import Memoturn
from memoturn.langchain import MemoturnCallbackHandler

CREDS = dict(base_url="http://api.test", public_key="pk-mt-x", secret_key="sk-mt-y", flush_at=1000)


def test_builds_chain_llm_tool_tree(capture: Capture) -> None:
    client = Memoturn(**CREDS)
    cb = MemoturnCallbackHandler(client, trace_name="agent-run")

    chain_id, llm_id, tool_id = uuid4(), uuid4(), uuid4()
    cb.on_chain_start({}, {"question": "hi"}, run_id=chain_id)
    cb.on_llm_start({"name": "gpt-4o"}, ["prompt"], run_id=llm_id, invocation_params={"model": "gpt-4o"})
    response = SimpleNamespace(
        generations=[[{"text": "answer"}]],
        llm_output={"token_usage": {"prompt_tokens": 3, "completion_tokens": 4, "total_tokens": 7}},
    )
    cb.on_llm_end(response, run_id=llm_id)
    cb.on_tool_start({"name": "search"}, "query", run_id=tool_id)
    cb.on_tool_end("results", run_id=tool_id)
    cb.on_chain_end({"answer": "answer"}, run_id=chain_id)
    cb.flush()

    batch = capture.batch()
    traces = [e for e in batch if e["type"] == "trace-create"]
    assert len(traces) == 1
    trace_id = traces[0]["body"]["id"]
    assert traces[0]["body"]["name"] == "agent-run"

    gen = next(e for e in batch if e["type"] == "generation-create")
    assert gen["body"]["model"] == "gpt-4o"
    assert gen["body"]["traceId"] == trace_id
    gen_end = next(e for e in batch if e["type"] == "generation-update")
    assert gen_end["body"]["usage"] == {"promptTokens": 3, "completionTokens": 4, "totalTokens": 7}

    tool = next(e for e in batch if e["type"] == "span-create" and e["body"].get("name") == "search")
    assert tool["body"]["input"] == "query"


def test_chat_model_start_and_error(capture: Capture) -> None:
    client = Memoturn(**CREDS)
    cb = MemoturnCallbackHandler(client)

    run = uuid4()
    cb.on_chat_model_start({"name": "claude"}, [[{"role": "user"}]], run_id=run, invocation_params={})
    cb.on_llm_error(RuntimeError("boom"), run_id=run)
    cb.flush()

    end = next(e for e in capture.batch() if e["type"] == "generation-update")
    assert end["body"]["level"] == "ERROR"
    assert "boom" in end["body"]["statusMessage"]
