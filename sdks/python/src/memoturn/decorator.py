"""@observe decorator — trace any function with automatic nesting.

The outermost @observe creates a trace + root observation; nested @observe calls become
child spans. Uses a contextvar so nesting works across sync and async call stacks.
"""
from __future__ import annotations

import contextvars
import functools
import inspect
import logging
from typing import Any, Callable, Optional

from .client import Memoturn, Span, Trace

logger = logging.getLogger("memoturn")

_default: Optional[Memoturn] = None
_ctx: contextvars.ContextVar[Optional[tuple[Trace, Span]]] = contextvars.ContextVar("memoturn_ctx", default=None)


def configure(client: Memoturn) -> Memoturn:
    """Set the default client used by @observe (and returned by get_client)."""
    global _default
    _default = client
    return client


def get_client() -> Memoturn:
    global _default
    if _default is None:
        _default = Memoturn()
    return _default


def set_trace_context(**kwargs: Any) -> None:
    """Update the current trace's userId/sessionId/tags/metadata from anywhere inside an
    active @observe call stack. Delegates to Trace.update() (kwargs: userId, sessionId,
    tags, metadata — same wire-field names as trace()/update()), so it has the same patch
    semantics: omitted fields keep their previous value; tags/metadata are replaced
    wholesale, not merged.

    No-op (with a logger.warning) outside any active @observe context — there is no
    trace to stamp. Never raises, matching @observe's own never-break-the-caller
    exception handling.

    Scoped to @observe-context only: code using Memoturn().trace(...) directly already
    holds a Trace reference and should call trace.update(...) itself.
    """
    cur = _ctx.get()
    if cur is None:
        logger.warning("set_trace_context() called outside an active @observe context — ignored")
        return
    trace, _span = cur
    trace.update(**kwargs)


def _begin(name: str, as_type: str, inp: Any) -> tuple[Trace, Span, Any]:
    client = get_client()
    cur = _ctx.get()
    if cur is None:
        trace = client.trace(name=name, input=inp)
        span = trace.generation(name=name, input=inp) if as_type == "generation" else trace.span(name=name, input=inp)
    else:
        trace, parent = cur
        span = parent.generation(name=name, input=inp) if as_type == "generation" else parent.span(name=name, input=inp)
    token = _ctx.set((trace, span))
    return trace, span, (token, cur is None)


def _finish(trace: Trace, span: Span, state: Any, output: Any) -> None:
    token, is_root = state
    span.end(output=output)
    if is_root:
        trace.update(output=output)
    _ctx.reset(token)


def observe(_fn: Optional[Callable] = None, *, name: Optional[str] = None, as_type: str = "span") -> Callable:
    def deco(fn: Callable) -> Callable:
        obs_name = name or fn.__name__

        if inspect.iscoroutinefunction(fn):
            @functools.wraps(fn)
            async def awrapper(*args: Any, **kwargs: Any) -> Any:
                trace, span, state = _begin(obs_name, as_type, {"args": args, "kwargs": kwargs})
                try:
                    out = await fn(*args, **kwargs)
                    _finish(trace, span, state, out)
                    return out
                except Exception as e:  # noqa: BLE001
                    span.end(level="ERROR", statusMessage=str(e))
                    _ctx.reset(state[0])
                    raise

            return awrapper

        @functools.wraps(fn)
        def wrapper(*args: Any, **kwargs: Any) -> Any:
            trace, span, state = _begin(obs_name, as_type, {"args": args, "kwargs": kwargs})
            try:
                out = fn(*args, **kwargs)
                _finish(trace, span, state, out)
                return out
            except Exception as e:  # noqa: BLE001
                span.end(level="ERROR", statusMessage=str(e))
                _ctx.reset(state[0])
                raise

        return wrapper

    return deco(_fn) if callable(_fn) else deco
