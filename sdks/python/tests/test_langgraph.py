"""LangGraph handler — combined LangChain recording + interrupt/resume lifecycle events."""
from __future__ import annotations

import builtins
from uuid import uuid4

import pytest

from conftest import Capture

from memoturn import Memoturn
from memoturn.langgraph import make_langgraph_handler

CREDS = dict(base_url="http://api.test", public_key="pk-mt-x", secret_key="sk-mt-y", flush_at=1000)


def test_raises_clear_import_error_when_langgraph_missing(monkeypatch: pytest.MonkeyPatch) -> None:
    """Doesn't need a real install — blocks the import so this path is always exercised."""
    real_import = builtins.__import__

    def fake_import(name: str, *args: object, **kwargs: object) -> object:
        if name == "langgraph" or name.startswith("langgraph."):
            raise ImportError("simulated missing dependency")
        return real_import(name, *args, **kwargs)  # type: ignore[arg-type]

    monkeypatch.setattr(builtins, "__import__", fake_import)
    with pytest.raises(ImportError, match="memoturn.langgraph.make_langgraph_handler requires 'langgraph'"):
        make_langgraph_handler()


# Everything below needs the real optional dependency. A module-level
# ``pytest.importorskip`` would abort collection of the *whole file* — including the
# always-runnable ImportError test above — so the presence check is a plain
# try/except and each dependent test is skipped individually instead.
try:
    from langgraph.callbacks import GraphInterruptEvent, GraphResumeEvent

    _HAS_LANGGRAPH = True
except ImportError:
    _HAS_LANGGRAPH = False

requires_langgraph = pytest.mark.skipif(not _HAS_LANGGRAPH, reason="langgraph is not installed")


@requires_langgraph
def test_on_interrupt_records_event_with_metadata(capture: Capture) -> None:
    client = Memoturn(**CREDS)
    handler = make_langgraph_handler(client, trace_name="graph-run")

    event = GraphInterruptEvent(
        run_id=None,
        status="interrupt_before",
        checkpoint_id="ckpt-1",
        checkpoint_ns=("ns1", "ns2"),
        interrupts=(),
    )
    handler.on_interrupt(event)
    handler.flush()

    batch = capture.batch()
    traces = [e for e in batch if e["type"] == "trace-create"]
    assert len(traces) == 1
    assert traces[0]["body"]["name"] == "graph-run"

    interrupt = next(e for e in batch if e["type"] == "event-create")
    assert interrupt["body"]["name"] == "langgraph.interrupt"
    assert interrupt["body"]["level"] == "WARNING"
    assert interrupt["body"]["metadata"] == {
        "status": "interrupt_before",
        "checkpointId": "ckpt-1",
        "checkpointNs": ["ns1", "ns2"],
        "interrupts": [],
    }
    assert interrupt["body"]["traceId"] == traces[0]["body"]["id"]


@requires_langgraph
def test_on_resume_records_event_without_level(capture: Capture) -> None:
    client = Memoturn(**CREDS)
    handler = make_langgraph_handler(client)

    event = GraphResumeEvent(run_id=None, status="pending", checkpoint_id="ckpt-2", checkpoint_ns=("ns1",))
    handler.on_resume(event)
    handler.flush()

    resume = next(e for e in capture.batch() if e["type"] == "event-create")
    assert resume["body"]["name"] == "langgraph.resume"
    assert "level" not in resume["body"]
    assert resume["body"]["metadata"] == {"status": "pending", "checkpointId": "ckpt-2", "checkpointNs": ["ns1"]}


@requires_langgraph
def test_inherited_langchain_callbacks_still_work(capture: Capture) -> None:
    """Proves the multiple-inheritance composition didn't break the LangChain handler."""
    client = Memoturn(**CREDS)
    handler = make_langgraph_handler(client, trace_name="graph-run")

    chain_id = uuid4()
    handler.on_chain_start({}, {"question": "hi"}, run_id=chain_id)
    handler.on_chain_end({"answer": "hi"}, run_id=chain_id)

    llm_id = uuid4()
    handler.on_llm_start({"name": "gpt-4o"}, ["prompt"], run_id=llm_id, invocation_params={"model": "gpt-4o"})
    handler.on_llm_error(RuntimeError("boom"), run_id=llm_id)
    handler.flush()

    batch = capture.batch()
    assert any(e["type"] == "span-create" and e["body"]["name"] == "chain" for e in batch)
    assert any(e["type"] == "span-update" and e["body"].get("output") == {"answer": "hi"} for e in batch)

    gen_end = next(e for e in batch if e["type"] == "generation-update")
    assert gen_end["body"]["level"] == "ERROR"
    assert "boom" in gen_end["body"]["statusMessage"]

    # Both the langchain-tree recording and the graph lifecycle events share one trace.
    traces = [e for e in batch if e["type"] == "trace-create"]
    assert len(traces) == 1
