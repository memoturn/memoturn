"""Drop-in OpenAI wrapper — records chat completions and Responses API calls as
generations, including streaming (``stream=True``) calls for both endpoints."""
from __future__ import annotations

from typing import Any, Optional

from ._stream import _ABANDONED, _RecordingStream, _get
from .client import Memoturn, Trace
from .decorator import get_client


def wrap_openai(client: Any, memoturn: Optional[Memoturn] = None, *, trace: Optional[Trace] = None) -> Any:
    """Patch ``client.chat.completions.create`` and ``client.responses.create`` to trace
    calls. Returns the same client. ``responses`` is patched only if present (newer SDKs).

    Streaming calls (``stream=True``) are recorded too: the returned stream is wrapped so
    chunks are forwarded unchanged to the caller while being accumulated into the same
    output/usage shape as a non-streaming call, and the generation is closed when the
    stream is exhausted, errors, or is abandoned (closed/garbage-collected/idle-timed-out
    before completion).
    """
    mt = memoturn or get_client()
    _patch_chat(client, mt, trace)
    _patch_responses(client, mt, trace)
    return client


def _patch_chat(client: Any, mt: Memoturn, trace: Optional[Trace]) -> None:
    completions = client.chat.completions
    original = completions.create

    def create(*args: Any, **kwargs: Any) -> Any:
        t = trace or mt.trace(name="openai.chat")
        streaming = bool(kwargs.get("stream"))
        excluded = ("model", "messages", "stream", "stream_options") if streaming else ("model", "messages")
        gen = t.generation(
            name="openai.chat.completions",
            model=kwargs.get("model"),
            provider="openai",
            input=kwargs.get("messages"),
            modelParameters={k: v for k, v in kwargs.items() if k not in excluded},
        )

        if streaming:
            # Ask the API to include usage in the final chunk — never override an
            # explicit caller value.
            kwargs.setdefault("stream_options", {"include_usage": True})
            try:
                raw = original(*args, **kwargs)
            except Exception as e:  # noqa: BLE001
                gen.end(level="ERROR", statusMessage=str(e))
                raise

            acc = _ChatAccumulator()

            def on_chunk(chunk: Any) -> None:
                acc.add(chunk)

            def on_done(err: Any) -> None:
                output, usage = acc.finalize()
                if err is _ABANDONED:
                    gen.end(
                        level="WARNING", statusMessage="stream ended before completion", output=output, usage=usage
                    )
                elif err is not None:
                    gen.end(level="ERROR", statusMessage=str(err), output=output, usage=usage)
                else:
                    gen.end(output=output, usage=usage)

            return _RecordingStream(raw, on_chunk, on_done)

        try:
            resp = original(*args, **kwargs)
            gen.end(output=_message(resp), usage=_map_chat_usage(getattr(resp, "usage", None)))
            return resp
        except Exception as e:  # noqa: BLE001
            gen.end(level="ERROR", statusMessage=str(e))
            raise

    completions.create = create  # type: ignore[assignment]


class _ChatAccumulator:
    """Accumulates ``chat.completions`` streaming chunks (``choices[].delta``) into the
    same ``(output, usage)`` shape the non-streaming path builds."""

    def __init__(self) -> None:
        self._choices: dict[int, dict[str, Any]] = {}
        self._usage: Any = None

    def add(self, chunk: Any) -> None:
        usage = _get(chunk, "usage")
        if usage is not None:
            self._usage = usage
        for choice in _get(chunk, "choices", []) or []:
            index = _get(choice, "index", 0)
            slot = self._choices.setdefault(index, {"role": None, "content": None, "refusal": None, "tool_calls": {}})
            delta = _get(choice, "delta")
            if delta is None:
                continue
            role = _get(delta, "role")
            if role is not None:
                slot["role"] = role
            content = _get(delta, "content")
            if content:
                slot["content"] = (slot["content"] or "") + content
            refusal = _get(delta, "refusal")
            if refusal:
                slot["refusal"] = (slot["refusal"] or "") + refusal
            for tc in _get(delta, "tool_calls", []) or []:
                tc_index = _get(tc, "index", 0)
                tc_slot = slot["tool_calls"].setdefault(
                    tc_index, {"id": None, "type": None, "function": {"name": None, "arguments": ""}}
                )
                tc_id = _get(tc, "id")
                if tc_id is not None:
                    tc_slot["id"] = tc_id
                tc_type = _get(tc, "type")
                if tc_type is not None:
                    tc_slot["type"] = tc_type
                func = _get(tc, "function")
                if func is not None:
                    name = _get(func, "name")
                    if name is not None:
                        tc_slot["function"]["name"] = name
                    args = _get(func, "arguments")
                    if args:
                        tc_slot["function"]["arguments"] += args

    def finalize(self) -> tuple[Any, Optional[dict[str, Any]]]:
        if not self._choices:
            return None, _map_chat_usage(self._usage)
        index = 0 if 0 in self._choices else min(self._choices)
        slot = self._choices[index]
        message: dict[str, Any] = {"role": slot["role"], "content": slot["content"]}
        if slot["refusal"] is not None:
            message["refusal"] = slot["refusal"]
        if slot["tool_calls"]:
            message["tool_calls"] = [slot["tool_calls"][i] for i in sorted(slot["tool_calls"])]
        return message, _map_chat_usage(self._usage)


def _map_chat_usage(usage: Any) -> Optional[dict[str, Any]]:
    if usage is None:
        return None
    return {
        "promptTokens": _get(usage, "prompt_tokens"),
        "completionTokens": _get(usage, "completion_tokens"),
        "totalTokens": _get(usage, "total_tokens"),
    }


def _patch_responses(client: Any, mt: Memoturn, trace: Optional[Trace]) -> None:
    responses = getattr(client, "responses", None)
    if responses is None or not hasattr(responses, "create"):
        return  # older openai SDK without the Responses API
    original = responses.create

    def create(*args: Any, **kwargs: Any) -> Any:
        t = trace or mt.trace(name="openai.responses")
        instructions = kwargs.get("instructions")
        input_val = kwargs.get("input")
        streaming = bool(kwargs.get("stream"))
        excluded = (
            ("model", "input", "instructions", "stream", "stream_options")
            if streaming
            else ("model", "input", "instructions")
        )
        gen = t.generation(
            name="openai.responses",
            model=kwargs.get("model"),
            provider="openai",
            # Keep instructions (system-equivalent) alongside the input when present.
            input={"instructions": instructions, "input": input_val} if instructions is not None else input_val,
            modelParameters={k: v for k, v in kwargs.items() if k not in excluded},
        )

        if streaming:
            try:
                raw = original(*args, **kwargs)
            except Exception as e:  # noqa: BLE001
                gen.end(level="ERROR", statusMessage=str(e))
                raise

            output: Any = None
            usage: Optional[dict[str, Any]] = None
            terminal_seen = False
            failed = False

            def on_chunk(event: Any) -> None:
                nonlocal output, usage, terminal_seen, failed
                etype = _get(event, "type")
                if etype not in ("response.completed", "response.failed", "response.incomplete"):
                    return
                response = _get(event, "response")
                if response is not None:
                    output = _responses_output(response)
                    usage = _map_responses_usage(_get(response, "usage"))
                terminal_seen = True
                if etype == "response.failed":
                    failed = True

            def on_done(err: Any) -> None:
                if err is _ABANDONED:
                    gen.end(
                        level="WARNING", statusMessage="stream ended before completion", output=output, usage=usage
                    )
                elif err is not None:
                    gen.end(level="ERROR", statusMessage=str(err), output=output, usage=usage)
                elif failed:
                    gen.end(level="ERROR", statusMessage="response.failed", output=output, usage=usage)
                elif not terminal_seen:
                    gen.end(
                        level="ERROR",
                        statusMessage="stream ended before a terminal response event",
                        output=output,
                        usage=usage,
                    )
                else:
                    gen.end(output=output, usage=usage)

            return _RecordingStream(raw, on_chunk, on_done)

        try:
            resp = original(*args, **kwargs)
            gen.end(output=_responses_output(resp), usage=_map_responses_usage(getattr(resp, "usage", None)))
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
    text = _get(resp, "output_text")
    if text is not None:
        return text
    out = _get(resp, "output")
    if out is not None:
        try:
            return [o.model_dump() if hasattr(o, "model_dump") else o for o in out]
        except Exception:  # noqa: BLE001
            return str(out)
    return str(resp)


def _map_responses_usage(usage: Any) -> Optional[dict[str, Any]]:
    if usage is None:
        return None
    return {
        "promptTokens": _get(usage, "input_tokens"),
        "completionTokens": _get(usage, "output_tokens"),
        "totalTokens": _get(usage, "total_tokens"),
    }
