"""Haystack 2.x tracing integration — plugs into Haystack's own tracing seam
(``haystack.tracing.Tracer``): every top-level ``Pipeline.run`` becomes one memoturn
trace, and every component run becomes a typed observation nested under it.

    from haystack import tracing
    from memoturn.haystack import MemoturnHaystackTracer

    tracing.enable_tracing(MemoturnHaystackTracer())
    tracing.tracer.is_content_tracing_enabled = True  # or HAYSTACK_CONTENT_TRACING_ENABLED=true

Haystack calls ``tracer.trace("haystack.pipeline.run", tags=...)`` around a pipeline run
(tags carry ``haystack.pipeline.input_data`` and a live reference to
``haystack.pipeline.output_data``) and ``tracer.trace("haystack.component.run",
tags=..., parent_span=...)`` around each component (tags carry
``haystack.component.name`` / ``haystack.component.type``; the actual
``haystack.component.input`` / ``output`` arrive via ``span.set_content_tag`` and are
only delivered when Haystack's content tracing is enabled — hence the flag above).

Component runs are classified by component class name: ``*Generator`` → GENERATION
(with model + usage extracted from the output's ``meta`` / ``replies[].meta``),
``*Retriever`` → RETRIEVER (documents mapped to ``retrievedDocuments``), ``*Embedder``
→ EMBEDDING, ``*Ranker`` → RERANKER, ``*Tool*`` → TOOL, ``*Agent*`` → AGENT, nested
pipelines → CHAIN, everything else a plain SPAN.

Duck-typed — imports no Haystack packages at module import time; ``enable_tracing``
only assigns the tracer (no ``isinstance`` check), and Haystack invokes ``trace()`` /
``current_span()`` / the span's ``set_tag`` family by name."""
from __future__ import annotations

import contextlib
from contextvars import ContextVar
from typing import Any, Iterator, Optional, Union

from .client import Memoturn, Span, Trace
from .decorator import get_client

_PIPELINE_INPUT = "haystack.pipeline.input_data"
_PIPELINE_OUTPUT = "haystack.pipeline.output_data"
_COMPONENT_NAME = "haystack.component.name"
_COMPONENT_TYPE = "haystack.component.type"
_COMPONENT_INPUT = "haystack.component.input"
_COMPONENT_OUTPUT = "haystack.component.output"

_MAX_DOC_LEN = 16 * 1024  # matches packages/core/src/events.ts MAX_MESSAGE_LEN
_MAX_EMBEDDING_DIM = 4096  # matches packages/core/src/events.ts MAX_EMBEDDING_DIM

# Class-name fragment → observation type, first match wins (so "generator" beats the
# "tool" fragment for hypothetical "ToolCallingGenerator"-style names).
_TYPE_FRAGMENTS: tuple[tuple[str, str], ...] = (
    ("generator", "GENERATION"),
    ("retriever", "RETRIEVER"),
    ("embedder", "EMBEDDING"),
    ("ranker", "RERANKER"),
    ("tool", "TOOL"),
    ("agent", "AGENT"),
)

# The per-context span stack: nesting fallback for spans Haystack starts without an
# explicit parent_span (e.g. a nested pipeline inside a SuperComponent), and the source
# for current_span(). A ContextVar (not a plain list) keeps AsyncPipeline's concurrently
# running components from mis-nesting.
_STACK: ContextVar[tuple] = ContextVar("memoturn_haystack_stack", default=())


def _content_tracing_enabled() -> bool:
    """Honor Haystack's content-tracing opt-in (real inputs/outputs are only recorded when
    the user enabled it). When Haystack isn't importable (tests), record everything."""
    try:
        from haystack import tracing  # noqa: PLC0415
    except Exception:  # noqa: BLE001
        return True
    try:
        return bool(tracing.tracer.is_content_tracing_enabled)
    except Exception:  # noqa: BLE001
        return True


class _HaystackSpan:
    """Duck-types ``haystack.tracing.Span``: collects tags; the wrapped memoturn handle is
    a Trace for pipeline runs, a Span/generation for component runs."""

    def __init__(self, handle: Union[Trace, Span], operation: str, obs_type: str) -> None:
        self._handle = handle
        self._operation = operation
        self._obs_type = obs_type  # "" for pipeline-as-trace
        self._tags: dict[str, Any] = {}

    # ── haystack.tracing.Span API ──────────────────────────────────────────────
    def set_tag(self, key: str, value: Any) -> None:
        self._tags[key] = value

    def set_tags(self, tags: dict) -> None:
        for k, v in (tags or {}).items():
            self.set_tag(k, v)

    def set_content_tag(self, key: str, value: Any) -> None:
        if _content_tracing_enabled():
            self.set_tag(key, value)

    def raw_span(self) -> Any:
        return self._handle

    def get_correlation_data_for_logs(self) -> dict[str, Any]:
        if isinstance(self._handle, Trace):
            return {"memoturn.trace_id": self._handle.id}
        return {"memoturn.trace_id": self._handle._trace_id, "memoturn.observation_id": self._handle.id}


class MemoturnHaystackTracer:
    def __init__(self, client: Optional[Memoturn] = None, trace_name: str = "haystack.pipeline") -> None:
        self._c = client or get_client()
        self._trace_name = trace_name

    # ── haystack.tracing.Tracer API ────────────────────────────────────────────
    @contextlib.contextmanager
    def trace(self, operation_name: str, tags: Optional[dict] = None, parent_span: Any = None) -> Iterator[_HaystackSpan]:
        span = self._start(operation_name, dict(tags or {}), parent_span)
        token = _STACK.set(_STACK.get() + (span,))
        error: Optional[BaseException] = None
        try:
            yield span
        except BaseException as e:
            error = e
            raise
        finally:
            _STACK.reset(token)
            self._end(span, error)

    def current_span(self) -> Optional[_HaystackSpan]:
        stack = _STACK.get()
        return stack[-1] if stack else None

    def flush(self) -> None:
        self._c.flush()

    # ── start side ─────────────────────────────────────────────────────────────
    def _start(self, operation_name: str, tags: dict, parent_span: Any) -> _HaystackSpan:
        parent = parent_span if isinstance(parent_span, _HaystackSpan) else self.current_span()
        try:
            if operation_name.endswith("pipeline.run"):  # haystack.pipeline.run / haystack.async_pipeline.run
                return self._start_pipeline(operation_name, tags, parent)
            return self._start_component(operation_name, tags, parent)
        except Exception:  # noqa: BLE001 — never break the host app; fall back to a bare span
            span = _HaystackSpan(self._ensure_parent(parent).span(name=operation_name), operation_name, "SPAN")
            span.set_tags(tags)
            return span

    def _start_pipeline(self, operation_name: str, tags: dict, parent: Optional[_HaystackSpan]) -> _HaystackSpan:
        if parent is None:
            # One memoturn trace per top-level pipeline run — the tracer is registered once
            # globally (enable_tracing), so without this boundary every run in the process's
            # lifetime would collapse into one giant trace.
            trace = self._c.trace(name=self._trace_name, input=tags.get(_PIPELINE_INPUT))
            span = _HaystackSpan(trace, operation_name, "")
        else:
            # A pipeline running inside another pipeline/component (e.g. SuperComponent) —
            # a CHAIN step inside the existing trace, not a new trace.
            handle = parent._handle.span(name=operation_name, observationType="CHAIN", input=tags.get(_PIPELINE_INPUT))
            span = _HaystackSpan(handle, operation_name, "CHAIN")
        span.set_tags(tags)
        return span

    def _start_component(self, operation_name: str, tags: dict, parent: Optional[_HaystackSpan]) -> _HaystackSpan:
        name = tags.get(_COMPONENT_NAME) or operation_name
        ctype = tags.get(_COMPONENT_TYPE) or ""
        obs_type = self._classify(ctype)
        parent_handle = self._ensure_parent(parent)
        metadata = {"componentType": ctype} if ctype else None
        if obs_type == "GENERATION":
            handle = parent_handle.generation(name=name, metadata=metadata)
        elif obs_type == "SPAN":
            handle = parent_handle.span(name=name, metadata=metadata)
        else:
            handle = parent_handle.span(name=name, observationType=obs_type, metadata=metadata)
        span = _HaystackSpan(handle, operation_name, obs_type)
        span.set_tags(tags)
        return span

    def _ensure_parent(self, parent: Optional[_HaystackSpan]) -> Union[Trace, Span]:
        if parent is not None:
            return parent._handle
        # A component traced outside any pipeline run — record it, on a fresh trace.
        return self._c.trace(name=self._trace_name)

    def _classify(self, component_type: str) -> str:
        lowered = component_type.lower()
        for fragment, obs_type in _TYPE_FRAGMENTS:
            if fragment in lowered:
                return obs_type
        return "SPAN"

    # ── end side ───────────────────────────────────────────────────────────────
    def _end(self, span: _HaystackSpan, error: Optional[BaseException]) -> None:
        try:
            handle = span._handle
            if isinstance(handle, Trace):
                body: dict[str, Any] = {}
                output = span._tags.get(_PIPELINE_OUTPUT)
                if output is not None:
                    body["output"] = output
                if error is not None:
                    body["metadata"] = {"error": str(error)}
                if body:
                    handle.update(**body)
                return
            handle.end(**self._end_body(span, error))
        except Exception:  # noqa: BLE001 — never break the host app
            pass

    def _end_body(self, span: _HaystackSpan, error: Optional[BaseException]) -> dict:
        body: dict[str, Any] = {}
        if error is not None:
            body["level"] = "ERROR"
            body["statusMessage"] = str(error)
        if span._obs_type == "CHAIN":  # nested pipeline
            output = span._tags.get(_PIPELINE_OUTPUT)
            if output is not None:
                body["output"] = output
            return body
        inp = span._tags.get(_COMPONENT_INPUT)
        if inp is not None:
            body["input"] = inp
        output = span._tags.get(_COMPONENT_OUTPUT)
        if output is None:
            return body
        if span._obs_type == "GENERATION":
            body["output"] = output
            model, usage = _model_and_usage(output)
            if model is not None:
                body["model"] = model
            if usage is not None:
                body["usage"] = usage
        elif span._obs_type in ("RETRIEVER", "RERANKER"):
            docs = _retrieved_documents(_dict_get(output, "documents"))
            if docs is not None:
                body["retrievedDocuments"] = docs
                body["output"] = f"{len(docs)} document(s)"
            else:
                body["output"] = output
        elif span._obs_type == "EMBEDDING":
            vector = _dict_get(output, "embedding")
            if isinstance(vector, list) and vector and isinstance(vector[0], (int, float)):
                body["embedding"] = vector[:_MAX_EMBEDDING_DIM]
                body["output"] = f"{len(vector)}-dim embedding"
            else:
                docs = _dict_get(output, "documents")
                body["output"] = f"{len(docs)} document(s) embedded" if isinstance(docs, list) else output
        else:
            body["output"] = output
        return body


# ── extraction helpers (all defensive — never raise into the host app) ─────────────


def _dict_get(obj: Any, key: str) -> Any:
    if isinstance(obj, dict):
        return obj.get(key)
    return getattr(obj, key, None)


def _model_and_usage(output: Any) -> tuple[Optional[str], Optional[dict]]:
    """Generator components put per-reply metadata either in ``output["meta"]`` (string
    replies: a list of dicts) or on each ChatMessage's ``.meta`` in ``output["replies"]``."""
    try:
        metas = _dict_get(output, "meta")
        if not isinstance(metas, list) or not metas:
            metas = []
            for reply in _dict_get(output, "replies") or []:
                meta = _dict_get(reply, "meta") or _dict_get(reply, "_meta")
                if isinstance(meta, dict):
                    metas.append(meta)
        for meta in metas:
            if not isinstance(meta, dict):
                continue
            model = meta.get("model")
            usage = _map_usage(meta.get("usage"))
            if model is not None or usage is not None:
                return (model if isinstance(model, str) else None), usage
    except Exception:  # noqa: BLE001
        pass
    return None, None


def _map_usage(usage: Any) -> Optional[dict]:
    if usage is None:
        return None
    try:
        prompt = _int(_dict_get(usage, "prompt_tokens"))
        completion = _int(_dict_get(usage, "completion_tokens"))
        total = _int(_dict_get(usage, "total_tokens"))
        if prompt is None and completion is None:
            # Anthropic-style meta on some Haystack generators.
            prompt = _int(_dict_get(usage, "input_tokens"))
            completion = _int(_dict_get(usage, "output_tokens"))
        if prompt is None and completion is None and total is None:
            return None
        if total is None and prompt is not None and completion is not None:
            total = prompt + completion
        # Omit absent fields entirely — the ingest schema treats them as optional but
        # rejects explicit nulls.
        usage_body = {"promptTokens": prompt, "completionTokens": completion, "totalTokens": total}
        return {k: v for k, v in usage_body.items() if v is not None}
    except Exception:  # noqa: BLE001
        return None


def _int(value: Any) -> Optional[int]:
    try:
        return int(value) if value is not None else None
    except (TypeError, ValueError):
        return None


def _retrieved_documents(documents: Any) -> Optional[list]:
    if not isinstance(documents, list) or not documents:
        return None
    docs = []
    try:
        for i, d in enumerate(documents):
            content = _dict_get(d, "content")
            doc: dict[str, Any] = {"rank": i, "content": str(content if content is not None else "")[:_MAX_DOC_LEN]}
            doc_id = _dict_get(d, "id")
            if isinstance(doc_id, str):
                doc["id"] = doc_id
            score = _dict_get(d, "score")
            if isinstance(score, (int, float)):
                doc["score"] = score
            meta = _dict_get(d, "meta")
            if isinstance(meta, dict):
                doc["metadata"] = meta
            docs.append(doc)
    except Exception:  # noqa: BLE001
        return docs or None
    return docs or None
