"""Drop-in Anthropic wrapper — records ``messages.create`` calls (including streaming)
as generations."""
from __future__ import annotations

import json
from typing import Any, Optional

from ._stream import _ABANDONED, _RecordingStream, _get
from .client import Memoturn, Trace
from .decorator import get_client

#: Model parameters copied onto the generation (allowlist — everything else is dropped).
_PARAM_KEYS = ("max_tokens", "temperature", "top_p", "top_k", "stop_sequences")


def wrap_anthropic(client: Any, memoturn: Optional[Memoturn] = None, *, trace: Optional[Trace] = None) -> Any:
    """Patch ``client.messages.create`` to trace calls. Returns the same client.

    Streaming calls (``stream=True``) are recorded too: the returned stream is wrapped so
    chunks are forwarded unchanged to the caller while being accumulated into the same
    output/usage shape as a non-streaming call, and the generation is closed when the
    stream is exhausted, errors, or is abandoned (closed/garbage-collected/idle-timed-out
    before completion).
    """
    mt = memoturn or get_client()
    _patch_messages(client, mt, trace)
    return client


def _patch_messages(client: Any, mt: Memoturn, trace: Optional[Trace]) -> None:
    messages = client.messages
    original = messages.create

    def create(*args: Any, **kwargs: Any) -> Any:
        t = trace or mt.trace(name="anthropic.messages")
        system = kwargs.get("system")
        msgs = kwargs.get("messages")
        gen = t.generation(
            name="anthropic.messages",
            model=kwargs.get("model"),
            provider="anthropic",
            # Keep the system prompt alongside the messages when present.
            input={"system": system, "messages": msgs} if system is not None else msgs,
            modelParameters={k: v for k, v in kwargs.items() if k in _PARAM_KEYS},
        )

        if kwargs.get("stream"):
            return _stream_messages(original, args, kwargs, gen)

        try:
            resp = original(*args, **kwargs)
            gen.end(output=_content(resp), usage=_usage(resp))
            return resp
        except Exception as e:  # noqa: BLE001
            gen.end(level="ERROR", statusMessage=str(e))
            raise

    messages.create = create  # type: ignore[assignment]


def _stream_messages(original: Any, args: tuple, kwargs: dict, gen: Any) -> Any:
    try:
        raw = original(*args, **kwargs)
    except Exception as e:  # noqa: BLE001
        gen.end(level="ERROR", statusMessage=str(e))
        raise

    acc = _AnthropicAccumulator()

    def on_chunk(event: Any) -> None:
        acc.add(event)

    def on_done(err: Any) -> None:
        output, usage = acc.finalize()
        if err is _ABANDONED:
            gen.end(level="WARNING", statusMessage="stream ended before completion", output=output, usage=usage)
        elif err is not None:
            gen.end(level="ERROR", statusMessage=str(err), output=output, usage=usage)
        else:
            gen.end(output=output, usage=usage)

    return _RecordingStream(raw, on_chunk, on_done)


class _AnthropicAccumulator:
    """Accumulates ``messages.create`` streaming events (``message_start`` /
    ``content_block_*`` / ``message_delta``) into the same ``(output, usage)`` shape the
    non-streaming path builds."""

    def __init__(self) -> None:
        self._blocks: dict[int, dict[str, Any]] = {}
        self._json_buffers: dict[int, str] = {}
        self._input_tokens: Optional[int] = None
        self._output_tokens: Optional[int] = None
        self._cache_read_tokens: Optional[int] = None
        self._cache_creation_tokens: Optional[int] = None

    def add(self, event: Any) -> None:
        etype = _get(event, "type")
        if etype == "message_start":
            self._on_message_start(event)
        elif etype == "content_block_start":
            self._on_block_start(event)
        elif etype == "content_block_delta":
            self._on_block_delta(event)
        elif etype == "content_block_stop":
            self._on_block_stop(event)
        elif etype == "message_delta":
            self._on_message_delta(event)

    def _on_message_start(self, event: Any) -> None:
        message = _get(event, "message")
        usage = _get(message, "usage") if message is not None else None
        if usage is None:
            return
        self._input_tokens = _get(usage, "input_tokens")
        self._cache_read_tokens = _get(usage, "cache_read_input_tokens")
        self._cache_creation_tokens = _get(usage, "cache_creation_input_tokens")

    def _on_block_start(self, event: Any) -> None:
        index = _get(event, "index", 0)
        block = _get(event, "content_block")
        init: dict[str, Any] = {}
        if block is not None:
            btype = _get(block, "type")
            if btype is not None:
                init["type"] = btype
            for key in ("id", "name"):
                val = _get(block, key)
                if val is not None:
                    init[key] = val
            if btype == "text":
                init["text"] = _get(block, "text") or ""
            if btype == "thinking":
                init["thinking"] = _get(block, "thinking") or ""
        self._blocks[index] = init

    def _on_block_delta(self, event: Any) -> None:
        index = _get(event, "index", 0)
        delta = _get(event, "delta")
        block = self._blocks.setdefault(index, {})
        dtype = _get(delta, "type") if delta is not None else None
        if dtype == "text_delta":
            block.setdefault("type", "text")
            block["text"] = (block.get("text") or "") + (_get(delta, "text") or "")
        elif dtype == "input_json_delta":
            block.setdefault("type", "tool_use")
            self._json_buffers[index] = self._json_buffers.get(index, "") + (_get(delta, "partial_json") or "")
        elif dtype == "thinking_delta":
            block.setdefault("type", "thinking")
            block["thinking"] = (block.get("thinking") or "") + (_get(delta, "thinking") or "")
        elif dtype == "signature_delta":
            block["signature"] = _get(delta, "signature")

    def _on_block_stop(self, event: Any) -> None:
        index = _get(event, "index", 0)
        buf = self._json_buffers.get(index)
        if buf is None:
            return
        block = self._blocks.setdefault(index, {})
        try:
            block["input"] = json.loads(buf)
        except json.JSONDecodeError:
            block["input"] = buf

    def _on_message_delta(self, event: Any) -> None:
        usage = _get(event, "usage")
        if usage is None:
            return
        out_tokens = _get(usage, "output_tokens")
        if out_tokens is not None:
            self._output_tokens = out_tokens

    def finalize(self) -> tuple[Any, Optional[dict[str, Any]]]:
        output = [self._blocks[i] for i in sorted(self._blocks)] if self._blocks else None
        if self._input_tokens is None and self._output_tokens is None:
            usage = None
        else:
            usage = {
                "promptTokens": self._input_tokens,
                "completionTokens": self._output_tokens,
                "totalTokens": (self._input_tokens or 0) + (self._output_tokens or 0),
                "cacheReadTokens": self._cache_read_tokens,
                "cacheCreationTokens": self._cache_creation_tokens,
            }
        return output, usage


def _content(resp: Any) -> Any:
    blocks = getattr(resp, "content", None)
    if blocks is None:
        return str(resp)
    try:
        return [b.model_dump() if hasattr(b, "model_dump") else b for b in blocks]
    except Exception:  # noqa: BLE001
        return str(blocks)


def _usage(resp: Any) -> Optional[dict[str, Any]]:
    usage = getattr(resp, "usage", None)
    if usage is None:
        return None
    in_tokens = getattr(usage, "input_tokens", None)
    out_tokens = getattr(usage, "output_tokens", None)
    return {
        "promptTokens": in_tokens,
        "completionTokens": out_tokens,
        "totalTokens": (in_tokens or 0) + (out_tokens or 0),
        "cacheReadTokens": getattr(usage, "cache_read_input_tokens", None),
        "cacheCreationTokens": getattr(usage, "cache_creation_input_tokens", None),
    }
