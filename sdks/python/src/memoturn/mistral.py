"""Drop-in wrapper for a Mistral client (``mistralai`` v1) — records ``client.chat.complete``
and ``client.chat.stream`` as generations. Mistral's non-streaming response is
OpenAI-chat-shaped (``choices[0].message``, snake_case ``usage.prompt_tokens`` /
``completion_tokens`` / ``total_tokens``), so mapping mirrors ``wrap_groq``; streaming is a
dedicated ``stream()`` method (not ``stream=True``) whose events wrap the chunk one level
deeper (``event.data.choices[].delta``), and whose delta ``content`` may be either a plain
string or a list of typed content chunks (``{"type": "text", "text": ...}``)."""
from __future__ import annotations

from typing import Any, Optional

from ._stream import _ABANDONED, _RecordingStream, _get
from .client import Memoturn, Trace
from .decorator import get_client

_EXCLUDED_PARAMS = ("model", "messages", "stream")


def wrap_mistral(client: Any, memoturn: Optional[Memoturn] = None, *, trace: Optional[Trace] = None) -> Any:
    mt = memoturn or get_client()
    original_complete = client.chat.complete
    original_stream = getattr(client.chat, "stream", None)

    def complete(*args: Any, **kwargs: Any) -> Any:
        gen = _start(mt, trace, kwargs)
        try:
            resp = original_complete(*args, **kwargs)
        except Exception as e:  # noqa: BLE001
            gen.end(level="ERROR", statusMessage=str(e))
            raise
        gen.end(output=_message(resp), usage=_map_usage(_get(resp, "usage")))
        return resp

    def stream(*args: Any, **kwargs: Any) -> Any:
        gen = _start(mt, trace, kwargs)
        try:
            resp = original_stream(*args, **kwargs)
        except Exception as e:  # noqa: BLE001
            gen.end(level="ERROR", statusMessage=str(e))
            raise

        acc = _MistralAccumulator()

        def on_done(err: Any) -> None:
            output, usage = acc.finalize()
            if err is _ABANDONED:
                gen.end(level="WARNING", statusMessage="stream ended before completion", output=output, usage=usage)
            elif err is not None:
                gen.end(level="ERROR", statusMessage=str(err), output=output, usage=usage)
            else:
                gen.end(output=output, usage=usage)

        return _RecordingStream(resp, acc.add, on_done)

    client.chat.complete = complete  # type: ignore[assignment]
    if original_stream is not None:
        client.chat.stream = stream  # type: ignore[assignment]
    return client


def _start(mt: Memoturn, trace: Optional[Trace], kwargs: dict) -> Any:
    t = trace or mt.trace(name="mistral.chat")
    model_parameters = {k: v for k, v in kwargs.items() if k not in _EXCLUDED_PARAMS}
    return t.generation(
        name="mistral.chat", model=kwargs.get("model"), provider="mistral",
        input=kwargs.get("messages"), modelParameters=model_parameters,
    )


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


def _delta_text(content: Any) -> str:
    """Delta content is a plain string or a list of typed chunks (TextChunk & friends)."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for item in content:
            text = _get(item, "text")
            if isinstance(text, str):
                parts.append(text)
        return "".join(parts)
    return ""


class _MistralAccumulator:
    """Accumulates ``event.data.choices[].delta`` across CompletionEvents, mirroring the
    Groq/OpenAI chat-completions accumulator (content concatenation + tool-call argument
    fragments by index), and captures usage from whichever chunk carries it (the last)."""

    def __init__(self) -> None:
        self._choices: dict[int, dict] = {}
        self._usage: Any = None

    def add(self, event: Any) -> None:
        chunk = _get(event, "data")
        if chunk is None:
            chunk = event  # tolerate un-wrapped chunks
        for choice in _get(chunk, "choices") or []:
            i = _get(choice, "index") or 0
            entry = self._choices.setdefault(i, {"role": None, "content": ""})
            delta = _get(choice, "delta")
            if delta is None:
                continue
            role = _get(delta, "role")
            if role:
                entry["role"] = role
            content = _delta_text(_get(delta, "content"))
            if content:
                entry["content"] += content
            tool_calls = _get(delta, "tool_calls")
            if tool_calls:
                entry.setdefault("tool_calls", {})
                for pos, tc in enumerate(tool_calls):
                    idx = _get(tc, "index")
                    if idx is None:
                        idx = pos
                    t = entry["tool_calls"].setdefault(idx, {"id": _get(tc, "id"), "type": _get(tc, "type"),
                                                              "function": {"name": "", "arguments": ""}})
                    fn = _get(tc, "function")
                    if fn is not None:
                        name = _get(fn, "name")
                        if name:
                            t["function"]["name"] = name
                        args = _get(fn, "arguments")
                        if isinstance(args, str) and args:
                            if isinstance(t["function"]["arguments"], str):
                                t["function"]["arguments"] += args
                            else:
                                t["function"]["arguments"] = args
                        elif args is not None:
                            # Mistral may deliver arguments as an already-parsed dict — replace.
                            t["function"]["arguments"] = args
        usage = _get(chunk, "usage")
        if usage is not None:
            self._usage = usage

    def finalize(self) -> tuple[Any, Optional[dict]]:
        ordered = []
        for i in sorted(self._choices):
            entry = self._choices[i]
            tool_calls = entry.get("tool_calls")
            if isinstance(tool_calls, dict):
                entry["tool_calls"] = [tool_calls[j] for j in sorted(tool_calls)]
            ordered.append(entry)
        return (ordered[0] if len(ordered) <= 1 else ordered), _map_usage(self._usage)
