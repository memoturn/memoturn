"""Drop-in OpenAI wrapper — records chat completions and Responses API calls as generations."""
from __future__ import annotations

from typing import Any, Optional

from .client import Memoturn, Trace
from .decorator import get_client


def wrap_openai(client: Any, memoturn: Optional[Memoturn] = None, *, trace: Optional[Trace] = None) -> Any:
    """Patch ``client.chat.completions.create`` and ``client.responses.create`` to trace
    calls. Returns the same client. ``responses`` is patched only if present (newer SDKs)."""
    mt = memoturn or get_client()
    _patch_chat(client, mt, trace)
    _patch_responses(client, mt, trace)
    return client


def _patch_chat(client: Any, mt: Memoturn, trace: Optional[Trace]) -> None:
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


def _patch_responses(client: Any, mt: Memoturn, trace: Optional[Trace]) -> None:
    responses = getattr(client, "responses", None)
    if responses is None or not hasattr(responses, "create"):
        return  # older openai SDK without the Responses API
    original = responses.create

    def create(*args: Any, **kwargs: Any) -> Any:
        t = trace or mt.trace(name="openai.responses")
        instructions = kwargs.get("instructions")
        input_val = kwargs.get("input")
        gen = t.generation(
            name="openai.responses",
            model=kwargs.get("model"),
            provider="openai",
            # Keep instructions (system-equivalent) alongside the input when present.
            input={"instructions": instructions, "input": input_val} if instructions is not None else input_val,
            modelParameters={k: v for k, v in kwargs.items() if k not in ("model", "input", "instructions")},
        )
        try:
            resp = original(*args, **kwargs)
            usage = getattr(resp, "usage", None)
            gen.end(
                output=_responses_output(resp),
                usage={
                    "promptTokens": getattr(usage, "input_tokens", None),
                    "completionTokens": getattr(usage, "output_tokens", None),
                    "totalTokens": getattr(usage, "total_tokens", None),
                }
                if usage
                else None,
            )
            return resp
        except Exception as e:  # noqa: BLE001
            gen.end(level="ERROR", statusMessage=str(e))
            raise

    responses.create = create  # type: ignore[assignment]


def _message(resp: Any) -> Any:
    try:
        return resp.choices[0].message.model_dump()
    except Exception:  # noqa: BLE001
        return str(resp)


def _responses_output(resp: Any) -> Any:
    text = getattr(resp, "output_text", None)
    if text is not None:
        return text
    out = getattr(resp, "output", None)
    if out is not None:
        try:
            return [o.model_dump() if hasattr(o, "model_dump") else o for o in out]
        except Exception:  # noqa: BLE001
            return str(out)
    return str(resp)
