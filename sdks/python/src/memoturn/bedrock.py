"""Drop-in wrapper for a boto3 ``bedrock-runtime`` client — records ``converse``/
``converse_stream`` calls as generations. Only the standardized Converse API is
covered; ``invoke_model``/``invoke_model_with_response_stream`` are out of scope
since their request/response body shape varies per underlying model family."""
from __future__ import annotations

from typing import Any, Optional

from ._stream import _ABANDONED, _RecordingStream, _get
from .client import Memoturn, Trace
from .decorator import get_client

#: Model parameters copied onto the generation (allowlist — Bedrock's Converse API has
#: a small, stable inference-parameter set, unlike Gemini's larger/unstable config bag).
_ALLOWLIST = ("maxTokens", "temperature", "topP", "stopSequences")


def _map_usage(usage: Any) -> Optional[dict]:
    if not usage:
        return None
    out = {
        "promptTokens": _get(usage, "inputTokens"),
        "completionTokens": _get(usage, "outputTokens"),
        "totalTokens": _get(usage, "totalTokens"),
    }
    cache_read = _get(usage, "cacheReadInputTokens")
    if cache_read is not None:
        out["cacheReadTokens"] = cache_read
    cache_write = _get(usage, "cacheWriteInputTokens")
    if cache_write is not None:
        out["cacheCreationTokens"] = cache_write
    return out


def _build_input(kwargs: dict) -> tuple[Any, dict]:
    inference_config = kwargs.get("inferenceConfig") or {}
    model_parameters = {k: inference_config[k] for k in _ALLOWLIST if k in inference_config}
    system = kwargs.get("system")
    # Keep the system prompt alongside the messages when present (mirrors Anthropic's
    # own system+messages input shape).
    input_val = {"system": system, "messages": kwargs.get("messages")} if system else kwargs.get("messages")
    return input_val, model_parameters


def wrap_bedrock(client: Any, memoturn: Optional[Memoturn] = None, *, trace: Optional[Trace] = None) -> Any:
    """Patch ``client.converse``/``client.converse_stream`` to trace calls. Returns the
    same client. ``converse_stream`` is patched only if present.

    Streaming calls are recorded too: the ``stream`` key of the response dict is wrapped
    so events are forwarded unchanged to the caller while being accumulated into the same
    output/usage shape as a non-streaming call, and the generation is closed when the
    stream is exhausted, errors, or is abandoned (closed/garbage-collected/idle-timed-out
    before completion).
    """
    mt = memoturn or get_client()
    _patch_converse(client, mt, trace)
    _patch_converse_stream(client, mt, trace)
    return client


def _patch_converse(client: Any, mt: Memoturn, trace: Optional[Trace]) -> None:
    original = client.converse

    def converse(**kwargs: Any) -> Any:
        t = trace or mt.trace(name="bedrock.converse")
        input_val, model_parameters = _build_input(kwargs)
        gen = t.generation(
            name="bedrock.converse",
            model=kwargs.get("modelId"),
            provider="bedrock",
            input=input_val,
            modelParameters=model_parameters,
        )
        try:
            resp = original(**kwargs)
            gen.end(output=_get(_get(resp, "output"), "message"), usage=_map_usage(_get(resp, "usage")))
            return resp
        except Exception as e:  # noqa: BLE001
            gen.end(level="ERROR", statusMessage=str(e))
            raise

    client.converse = converse  # type: ignore[assignment]


class _BedrockAccumulator:
    """Accumulates ``converse_stream`` events (``contentBlockStart``/
    ``contentBlockDelta``/``metadata``) into the same ``(output, usage)`` shape the
    non-streaming path builds. Structurally mirrors ``_AnthropicAccumulator``: blocks are
    tracked by index, text deltas concatenate, and non-text deltas (e.g. ``toolUse``)
    merge generically."""

    def __init__(self) -> None:
        self._blocks: dict[int, dict] = {}
        self._usage: Any = None

    def add(self, event: dict) -> None:
        start = event.get("contentBlockStart")
        if start is not None:
            self._blocks[start["contentBlockIndex"]] = dict(start.get("start") or {})
        delta_evt = event.get("contentBlockDelta")
        if delta_evt is not None:
            i = delta_evt["contentBlockIndex"]
            block = self._blocks.setdefault(i, {})
            delta = delta_evt.get("delta") or {}
            if "text" in delta:
                block["text"] = block.get("text", "") + delta["text"]
            else:
                block.update(delta)
        metadata = event.get("metadata")
        if metadata is not None and metadata.get("usage") is not None:
            self._usage = metadata["usage"]

    def finalize(self) -> tuple[list, Optional[dict]]:
        return [self._blocks[i] for i in sorted(self._blocks)], _map_usage(self._usage)


def _patch_converse_stream(client: Any, mt: Memoturn, trace: Optional[Trace]) -> None:
    original = getattr(client, "converse_stream", None)
    if original is None:
        return

    def converse_stream(**kwargs: Any) -> Any:
        t = trace or mt.trace(name="bedrock.converseStream")
        input_val, model_parameters = _build_input(kwargs)
        gen = t.generation(
            name="bedrock.converseStream",
            model=kwargs.get("modelId"),
            provider="bedrock",
            input=input_val,
            modelParameters=model_parameters,
        )
        try:
            resp = original(**kwargs)
        except Exception as e:  # noqa: BLE001
            gen.end(level="ERROR", statusMessage=str(e))
            raise

        acc = _BedrockAccumulator()

        def on_chunk(event: dict) -> None:
            acc.add(event)

        def on_done(err: Any) -> None:
            output, usage = acc.finalize()
            if err is _ABANDONED:
                gen.end(level="WARNING", statusMessage="stream ended before completion", output=output, usage=usage)
            elif err is not None:
                gen.end(level="ERROR", statusMessage=str(err), output=output, usage=usage)
            else:
                gen.end(output=output, usage=usage)

        resp["stream"] = _RecordingStream(resp["stream"], on_chunk, on_done)
        return resp

    client.converse_stream = converse_stream  # type: ignore[assignment]
