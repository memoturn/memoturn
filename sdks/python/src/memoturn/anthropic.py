"""Drop-in Anthropic wrapper — records ``messages.create`` calls as generations."""
from __future__ import annotations

from typing import Any, Optional

from .client import Memoturn, Trace
from .decorator import get_client

#: Model parameters copied onto the generation (allowlist — everything else is dropped).
_PARAM_KEYS = ("max_tokens", "temperature", "top_p", "top_k", "stop_sequences")


def wrap_anthropic(client: Any, memoturn: Optional[Memoturn] = None, *, trace: Optional[Trace] = None) -> Any:
    """Patch ``client.messages.create`` to trace calls. Returns the same client.

    Streaming calls (``stream=True``) are passed through without recording — the
    response is an iterator whose usage isn't known until it is consumed.
    """
    mt = memoturn or get_client()
    _patch_messages(client, mt, trace)
    return client


def _patch_messages(client: Any, mt: Memoturn, trace: Optional[Trace]) -> None:
    messages = client.messages
    original = messages.create

    def create(*args: Any, **kwargs: Any) -> Any:
        if kwargs.get("stream"):
            return original(*args, **kwargs)
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
        try:
            resp = original(*args, **kwargs)
            gen.end(output=_content(resp), usage=_usage(resp))
            return resp
        except Exception as e:  # noqa: BLE001
            gen.end(level="ERROR", statusMessage=str(e))
            raise

    messages.create = create  # type: ignore[assignment]


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
