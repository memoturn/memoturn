"""Drop-in OpenAI wrapper — records each chat completion as a memoturn generation."""
from __future__ import annotations

from typing import Any, Optional

from .client import Memoturn, Trace
from .decorator import get_client


def wrap_openai(client: Any, memoturn: Optional[Memoturn] = None, *, trace: Optional[Trace] = None) -> Any:
    """Patch ``client.chat.completions.create`` to trace calls. Returns the same client."""
    mt = memoturn or get_client()
    completions = client.chat.completions
    original = completions.create

    def create(*args: Any, **kwargs: Any) -> Any:
        t = trace or mt.trace(name="openai.chat")
        gen = t.generation(
            name="openai.chat.completions",
            model=kwargs.get("model"),
            provider="openai",
            input=kwargs.get("messages"),
            modelParameters={k: v for k, v in kwargs.items() if k not in ("model", "messages")},
        )
        try:
            resp = original(*args, **kwargs)
            usage = getattr(resp, "usage", None)
            gen.end(
                output=_message(resp),
                usage={
                    "promptTokens": getattr(usage, "prompt_tokens", None),
                    "completionTokens": getattr(usage, "completion_tokens", None),
                    "totalTokens": getattr(usage, "total_tokens", None),
                }
                if usage
                else None,
            )
            return resp
        except Exception as e:  # noqa: BLE001
            gen.end(level="ERROR", statusMessage=str(e))
            raise

    completions.create = create  # type: ignore[assignment]
    return client


def _message(resp: Any) -> Any:
    try:
        return resp.choices[0].message.model_dump()
    except Exception:  # noqa: BLE001
        return str(resp)
