"""LangChain callback handler — records chains, LLM calls, and tools as a trace tree.

Pass an instance in ``callbacks=[...]``:

    from memoturn.langchain import MemoturnCallbackHandler
    chain.invoke(input, config={"callbacks": [MemoturnCallbackHandler()]})

Implemented without importing langchain (duck-typed) so the SDK has no hard dependency;
LangChain invokes these methods by name at runtime.
"""
from __future__ import annotations

from typing import Any, Optional
from uuid import UUID

from .client import Memoturn, Span, Trace
from .decorator import get_client


class MemoturnCallbackHandler:
    # LangChain reads these attributes off the handler.
    raise_error = False
    run_inline = True

    def __init__(self, client: Optional[Memoturn] = None, trace_name: str = "langchain") -> None:
        self._c = client or get_client()
        self._trace_name = trace_name
        self._trace: Optional[Trace] = None
        self._spans: dict[str, Span] = {}

    def _ensure_trace(self) -> Trace:
        if self._trace is None:
            self._trace = self._c.trace(name=self._trace_name)
        return self._trace

    # ── chains ──────────────────────────────────────────────────────────────
    def on_chain_start(self, serialized: Any, inputs: Any, *, run_id: UUID, **kwargs: Any) -> None:
        self._spans[str(run_id)] = self._ensure_trace().span(name="chain", input=inputs)

    def on_chain_end(self, outputs: Any, *, run_id: UUID, **kwargs: Any) -> None:
        self._end(run_id, output=outputs)

    def on_chain_error(self, error: BaseException, *, run_id: UUID, **kwargs: Any) -> None:
        self._end(run_id, level="ERROR", statusMessage=str(error))

    # ── LLMs ────────────────────────────────────────────────────────────────
    def on_llm_start(self, serialized: Any, prompts: list[str], *, run_id: UUID, **kwargs: Any) -> None:
        model = (kwargs.get("invocation_params") or {}).get("model") or (serialized or {}).get("name")
        self._spans[str(run_id)] = self._ensure_trace().generation(name="llm", model=model, input=prompts)

    def on_chat_model_start(self, serialized: Any, messages: Any, *, run_id: UUID, **kwargs: Any) -> None:
        model = (kwargs.get("invocation_params") or {}).get("model") or (serialized or {}).get("name")
        self._spans[str(run_id)] = self._ensure_trace().generation(name="chat", model=model, input=messages)

    def on_llm_end(self, response: Any, *, run_id: UUID, **kwargs: Any) -> None:
        usage = None
        try:
            tu = (response.llm_output or {}).get("token_usage") or {}
            usage = {
                "promptTokens": tu.get("prompt_tokens"),
                "completionTokens": tu.get("completion_tokens"),
                "totalTokens": tu.get("total_tokens"),
            }
        except Exception:  # noqa: BLE001
            pass
        self._end(run_id, output=getattr(response, "generations", response), usage=usage)

    def on_llm_error(self, error: BaseException, *, run_id: UUID, **kwargs: Any) -> None:
        self._end(run_id, level="ERROR", statusMessage=str(error))

    # ── tools ───────────────────────────────────────────────────────────────
    def on_tool_start(self, serialized: Any, input_str: str, *, run_id: UUID, **kwargs: Any) -> None:
        name = (serialized or {}).get("name", "tool")
        self._spans[str(run_id)] = self._ensure_trace().span(name=name, input=input_str)

    def on_tool_end(self, output: Any, *, run_id: UUID, **kwargs: Any) -> None:
        self._end(run_id, output=output)

    def on_tool_error(self, error: BaseException, *, run_id: UUID, **kwargs: Any) -> None:
        self._end(run_id, level="ERROR", statusMessage=str(error))

    # ── helpers ─────────────────────────────────────────────────────────────
    def _end(self, run_id: UUID, **body: Any) -> None:
        span = self._spans.pop(str(run_id), None)
        if span is not None:
            span.end(**{k: v for k, v in body.items() if v is not None})

    def flush(self) -> None:
        self._c.flush()
