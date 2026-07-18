"""Drop-in wrapper for a Cohere client (``cohere`` v5+) — records ``client.chat`` and
``client.chat_stream`` as generations, handling both API generations in one wrapper:

- **ClientV2** (``cohere.ClientV2``): ``chat()`` returns ``{message: {role, content:
  [{type: "text", text}, ...], tool_calls}, usage: {tokens: {input_tokens, output_tokens},
  billed_units: {...}}}``; ``chat_stream()`` yields typed events discriminated by ``.type``
  (``content-delta`` carries ``event.delta.message.content.text``; ``message-end`` carries
  ``event.delta.usage``).
- **legacy Client** (v1 API): ``chat()`` returns ``{text, meta: {tokens: {input_tokens,
  output_tokens}}}``; ``chat_stream()`` yields events discriminated by ``.event_type``
  (``text-generation`` carries ``.text``; ``stream-end`` carries the full ``.response``).

Both shapes are probed defensively per response, so the same ``wrap_cohere`` works on
either client. Cohere reports token counts as floats and never a total — usage is
int-coerced and ``totalTokens`` computed as input + output."""
from __future__ import annotations

from typing import Any, Optional

from ._stream import _ABANDONED, _RecordingStream, _get
from .client import Memoturn, Trace
from .decorator import get_client

_EXCLUDED_PARAMS = ("model", "messages", "message", "chat_history")


def wrap_cohere(client: Any, memoturn: Optional[Memoturn] = None, *, trace: Optional[Trace] = None) -> Any:
    mt = memoturn or get_client()
    original_chat = client.chat
    original_stream = getattr(client, "chat_stream", None)

    def chat(*args: Any, **kwargs: Any) -> Any:
        gen = _start(mt, trace, kwargs)
        try:
            resp = original_chat(*args, **kwargs)
        except Exception as e:  # noqa: BLE001
            gen.end(level="ERROR", statusMessage=str(e))
            raise
        gen.end(output=_output(resp), usage=_usage_from_response(resp))
        return resp

    def chat_stream(*args: Any, **kwargs: Any) -> Any:
        gen = _start(mt, trace, kwargs)
        try:
            resp = original_stream(*args, **kwargs)
        except Exception as e:  # noqa: BLE001
            gen.end(level="ERROR", statusMessage=str(e))
            raise

        acc = _CohereStreamAccumulator()

        def on_done(err: Any) -> None:
            output, usage = acc.finalize()
            if err is _ABANDONED:
                gen.end(level="WARNING", statusMessage="stream ended before completion", output=output, usage=usage)
            elif err is not None:
                gen.end(level="ERROR", statusMessage=str(err), output=output, usage=usage)
            else:
                gen.end(output=output, usage=usage)

        return _RecordingStream(resp, acc.add, on_done)

    client.chat = chat  # type: ignore[assignment]
    if original_stream is not None:
        client.chat_stream = chat_stream  # type: ignore[assignment]
    return client


def _start(mt: Memoturn, trace: Optional[Trace], kwargs: dict) -> Any:
    t = trace or mt.trace(name="cohere.chat")
    model_parameters = {k: v for k, v in kwargs.items() if k not in _EXCLUDED_PARAMS}
    return t.generation(
        name="cohere.chat", model=kwargs.get("model"), provider="cohere",
        input=_input(kwargs), modelParameters=model_parameters,
    )


def _input(kwargs: dict) -> Any:
    if kwargs.get("messages") is not None:  # v2
        return kwargs["messages"]
    if kwargs.get("chat_history") is not None:  # v1 with history
        return {"chatHistory": kwargs["chat_history"], "message": kwargs.get("message")}
    return kwargs.get("message")  # v1


def _output(resp: Any) -> Any:
    try:
        message = _get(resp, "message")
        if message is not None:  # v2
            if hasattr(message, "model_dump"):
                return message.model_dump()
            return {"role": _get(message, "role") or "assistant", "content": _content_text(_get(message, "content"))}
        text = _get(resp, "text")
        if text is not None:  # v1
            return {"role": "assistant", "content": text}
        return resp
    except Exception:  # noqa: BLE001
        return resp


def _content_text(content: Any) -> str:
    """v2 message content is a list of typed items; concatenate the text ones."""
    if isinstance(content, str):
        return content
    parts = []
    for item in content or []:
        text = _get(item, "text")
        if isinstance(text, str):
            parts.append(text)
    return "".join(parts)


def _usage_from_response(resp: Any) -> Optional[dict]:
    usage = _get(resp, "usage")  # v2: {tokens, billed_units}
    if usage is not None:
        return _map_usage(usage)
    meta = _get(resp, "meta")  # v1: meta.tokens / meta.billed_units — same field names
    if meta is not None:
        return _map_usage(meta)
    return None


def _map_usage(container: Any) -> Optional[dict]:
    tokens = _get(container, "tokens")
    if tokens is None:
        tokens = _get(container, "billed_units")
    if tokens is None:
        return None
    prompt = _int(_get(tokens, "input_tokens"))
    completion = _int(_get(tokens, "output_tokens"))
    if prompt is None and completion is None:
        return None
    # Omit absent fields entirely — the ingest schema treats them as optional but
    # rejects explicit nulls; Cohere never reports a total, so it's computed.
    usage = {"promptTokens": prompt, "completionTokens": completion}
    if prompt is not None and completion is not None:
        usage["totalTokens"] = prompt + completion
    return {k: v for k, v in usage.items() if v is not None}


def _int(value: Any) -> Optional[int]:
    """Cohere reports token counts as floats; the wire contract wants nonnegative ints."""
    try:
        return int(value) if value is not None else None
    except (TypeError, ValueError):
        return None


class _CohereStreamAccumulator:
    """Accumulates text deltas across both stream generations (v2 ``.type`` events and v1
    ``.event_type`` events) and captures usage from the final event of either shape."""

    def __init__(self) -> None:
        self._text: list[str] = []
        self._usage: Optional[dict] = None

    def add(self, event: Any) -> None:
        kind = _get(event, "type") or _get(event, "event_type")
        if kind == "content-delta":  # v2 text delta
            delta = _get(event, "delta")
            message = _get(delta, "message")
            text = _get(_get(message, "content"), "text")
            if isinstance(text, str):
                self._text.append(text)
        elif kind == "text-generation":  # v1 text delta
            text = _get(event, "text")
            if isinstance(text, str):
                self._text.append(text)
        elif kind == "message-end":  # v2 final event
            usage = _map_usage(_get(_get(event, "delta"), "usage"))
            if usage is not None:
                self._usage = usage
        elif kind == "stream-end":  # v1 final event: carries the whole non-streamed response
            response = _get(event, "response")
            usage = _usage_from_response(response) if response is not None else None
            if usage is not None:
                self._usage = usage
            if not self._text:
                text = _get(response, "text")
                if isinstance(text, str):
                    self._text.append(text)

    def finalize(self) -> tuple[Any, Optional[dict]]:
        output = {"role": "assistant", "content": "".join(self._text)} if self._text else None
        return output, self._usage
