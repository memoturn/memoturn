"""Drop-in wrapper for a Groq client (groq-sdk) — records chat.completions.create as a
generation. Groq's SDK is Stainless-generated and structurally close to openai-python,
but its create() has a strict, fully-enumerated parameter list with no stream_options
field and no catch-all kwargs — passing stream_options (as wrap_openai does) raises
TypeError on every streaming call, so this is a small dedicated wrapper rather than
reusing wrap_openai. Chat completions only — Groq has no Responses API."""
from __future__ import annotations

from typing import Any, Optional

from ._stream import _ABANDONED, _RecordingStream, _get
from .client import Memoturn, Trace
from .decorator import get_client


def wrap_groq(client: Any, memoturn: Optional[Memoturn] = None, *, trace: Optional[Trace] = None) -> Any:
    mt = memoturn or get_client()
    original = client.chat.completions.create

    def create(*args: Any, **kwargs: Any) -> Any:
        t = trace or mt.trace(name="groq.chat")
        model = kwargs.get("model")
        messages = kwargs.get("messages")
        streaming = bool(kwargs.get("stream"))
        model_parameters = {k: v for k, v in kwargs.items() if k not in ("model", "messages", "stream")}
        gen = t.generation(name="groq.chat", model=model, provider="groq", input=messages, modelParameters=model_parameters)
        try:
            resp = original(*args, **kwargs)
            if not streaming:
                gen.end(output=_message(resp), usage=_map_usage(_get(resp, "usage")))
                return resp
        except Exception as e:  # noqa: BLE001
            gen.end(level="ERROR", statusMessage=str(e))
            raise

        acc = _GroqAccumulator()

        def on_chunk(chunk: Any) -> None:
            acc.add(chunk)

        def on_done(err: Any) -> None:
            output, usage = acc.finalize()
            if err is _ABANDONED:
                gen.end(level="WARNING", statusMessage="stream ended before completion", output=output, usage=usage)
            elif err is not None:
                gen.end(level="ERROR", statusMessage=str(err), output=output, usage=usage)
            else:
                gen.end(output=output, usage=usage)

        return _RecordingStream(resp, on_chunk, on_done)

    client.chat.completions.create = create  # type: ignore[assignment]
    return client


def _message(resp: Any) -> Any:
    try:
        choices = _get(resp, "choices") or []
        message = _get(choices[0], "message") if choices else None
        return message.model_dump() if hasattr(message, "model_dump") else message
    except Exception:  # noqa: BLE001
        return resp


def _map_usage(usage: Any) -> Optional[dict]:
    if usage is None:
        return None
    return {
        "promptTokens": _get(usage, "prompt_tokens"),
        "completionTokens": _get(usage, "completion_tokens"),
        "totalTokens": _get(usage, "total_tokens"),
    }


class _GroqAccumulator:
    def __init__(self) -> None:
        self._choices: dict[int, dict] = {}
        self._usage: Any = None

    def add(self, chunk: Any) -> None:
        for choice in _get(chunk, "choices") or []:
            i = _get(choice, "index") or 0
            entry = self._choices.setdefault(i, {"role": None, "content": ""})
            delta = _get(choice, "delta")
            if delta is None:
                continue
            role = _get(delta, "role")
            if role:
                entry["role"] = role
            content = _get(delta, "content")
            if content:
                entry["content"] += content
            tool_calls = _get(delta, "tool_calls")
            if tool_calls:
                entry.setdefault("tool_calls", {})
                for tc in tool_calls:
                    idx = _get(tc, "index") or 0
                    t = entry["tool_calls"].setdefault(idx, {"id": _get(tc, "id"), "type": _get(tc, "type"),
                                                              "function": {"name": "", "arguments": ""}})
                    fn = _get(tc, "function")
                    if fn is not None:
                        name = _get(fn, "name")
                        if name:
                            t["function"]["name"] = name
                        args = _get(fn, "arguments")
                        if args:
                            t["function"]["arguments"] += args
        usage = _get(chunk, "usage")
        if usage is not None:
            self._usage = usage

    def finalize(self) -> tuple[Any, Optional[dict]]:
        ordered = [self._choices[i] for i in sorted(self._choices)]
        return (ordered[0] if len(ordered) <= 1 else ordered), _map_usage(self._usage)
