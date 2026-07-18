"""LangGraph callback handler — captures interrupt/resume lifecycle events on top of
the LangChain handler's chain/LLM/tool tree.

Node-level execution inside a LangGraph graph (LLM calls, tool calls, sub-chains)
already dispatches through the standard LangChain callback mechanism, so a plain
``MemoturnCallbackHandler`` passed via ``config={"callbacks": [...]}`` already records
all of that today — no LangGraph-specific code is needed for it. LangGraph's own
lifecycle events (``GraphInterruptEvent``/``GraphResumeEvent`` — the pause/resume
around interrupts and checkpoints that power durable execution and human-in-the-loop)
are dispatched only to handlers that are actual ``isinstance`` matches of
``langgraph.callbacks.GraphCallbackHandler``; a duck-typed handler never receives
them. ``make_langgraph_handler()`` builds a handler that is both, so this one
distinctive feature is captured too:

    from memoturn.langgraph import make_langgraph_handler
    graph.invoke(state, config={"callbacks": [make_langgraph_handler()]})

Requires the real ``langgraph`` (and transitively ``langchain-core``) packages
(``pip install "memoturn[langgraph]"``) — unlike every duck-typed wrapper in this
SDK, LangGraph only ever delivers lifecycle events to a real ``GraphCallbackHandler``
subclass, so this integration needs an actual import. That import is deferred to
inside this factory function, so ``import memoturn`` itself never touches
``langgraph``; only calling ``make_langgraph_handler()`` does.
"""
from __future__ import annotations

from typing import Any, Optional

from .client import Memoturn
from .langchain import MemoturnCallbackHandler


def make_langgraph_handler(memoturn: Optional[Memoturn] = None, *, trace_name: str = "langgraph") -> Any:
    """Build a combined LangChain + LangGraph callback handler.

    Pass the result in ``config={"callbacks": [...]}`` to a graph's ``invoke``/
    ``stream``/``ainvoke``/``astream``. Inherits ``MemoturnCallbackHandler``'s
    chain/LLM/tool recording unchanged (same trace tree, same ``memoturn=``/
    ``trace_name=`` semantics), and additionally records ``langgraph.interrupt`` /
    ``langgraph.resume`` trace events for LangGraph's own lifecycle callbacks, which
    a duck-typed handler can never receive (LangGraph filters ``config["callbacks"]``
    down to real ``GraphCallbackHandler`` instances via ``isinstance``).

    Raises ``ImportError`` with an install hint if ``langgraph`` isn't importable.
    """
    try:
        from langgraph.callbacks import GraphCallbackHandler
    except ImportError as e:
        raise ImportError(
            "memoturn.langgraph.make_langgraph_handler requires 'langgraph' — "
            "install it (`pip install \"memoturn[langgraph]\"`) to use the LangGraph integration."
        ) from e

    class MemoturnLangGraphHandler(MemoturnCallbackHandler, GraphCallbackHandler):
        """Combines LangChain's node-level callback recording with LangGraph's
        interrupt/resume lifecycle callbacks. Point-in-time markers are recorded via
        ``Trace.event()`` (not ``.span()``/``.generation()``), matching how the
        LlamaIndex integration records its own ``exception`` event type — these are
        instantaneous lifecycle notifications, not observations with a start/end."""

        def on_interrupt(self, event: Any) -> None:
            trace = self._ensure_trace()
            trace.event(
                name="langgraph.interrupt",
                level="WARNING",
                metadata={
                    "status": event.status,
                    "checkpointId": event.checkpoint_id,
                    "checkpointNs": list(event.checkpoint_ns),
                    "interrupts": [str(i) for i in event.interrupts],
                },
            )

        def on_resume(self, event: Any) -> None:
            trace = self._ensure_trace()
            trace.event(
                name="langgraph.resume",
                metadata={
                    "status": event.status,
                    "checkpointId": event.checkpoint_id,
                    "checkpointNs": list(event.checkpoint_ns),
                },
            )

    return MemoturnLangGraphHandler(memoturn, trace_name=trace_name)
