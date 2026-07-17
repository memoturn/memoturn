"""Drop-in Gemini wrapper — records client.models.generate_content and
client.models.generate_content_stream calls as generations."""
from __future__ import annotations

from typing import Any, Optional

from ._stream import _ABANDONED, _RecordingStream, _get
from .client import Memoturn, Trace
from .decorator import get_client


def wrap_gemini(client: Any, memoturn: Optional[Memoturn] = None, *, trace: Optional[Trace] = None) -> Any:
    """Patch client.models.generate_content and .generate_content_stream to trace calls.
    Returns the same client. Unlike OpenAI/Anthropic, Gemini has no stream=True flag —
    streaming is a separate method that always returns an iterator of full
    GenerateContentResponse chunks, so both methods are patched independently."""
    mt = memoturn or get_client()
    _patch_generate_content(client, mt, trace)
    _patch_generate_content_stream(client, mt, trace)
    return client


def _config_items(config: Any) -> dict[str, Any]:
    """Best-effort dict view of config — a plain dict, a pydantic-like model
    (model_dump()), a SimpleNamespace, or None. Never raises."""
    if config is None:
        return {}
    if isinstance(config, dict):
        return dict(config)
    dump = getattr(config, "model_dump", None)
    if callable(dump):
        try:
            return dump(exclude_none=True)
        except Exception:  # noqa: BLE001
            pass
    return dict(getattr(config, "__dict__", {}) or {})


def _split_config_input(contents: Any, config: Any) -> tuple[Any, dict[str, Any]]:
    items = _config_items(config)
    system_instruction = items.pop("system_instruction", None) or items.pop("systemInstruction", None)
    input_val = {"systemInstruction": system_instruction, "contents": contents} if system_instruction is not None else contents
    return input_val, items


def _patch_generate_content(client: Any, mt: Memoturn, trace: Optional[Trace]) -> None:
    models = client.models
    original = models.generate_content

    def generate_content(*args: Any, **kwargs: Any) -> Any:
        t = trace or mt.trace(name="gemini.generateContent")
        input_val, model_parameters = _split_config_input(kwargs.get("contents"), kwargs.get("config"))
        gen = t.generation(name="gemini.generateContent", model=kwargs.get("model"), provider="gemini",
                            input=input_val, modelParameters=model_parameters)
        try:
            resp = original(*args, **kwargs)
            gen.end(output=_output(resp), usage=_map_usage(_get(resp, "usage_metadata")))
            return resp
        except Exception as e:  # noqa: BLE001
            gen.end(level="ERROR", statusMessage=str(e))
            raise

    models.generate_content = generate_content  # type: ignore[assignment]


def _patch_generate_content_stream(client: Any, mt: Memoturn, trace: Optional[Trace]) -> None:
    models = client.models
    original = getattr(models, "generate_content_stream", None)
    if original is None:
        return

    def generate_content_stream(*args: Any, **kwargs: Any) -> Any:
        t = trace or mt.trace(name="gemini.generateContentStream")
        input_val, model_parameters = _split_config_input(kwargs.get("contents"), kwargs.get("config"))
        gen = t.generation(name="gemini.generateContentStream", model=kwargs.get("model"), provider="gemini",
                            input=input_val, modelParameters=model_parameters)
        try:
            raw = original(*args, **kwargs)
        except Exception as e:  # noqa: BLE001
            gen.end(level="ERROR", statusMessage=str(e))
            raise

        acc = _GeminiAccumulator()

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

        return _RecordingStream(raw, on_chunk, on_done)

    models.generate_content_stream = generate_content_stream  # type: ignore[assignment]


class _GeminiAccumulator:
    def __init__(self) -> None:
        self._text: Optional[str] = None
        self._usage: Any = None

    def add(self, chunk: Any) -> None:
        text = _get(chunk, "text")
        if text:
            self._text = (self._text or "") + text
        usage = _get(chunk, "usage_metadata")
        if usage is not None:
            self._usage = usage

    def finalize(self) -> tuple[Any, Optional[dict[str, Any]]]:
        return self._text, _map_usage(self._usage)


def _output(resp: Any) -> Any:
    text = _get(resp, "text")
    if text is not None:
        return text
    candidates = _get(resp, "candidates")
    if candidates is not None:
        try:
            return [c.model_dump() if hasattr(c, "model_dump") else c for c in candidates]
        except Exception:  # noqa: BLE001
            return str(candidates)
    return str(resp)


def _map_usage(usage: Any) -> Optional[dict[str, Any]]:
    if usage is None:
        return None
    prompt_tokens = _get(usage, "prompt_token_count")
    completion_tokens = _get(usage, "candidates_token_count")
    cache_read_tokens = _get(usage, "cached_content_token_count")
    out: dict[str, Any] = {"promptTokens": prompt_tokens, "completionTokens": completion_tokens}
    if prompt_tokens is not None and completion_tokens is not None:
        out["totalTokens"] = prompt_tokens + completion_tokens
    if cache_read_tokens is not None:
        out["cacheReadTokens"] = cache_read_tokens
    return out
