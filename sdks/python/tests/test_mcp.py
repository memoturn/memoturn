"""wrap_mcp_client records session.call_tool() calls as TOOL observations. Wraps an MCP
ClientSession (modelcontextprotocol/python-sdk) — the caller side of MCP. Server-side
tracing needs no wrapper (see the `## MCP` section in the README)."""
from __future__ import annotations

import asyncio
from types import SimpleNamespace
from typing import Any

import pytest
from conftest import Capture

from memoturn import Memoturn, wrap_mcp_client

CREDS = dict(base_url="http://api.test", public_key="pk-mt-x", secret_key="sk-mt-y", flush_at=1000)


def _find(batch: list[dict], type_: str) -> dict:
    return next(e for e in batch if e["type"] == type_)


def _fake_session(call_tool, **extra) -> SimpleNamespace:
    return SimpleNamespace(call_tool=call_tool, **extra)


def _result(content: Any = None, is_error: bool = False, *, snake_case: bool = False) -> SimpleNamespace:
    kwargs = {"is_error": is_error} if snake_case else {"isError": is_error}
    return SimpleNamespace(content=content, **kwargs)


async def _noop_call_tool(name, arguments=None, **kwargs):
    return _result()


def test_records_tool_observation_with_name_and_arguments(capture: Capture) -> None:
    mt = Memoturn(**CREDS)

    async def call_tool(name, arguments=None, **kwargs):
        return _result(content=[{"type": "text", "text": "ok"}])

    session = _fake_session(call_tool=call_tool)
    wrap_mcp_client(session, mt)

    res = asyncio.run(session.call_tool("search", arguments={"query": "hello"}))
    mt.flush()

    batch = capture.batch()
    create = _find(batch, "span-create")
    assert create["body"]["name"] == "search"
    assert create["body"]["observationType"] == "TOOL"
    assert create["body"]["input"] == {"query": "hello"}
    assert res.content == [{"type": "text", "text": "ok"}]


def test_result_content_becomes_output(capture: Capture) -> None:
    mt = Memoturn(**CREDS)

    async def call_tool(name, arguments=None, **kwargs):
        return _result(content=[{"type": "text", "text": "42"}])

    session = _fake_session(call_tool=call_tool)
    wrap_mcp_client(session, mt)

    asyncio.run(session.call_tool("calc", arguments={"expr": "6*7"}))
    mt.flush()

    update = _find(capture.batch(), "span-update")
    assert update["body"]["output"] == [{"type": "text", "text": "42"}]
    assert "level" not in update["body"]


def test_is_error_result_marks_error_but_does_not_raise(capture: Capture) -> None:
    mt = Memoturn(**CREDS)

    async def call_tool(name, arguments=None, **kwargs):
        return _result(content=[{"type": "text", "text": "boom"}], is_error=True)

    session = _fake_session(call_tool=call_tool)
    wrap_mcp_client(session, mt)

    res = asyncio.run(session.call_tool("flaky", arguments={}))
    mt.flush()

    update = _find(capture.batch(), "span-update")
    assert update["body"]["level"] == "ERROR"
    assert update["body"]["statusMessage"]
    assert res is not None  # completed normally — no exception propagated


def test_is_error_result_snake_case_also_marks_error(capture: Capture) -> None:
    mt = Memoturn(**CREDS)

    async def call_tool(name, arguments=None, **kwargs):
        return _result(content=None, is_error=True, snake_case=True)

    session = _fake_session(call_tool=call_tool)
    wrap_mcp_client(session, mt)

    asyncio.run(session.call_tool("flaky", arguments={}))
    mt.flush()

    update = _find(capture.batch(), "span-update")
    assert update["body"]["level"] == "ERROR"


def test_raised_exception_marks_error_and_reraises(capture: Capture) -> None:
    mt = Memoturn(**CREDS)

    async def call_tool(name, arguments=None, **kwargs):
        raise RuntimeError("session closed")

    session = _fake_session(call_tool=call_tool)
    wrap_mcp_client(session, mt)

    with pytest.raises(RuntimeError, match="session closed"):
        asyncio.run(session.call_tool("search", arguments={}))
    mt.flush()

    update = _find(capture.batch(), "span-update")
    assert update["body"]["level"] == "ERROR"
    assert "session closed" in update["body"]["statusMessage"]


def test_nests_under_provided_trace(capture: Capture) -> None:
    mt = Memoturn(**CREDS)
    trace = mt.trace(name="outer")
    session = _fake_session(call_tool=_noop_call_tool)
    wrap_mcp_client(session, mt, trace=trace)

    asyncio.run(session.call_tool("search", arguments={}))
    mt.flush()

    assert _find(capture.batch(), "span-create")["body"]["traceId"] == trace.id


def test_leaves_non_call_tool_attributes_untouched(capture: Capture) -> None:
    mt = Memoturn(**CREDS)

    async def list_tools():
        return "tools"

    async def close():
        return None

    session = _fake_session(call_tool=_noop_call_tool, list_tools=list_tools, close=close)
    wrap_mcp_client(session, mt)

    assert session.list_tools is list_tools
    assert session.close is close
