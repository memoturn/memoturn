"""LlamaIndex callback handler — records query/retrieve/synthesize/LLM/tool/agent
events as a properly nested trace tree (unlike the LangChain handler, which
intentionally flattens everything under one trace, LlamaIndex hands us accurate
parent ids for free via ``parent_id``, so this handler nests real children).

Pass an instance to LlamaIndex's callback manager:

    from memoturn.llamaindex import MemoturnLlamaIndexHandler
    from llama_index.core import Settings
    from llama_index.core.callbacks import CallbackManager

    Settings.callback_manager = CallbackManager([MemoturnLlamaIndexHandler()])

Implemented without importing llama_index (duck-typed) so the SDK has no hard
dependency; LlamaIndex invokes these methods by name/attribute at runtime and only
checks ``event_type not in handler.event_starts_to_ignore``, never ``isinstance``.
"""
from __future__ import annotations

from typing import Any, Optional
from uuid import uuid4

from .client import Memoturn, Span, Trace
from .decorator import get_client

_GENERATION = "llm"
_TOOL = "function_call"
_AGENT = "agent_step"
_EXCEPTION = "exception"

# Retrieval-shaped events: end payload carries "nodes" (List[NodeWithScore]) that map
# onto memoturn's retrievedDocuments.
_DOCUMENT_EVENTS = {"retrieve": "RETRIEVER", "reranking": "RERANKER"}

# Orchestration steps with no LLM/tool/doc semantics of their own — CHAIN, matching
# OpenInference's "non-leaf composite step" semantics.
_CHAIN_EVENTS = {"query", "synthesize", "tree", "sub_question"}

_TYPE_MAP = {"embedding": "EMBEDDING", **_DOCUMENT_EVENTS}

_MAX_DOC_LEN = 16 * 1024  # matches packages/core/src/events.ts MAX_MESSAGE_LEN


def _first(payload: dict, *keys: str) -> Any:
    for k in keys:
        v = payload.get(k)
        if v is not None:
            return v
    return None


class MemoturnLlamaIndexHandler:
    # LlamaIndex's CallbackManager reads these attributes off the handler.
    event_starts_to_ignore: tuple = ()
    event_ends_to_ignore: tuple = ()

    def __init__(self, client: Optional[Memoturn] = None, trace_name: str = "llama-index") -> None:
        self._c = client or get_client()
        self._trace_name = trace_name
        self._trace: Optional[Trace] = None
        self._nodes: dict[str, Span] = {}

    def _ensure_trace(self, name: Optional[str] = None) -> Trace:
        if self._trace is None:
            self._trace = self._c.trace(name=name or self._trace_name)
        return self._trace

    # ── trace lifecycle ────────────────────────────────────────────────────
    def start_trace(self, trace_id: Optional[str] = None) -> None:
        # One memoturn Trace per top-level LlamaIndex operation — a handler is commonly
        # registered once globally (Settings.callback_manager) and reused across many
        # independent query() calls, so without this boundary every query in the
        # process's lifetime would collapse into one giant trace.
        self._trace = self._c.trace(name=trace_id or self._trace_name)
        self._nodes = {}

    def end_trace(self, trace_id: Optional[str] = None, trace_map: Optional[dict] = None) -> None:
        self._trace = None
        self._nodes = {}

    # ── events ──────────────────────────────────────────────────────────────
    def on_event_start(
        self, event_type: str, payload: Optional[dict] = None,
        event_id: str = "", parent_id: str = "", **kwargs: Any,
    ) -> str:
        event_id = event_id or str(uuid4())
        payload = payload or {}
        if event_type == _EXCEPTION:
            self._record_exception(parent_id, payload)
            return event_id
        try:
            self._nodes[event_id] = self._start_observation(event_type, payload, parent_id)
        except Exception:  # noqa: BLE001 — never break the host app on a malformed payload
            pass
        return event_id

    def on_event_end(
        self, event_type: str, payload: Optional[dict] = None, event_id: str = "", **kwargs: Any,
    ) -> None:
        if event_type == _EXCEPTION:
            return  # recorded synchronously at on_event_start; no matching "end"
        node = self._nodes.pop(event_id, None)
        if node is None:
            return
        try:
            node.end(**self._end_body(event_type, payload or {}))
        except Exception:  # noqa: BLE001
            pass

    # ── start-side mapping ──────────────────────────────────────────────────
    def _start_observation(self, event_type: str, payload: dict, parent_id: str) -> Span:
        trace = self._ensure_trace()
        parent = self._nodes.get(parent_id, trace)

        if event_type == _GENERATION:
            return parent.generation(
                name=event_type, model=self._model_name(payload),
                input=_first(payload, "messages", "formatted_prompt"),
            )
        if event_type == _TOOL:
            return parent.tool(name=event_type, input=_first(payload, "function_call"))
        if event_type == _AGENT:
            return parent.agent(name=event_type, input=_first(payload, "messages", "query_str"))
        if event_type in _TYPE_MAP:
            kw: dict[str, Any] = {"name": event_type, "observationType": _TYPE_MAP[event_type]}
            if event_type == "embedding":
                kw["input"] = _first(payload, "chunks", "documents")
            elif event_type == "retrieve":
                kw["input"] = payload.get("query_str")
                if payload.get("top_k") is not None:
                    kw["metadata"] = {"topK": payload.get("top_k")}
            return parent.span(**kw)
        if event_type in _CHAIN_EVENTS:
            return parent.span(
                name=event_type, observationType="CHAIN", input=_first(payload, "query_str", "messages"),
            )
        # Utility steps (templating/chunking/node_parsing) and anything unrecognized —
        # generic SPAN, still nested correctly.
        return parent.span(name=event_type, input=_first(payload, "template", "chunks", "documents"))

    # ── end-side mapping ────────────────────────────────────────────────────
    def _end_body(self, event_type: str, payload: dict) -> dict:
        body: dict[str, Any] = {}
        try:
            if event_type == _GENERATION:
                response = payload.get("response")
                output = self._llm_output(response) if response is not None else payload.get("completion")
                if output is not None:
                    body["output"] = output
                usage = self._usage(response)
                if usage is not None:
                    body["usage"] = usage
            elif event_type in _DOCUMENT_EVENTS:
                docs = self._retrieved_documents(payload.get("nodes"))
                if docs is not None:
                    body["retrievedDocuments"] = docs
                    body["output"] = f"{len(docs)} document(s)"
            elif event_type == "embedding":
                vectors = payload.get("embeddings")
                if vectors:
                    first = vectors[0] if isinstance(vectors, list) else None
                    if isinstance(first, list):
                        body["embedding"] = first
                    body["output"] = f"{len(vectors)} embedding(s)"
            elif event_type == _TOOL:
                out = payload.get("function_call_response")
                if out is not None:
                    body["output"] = out
            else:
                out = _first(payload, "response", "completion")
                if out is not None:
                    body["output"] = out if isinstance(out, (str, int, float, bool)) else str(out)
        except Exception:  # noqa: BLE001
            pass
        return body

    # ── exceptions ──────────────────────────────────────────────────────────
    def _record_exception(self, parent_id: str, payload: dict) -> None:
        try:
            exc = payload.get("exception")
            trace = self._ensure_trace()
            parent = self._nodes.get(parent_id)
            trace.event(
                name="exception",
                level="ERROR",
                statusMessage=str(exc) if exc is not None else "unknown error",
                parentObservationId=getattr(parent, "id", None),
            )
        except Exception:  # noqa: BLE001
            pass

    # ── extraction helpers (all defensive — never raise into the host app) ──
    def _model_name(self, payload: dict) -> Optional[str]:
        try:
            return payload.get("model_name") or (payload.get("serialized") or {}).get("model")
        except Exception:  # noqa: BLE001
            return None

    def _llm_output(self, response: Any) -> Any:
        try:
            message = getattr(response, "message", None)
            if message is not None:
                content = getattr(message, "content", None)
                return content if content is not None else str(message)
            text = getattr(response, "text", None)
            return text if text is not None else str(response)
        except Exception:  # noqa: BLE001
            return None

    def _usage(self, response: Any) -> Optional[dict]:
        # LlamaIndex doesn't standardize a usage location the way LangChain's
        # llm_output["token_usage"] does — best-effort: response.raw["usage"]
        # (OpenAI-shaped) or response.additional_kwargs.
        try:
            raw = getattr(response, "raw", None)
            u = raw.get("usage") if isinstance(raw, dict) else None
            if u is None:
                ak = getattr(response, "additional_kwargs", None) or {}
                u = ak.get("usage")
            if not u:
                return None
            get = u.get if isinstance(u, dict) else (lambda k: getattr(u, k, None))
            return {
                "promptTokens": get("prompt_tokens"),
                "completionTokens": get("completion_tokens"),
                "totalTokens": get("total_tokens"),
            }
        except Exception:  # noqa: BLE001
            return None

    def _retrieved_documents(self, nodes: Any) -> Optional[list]:
        if not nodes:
            return None
        docs = []
        try:
            for i, item in enumerate(nodes):
                node = getattr(item, "node", item)
                try:
                    content = node.get_content()
                except Exception:  # noqa: BLE001
                    content = getattr(node, "text", "") or ""
                content = str(content)[:_MAX_DOC_LEN]
                docs.append({
                    "rank": i,
                    "id": getattr(node, "node_id", None),
                    "score": getattr(item, "score", None),
                    "content": content,
                    "metadata": getattr(node, "metadata", None),
                })
        except Exception:  # noqa: BLE001
            return docs or None
        return docs or None

    def flush(self) -> None:
        self._c.flush()
