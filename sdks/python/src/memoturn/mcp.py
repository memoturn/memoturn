"""Drop-in wrapper for an MCP ClientSession (modelcontextprotocol/python-sdk) — records
each call_tool() as a TOOL observation. Server-side MCP tracing needs no wrapper: every
MCP Python server already emits OpenTelemetry spans for tools/call by default (see the
`## MCP` section in the README) — point memoturn.otel.span_processor at it instead."""
from __future__ import annotations

from typing import Any, Optional

from ._stream import _get
from .client import Memoturn, Trace
from .decorator import get_client


def wrap_mcp_client(session: Any, memoturn: Optional[Memoturn] = None, *, trace: Optional[Trace] = None) -> Any:
    """Patch session.call_tool to trace calls as TOOL observations. Returns the same
    session. A result with isError/is_error=True marks the observation ERROR (but does
    not raise — MCP signals tool errors via the result shape, not an exception); a raised
    exception from call_tool itself also marks ERROR and re-raises."""
    mt = memoturn or get_client()
    original = session.call_tool

    async def call_tool(name: str, arguments: Optional[dict] = None, *args: Any, **kwargs: Any) -> Any:
        t = trace or mt.trace(name="mcp.client")
        tool = t.tool(name=name, input=arguments)
        try:
            result = await original(name, arguments, *args, **kwargs)
            is_error = bool(_get(result, "isError") or _get(result, "is_error"))
            body: dict[str, Any] = {"output": _get(result, "content", result)}
            if is_error:
                body["level"] = "ERROR"
                body["statusMessage"] = "tool returned isError"
            tool.end(**body)
            return result
        except Exception as e:  # noqa: BLE001
            tool.end(level="ERROR", statusMessage=str(e))
            raise

    session.call_tool = call_tool  # type: ignore[assignment]
    return session
